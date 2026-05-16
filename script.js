const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const fileNameLabel = document.getElementById("file-name");
const replaceImageButton = document.getElementById("replace-image");
const languageSelect = document.getElementById("language-select");
const formatSelect = document.getElementById("format-select");
const convertButton = document.getElementById("convert-button");
const copyButton = document.getElementById("copy-button");
const downloadButton = document.getElementById("download-button");
const resultText = document.getElementById("result-text");
const statusMessage = document.getElementById("status-message");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");

let selectedFile = null;
let activeWorker = null;
let activeLang = "";

const uiText = {
  en: {
    invalidFile: "Please upload a valid image file.",
    imageReady: "Image ready. Choose OCR settings and start conversion.",
    uploadFirst: "Upload an image before starting OCR.",
    ocrLoadFailed: "OCR library failed to load. Check your internet connection and refresh.",
    preparing: "Preparing OCR engine...",
    enhancing: "Enhancing image for better OCR...",
    secondPass: "Trying a second OCR pass for cleaner text...",
    ocrComplete: "OCR complete. Review, copy, or download the text.",
    ocrFailed: "Something went wrong during OCR. Try another image with clearer text.",
    copySuccess: "Text copied to clipboard.",
    copyFailed: "Copy failed. You can still select the text manually.",
    downloaded: (name) => `Downloaded ${name}.`,
    fileLabel: (name, kb) => `${name} • ${kb} KB`,
    processing: "Processing"
  },
  uk: {
    invalidFile: "Будь ласка, завантажте коректний файл зображення.",
    imageReady: "Зображення готове. Виберіть налаштування OCR і запустіть конвертацію.",
    uploadFirst: "Завантажте зображення перед запуском OCR.",
    ocrLoadFailed: "Не вдалося завантажити OCR-бібліотеку. Перевірте інтернет-з’єднання та оновіть сторінку.",
    preparing: "Підготовка OCR-движка...",
    enhancing: "Покращуємо зображення для кращого OCR...",
    secondPass: "Запускаємо другий прохід OCR для чистішого тексту...",
    ocrComplete: "OCR завершено. Перевірте, скопіюйте або завантажте текст.",
    ocrFailed: "Під час OCR сталася помилка. Спробуйте інше зображення з чіткішим текстом.",
    copySuccess: "Текст скопійовано в буфер обміну.",
    copyFailed: "Не вдалося скопіювати. Ви все ще можете виділити текст вручну.",
    downloaded: (name) => `Завантажено ${name}.`,
    fileLabel: (name, kb) => `${name} • ${kb} КБ`,
    processing: "Обробка"
  }
};

function currentUiLang() {
  return localStorage.getItem("site-lang") || "en";
}

function t(key, ...args) {
  const lang = currentUiLang();
  const dict = uiText[lang] || uiText.en;
  const value = dict[key];
  return typeof value === "function" ? value(...args) : value;
}

function setStatus(message, isSuccess = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("success", isSuccess);
}

function setProgress(value) {
  const safeValue = Math.max(0, Math.min(1, value));
  progressFill.style.width = `${Math.round(safeValue * 100)}%`;
}

function toggleProgress(show) {
  progressBar.classList.toggle("hidden", !show);
  progressBar.setAttribute("aria-hidden", String(!show));
  if (!show) {
    setProgress(0);
  }
}

function updateActionButtons() {
  const hasText = resultText.value.trim().length > 0;
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;
}

function showSelectedFile(file) {
  fileNameLabel.textContent = t("fileLabel", file.name, Math.max(1, Math.round(file.size / 1024)));
  replaceImageButton.classList.remove("hidden");
}

function useFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus(t("invalidFile"));
    return;
  }

  selectedFile = file;
  showSelectedFile(file);
  setStatus(t("imageReady"));
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Unable to load the selected image."));
    };

    image.src = objectUrl;
  });
}

function buildProcessedCanvas(image, { threshold = false } = {}) {
  const maxDimension = Math.max(image.width, image.height);
  const scale = maxDimension < 1800 ? Math.min(3, 2200 / Math.max(1, maxDimension)) : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Canvas preprocessing is not available in this browser.");
  }

  canvas.width = width;
  canvas.height = height;

  context.drawImage(image, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  const histogram = new Array(256).fill(0);
  let min = 255;
  let max = 0;

  for (let index = 0; index < data.length; index += 4) {
    const luminance = Math.round((data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000);
    histogram[luminance] += 1;
    if (luminance < min) min = luminance;
    if (luminance > max) max = luminance;
  }

  const contrastRange = Math.max(1, max - min);
  const thresholdValue = threshold ? getOtsuThreshold(histogram, width * height) : null;

  for (let index = 0; index < data.length; index += 4) {
    const luminance = Math.round((data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000);
    let normalized = ((luminance - min) / contrastRange) * 255;
    normalized = Math.max(0, Math.min(255, normalized));

    if (threshold && thresholdValue !== null) {
      normalized = normalized > thresholdValue ? 255 : 0;
    }

    data[index] = normalized;
    data[index + 1] = normalized;
    data[index + 2] = normalized;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function getOtsuThreshold(histogram, totalPixels) {
  let sum = 0;

  for (let i = 0; i < histogram.length; i += 1) {
    sum += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let threshold = 0;

  for (let i = 0; i < histogram.length; i += 1) {
    weightBackground += histogram[i];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const betweenVariance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (betweenVariance > maxVariance) {
      maxVariance = betweenVariance;
      threshold = i;
    }
  }

  return threshold;
}

async function getWorker(lang) {
  if (activeWorker && activeLang === lang) {
    return activeWorker;
  }

  if (activeWorker) {
    await activeWorker.terminate();
    activeWorker = null;
    activeLang = "";
  }

  const worker = await window.Tesseract.createWorker(lang, 1, {
    logger: ({ status, progress }) => {
      const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Processing";
      setStatus(`${label}... ${Math.round((progress || 0) * 100)}%`);
      setProgress(progress || 0);
    },
  });

  await worker.setParameters({
    tessedit_pageseg_mode: window.Tesseract.PSM.AUTO,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  activeWorker = worker;
  activeLang = lang;
  return worker;
}

function pickBestResult(primary, fallback) {
  const primaryTextLength = primary.text.trim().length;
  const fallbackTextLength = fallback.text.trim().length;

  if (!primaryTextLength) return fallback;
  if (!fallbackTextLength) return primary;

  if ((fallback.confidence || 0) > (primary.confidence || 0) + 8) {
    return fallback;
  }

  if (fallbackTextLength > primaryTextLength * 1.2 && (fallback.confidence || 0) >= (primary.confidence || 0) - 5) {
    return fallback;
  }

  return primary;
}

async function runOcr() {
  if (!selectedFile) {
    setStatus(t("uploadFirst"));
    return;
  }

  if (!window.Tesseract) {
    setStatus(t("ocrLoadFailed"));
    return;
  }

  convertButton.disabled = true;
  copyButton.disabled = true;
  downloadButton.disabled = true;
  toggleProgress(true);
  setStatus(t("preparing"));

  try {
    setStatus(t("enhancing"));
    setProgress(0.08);

    const image = await loadImageFromFile(selectedFile);
    const enhancedCanvas = buildProcessedCanvas(image);
    const worker = await getWorker(languageSelect.value);
    const primaryResult = await worker.recognize(enhancedCanvas);
    let bestResult = {
      text: primaryResult.data.text || "",
      confidence: primaryResult.data.confidence || 0,
    };

    if (bestResult.confidence < 72 || bestResult.text.trim().length < 20) {
      setStatus(t("secondPass"));
      setProgress(0.7);

      const thresholdCanvas = buildProcessedCanvas(image, { threshold: true });
      const retryResult = await worker.recognize(thresholdCanvas);
      const fallback = {
        text: retryResult.data.text || "",
        confidence: retryResult.data.confidence || 0,
      };

      bestResult = pickBestResult(bestResult, fallback);
    }

    resultText.value = bestResult.text.trim();
    setStatus(t("ocrComplete"), true);
    updateActionButtons();
  } catch (error) {
    console.error(error);
    setStatus(t("ocrFailed"));
  } finally {
    convertButton.disabled = false;
    toggleProgress(false);
  }
}

async function copyResult() {
  if (!resultText.value.trim()) {
    return;
  }

  try {
    await navigator.clipboard.writeText(resultText.value);
    setStatus(t("copySuccess"), true);
  } catch (error) {
    console.error(error);
    setStatus(t("copyFailed"));
  }
}

function downloadResult() {
  const text = resultText.value.trim();
  if (!text) {
    return;
  }

  const extension = formatSelect.value;
  const fileStem = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, "") : "ocr-result";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${fileStem}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(t("downloaded", link.download), true);
}

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-active");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-active");
  });
});

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  useFile(file);
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  useFile(file);
});

replaceImageButton.addEventListener("click", () => {
  fileInput.click();
});

convertButton.addEventListener("click", runOcr);
copyButton.addEventListener("click", copyResult);
downloadButton.addEventListener("click", downloadResult);
resultText.addEventListener("input", updateActionButtons);
document.addEventListener("site-language-change", () => {
  if (selectedFile) {
    showSelectedFile(selectedFile);
  } else if (statusMessage.hasAttribute("data-i18n")) {
    const key = statusMessage.getAttribute("data-i18n");
    const dict = window.siteTranslations?.[currentUiLang()] || window.siteTranslations?.en;
    if (dict?.[key]) {
      statusMessage.textContent = dict[key];
    }
  }
});
window.addEventListener("beforeunload", async () => {
  if (activeWorker) {
    activeWorker.terminate();
  }
});
updateActionButtons();

const $ = selector => document.querySelector(selector);

const MAX_PAGES = 5;
const SOURCE_MAX_EDGE = 3000;
const JPEG_QUALITY_ENHANCED = 0.94;
const JPEG_QUALITY_ORIGINAL = 0.92;
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
const WORKER_URL = "./scan-worker.js?v=20261009-2";

const state = {
  cvReady: false,
  worker: null,
  workerReady: false,
  workerSeq: 0,
  workerPending: new Map(),
  pages: [],
  processing: 0,
  editorPageId: null,
  editorSource: null,
  editorCorners: null,
  draggingCorner: null,
  dragPageId: null,
  previewScale: 1,
  replacePageId: null,
  enginePromise: null,
  pdfPromise: null,
  adding: false,
  editorOpening: false,
  cropApplying: false,
  exporting: false
};

const cameraInput = $("#cameraInput");
const galleryInput = $("#galleryInput");
const replaceInput = $("#replaceInput");
const pagesEl = $("#pages");
const engineStatus = $("#engineStatus");
const exportBtn = $("#exportBtn");
const exportStatus = $("#exportStatus");
const cropDialog = $("#cropDialog");
const cropCanvas = $("#cropCanvas");
const redetectBtn = $("#redetectBtn");
const saveCropBtn = $("#saveCropBtn");
const cropMagnifier = $("#cropMagnifier");
const previewDialog = $("#previewDialog");
const previewImage = $("#previewImage");
const previewTitle = $("#previewTitle");
const previewViewport = $("#previewViewport");
const zoomOutBtn = $("#zoomOutBtn");
const zoomInBtn = $("#zoomInBtn");
const zoomResetBtn = $("#zoomResetBtn");
const zoomLabel = $("#zoomLabel");
const reviewStatus = $("#reviewStatus");
const reviewPages = $("#reviewPages");
const reviewFilename = $("#reviewFilename");

const EXPORT_BUTTON_LABEL = "產生並下載 PDF";

function cloneCorners(corners) {
  return corners ? {
    topLeftCorner: {...corners.topLeftCorner},
    topRightCorner: {...corners.topRightCorner},
    bottomLeftCorner: {...corners.bottomLeftCorner},
    bottomRightCorner: {...corners.bottomRightCorner}
  } : null;
}

function cloneWarpGeometry(geometry) {
  if (!geometry || typeof geometry !== "object" || typeof geometry.kind !== "string") return null;
  try {
    return JSON.parse(JSON.stringify(geometry));
  } catch (_) {
    return null;
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function sanitizePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "");
}

function buildFilename({className, seatNo, studentName, essayTitle, practice}) {
  const cls = sanitizePart(className).replace(/\D/g, "");
  const seat = sanitizePart(seatNo).replace(/\D/g, "");
  const name = sanitizePart(studentName);
  const title = sanitizePart(essayTitle);
  const round = sanitizePart(practice);
  if (!cls || !seat || !name || !title || !round) return "";
  return `${cls}-${seat}_${name}_${title}（${round}）.pdf`;
}

function currentFilename() {
  return buildFilename({
    className: $("#className").value,
    seatNo: $("#seatNo").value,
    studentName: $("#studentName").value,
    essayTitle: $("#essayTitle").value,
    practice: $("#practice").value
  });
}

function updateFilename() {
  $("#filenamePreview").textContent = currentFilename() || "請完整填寫資料";
  updateExportState();
  renderFinalReview();
}

function updateExportState() {
  const readyPages = state.pages.length > 0 && state.pages.every(page => page.processedDataUrl && !page.busy);
  exportBtn.disabled = state.exporting || !state.cvReady || state.processing > 0 || !readyPages || !currentFilename();
}

function setEngineStatus(message, kind = "") {
  engineStatus.textContent = message;
  engineStatus.className = `status ${kind}`.trim();
}

function setExportStatus(message, kind = "") {
  exportStatus.textContent = message;
  exportStatus.className = `status ${kind}`.trim();
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(payload.length * 0.75);
}

function waitFor(test, timeoutMs = 30000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        if (test()) return resolve(true);
      } catch (_) {}
      if (Date.now() - started >= timeoutMs) return reject(new Error("載入逾時"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function nextPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function loadScript(src, readyTest, timeoutMs = 45000) {
  if (readyTest()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const absolute = new URL(src, location.href).href;
    let script = [...document.scripts].find(item => item.src === absolute);
    const timer = setTimeout(() => reject(new Error(`載入逾時：${src}`)), timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      reject(new Error(`無法載入：${src}`));
    };

    if (script) {
      script.addEventListener("load", finish, {once: true});
      script.addEventListener("error", fail, {once: true});
      if (readyTest()) finish();
      return;
    }

    script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", finish, {once: true});
    script.addEventListener("error", fail, {once: true});
    document.head.appendChild(script);
  });
}

function startWorker() {
  if (state.worker) return state.worker;

  const worker = new Worker(WORKER_URL);
  state.worker = worker;

  worker.addEventListener("message", event => {
    const message = event.data || {};

    if (message.type === "ready") {
      state.workerReady = true;
      state.cvReady = true;
      setEngineStatus("掃描引擎已就緒", "ok");
      updateExportState();
      return;
    }

    if (message.type === "init-error") {
      console.error("Scanner worker init:", message.error);
      state.workerReady = false;
      state.cvReady = false;
      state.enginePromise = null;
      try { worker.terminate(); } catch (_) {}
      if (state.worker === worker) state.worker = null;
      setEngineStatus("掃描引擎載入失敗，請確認網路後再試一次。", "bad");
      return;
    }

    const pending = state.workerPending.get(message.id);
    if (!pending) return;

    if (message.type === "progress") {
      if (typeof pending.onProgress === "function") pending.onProgress(message.stage);
      return;
    }

    state.workerPending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "掃描處理失敗"));
  });

  worker.addEventListener("error", error => {
    console.error("Scanner worker error:", error);
    state.workerReady = false;
    state.cvReady = false;
    state.enginePromise = null;
    for (const pending of state.workerPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("掃描引擎發生錯誤"));
    }
    state.workerPending.clear();
    try { worker.terminate(); } catch (_) {}
    if (state.worker === worker) state.worker = null;
    setEngineStatus("掃描引擎發生錯誤，請再試一次。", "bad");
  });

  return worker;
}

async function ensureScannerReady() {
  if (state.workerReady && state.worker) return true;
  if (state.enginePromise) return state.enginePromise;

  state.enginePromise = new Promise(resolve => {
    setEngineStatus("掃描引擎正在背景準備，網頁仍可正常操作…");
    let worker;
    let settled = false;
    let timeout;

    const finish = ready => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (worker) {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      }
      if (!ready) state.enginePromise = null;
      resolve(ready);
    };

    const onMessage = event => {
      if (event.data?.type === "ready") finish(true);
      if (event.data?.type === "init-error") finish(false);
    };
    const onError = () => {
      setEngineStatus("掃描引擎發生錯誤，請再試一次。", "bad");
      finish(false);
    };

    try {
      worker = startWorker();
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      timeout = setTimeout(() => {
        if (state.workerReady) return finish(true);
        setEngineStatus("掃描引擎準備時間較久，請再試一次。", "warn");
        finish(false);
      }, 60000);
    } catch (error) {
      console.error(error);
      setEngineStatus("掃描引擎無法啟動，請重新整理後再試。", "bad");
      finish(false);
    }
  });

  return state.enginePromise;
}

function workerRequest(action, payload, transfer = [], timeoutMs = 45000, onProgress = null) {
  const worker = startWorker();
  const id = ++state.workerSeq;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.workerPending.delete(id);
      reject(new Error("掃描處理逾時，請重試這一頁"));
    }, timeoutMs);

    state.workerPending.set(id, {resolve, reject, timer, onProgress});
    worker.postMessage({id, action, payload}, transfer);
  });
}

function canvasWorkerPayload(canvas) {
  const imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return {
    payload: {
      width: canvas.width,
      height: canvas.height,
      buffer: imageData.data.buffer
    },
    transfer: [imageData.data.buffer]
  };
}

function workerImageToCanvas(result) {
  const canvas = document.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const imageData = new ImageData(new Uint8ClampedArray(result.buffer), result.width, result.height);
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return canvas;
}

async function ensurePdfReady() {
  if (window.jspdf?.jsPDF) return true;
  if (state.pdfPromise) return state.pdfPromise;

  state.pdfPromise = loadScript(JSPDF_URL, () => Boolean(window.jspdf?.jsPDF))
    .then(() => waitFor(() => Boolean(window.jspdf?.jsPDF), 10000))
    .then(() => true)
    .catch(error => {
      console.error(error);
      state.pdfPromise = null;
      return false;
    });

  return state.pdfPromise;
}

setEngineStatus("掃描引擎背景準備中，你可以先選擇照片。");
setTimeout(() => { ensureScannerReady(); }, 50);

async function loadFileToCanvas(file, maxEdge = SOURCE_MAX_EDGE) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();

    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    if (!naturalW || !naturalH) throw new Error("無法讀取圖片尺寸");

    const scale = Math.min(1, maxEdge / Math.max(naturalW, naturalH));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalW * scale));
    canvas.height = Math.max(1, Math.round(naturalH * scale));

    const ctx = canvas.getContext("2d", {alpha: false});
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    throw new Error("無法讀取這張照片。若為 HEIC 且瀏覽器不支援，請直接用本頁相機重拍。");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function defaultCorners(width, height) {
  const insetX = Math.round(width * 0.01);
  const insetY = Math.round(height * 0.01);
  return {
    topLeftCorner: {x: insetX, y: insetY},
    topRightCorner: {x: width - insetX, y: insetY},
    bottomLeftCorner: {x: insetX, y: height - insetY},
    bottomRightCorner: {x: width - insetX, y: height - insetY}
  };
}

function polygonArea(corners) {
  const pts = [
    corners.topLeftCorner,
    corners.topRightCorner,
    corners.bottomRightCorner,
    corners.bottomLeftCorner
  ];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function validCorners(corners, width, height) {
  if (!corners) return false;
  const points = Object.values(corners);
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  return polygonArea(corners) >= width * height * 0.12;
}

const PROCESS_STAGE_LABELS = {
  detecting: "尋找白色紙張",
  perspective: "校正紙張",
  enhancing: "強化白底黑字",
  rendering: "建立原稿預覽",
  encoding: "建立預覽"
};

async function processPage(page, {detect = false} = {}) {
  if (!page || page.busy) return;

  page.busy = true;
  page.stage = "讀取照片";
  state.processing++;
  updateExportState();
  renderPages();

  try {
    // Let the disabled state and the current stage paint before decoding or
    // copying a large camera image on the main thread.
    await nextPaint();
    const source = await loadFileToCanvas(page.file);
    page.sourceWidth = source.width;
    page.sourceHeight = source.height;
    page.stage = "準備掃描引擎";
    renderPages();

    const ready = await ensureScannerReady();
    if (!ready) throw new Error("掃描引擎尚未準備完成，請再試一次");

    const currentWarpGeometry = !detect ? cloneWarpGeometry(page.warpGeometry) : null;
    const currentCorners = (!currentWarpGeometry && !detect && page.corners && validCorners(page.corners, source.width, source.height))
      ? cloneCorners(page.corners)
      : null;

    const {payload, transfer} = canvasWorkerPayload(source);
    const result = await workerRequest("process", {
      ...payload,
      corners: currentCorners,
      warpGeometry: currentWarpGeometry,
      suggestedCorners: cloneCorners(page.suggestedCorners),
      detectionConfidence: page.detectionConfidence,
      paperWhiteRatio: page.paperWhiteRatio,
      paperAreaRatio: page.paperAreaRatio,
      mode: page.mode,
      rotation: page.rotation,
      preferLandscape: true
    }, transfer, 75000, stage => {
      page.stage = PROCESS_STAGE_LABELS[stage] || "處理中";
      renderPages();
    });

    page.corners = result.corners || defaultCorners(source.width, source.height);
    page.warpGeometry = cloneWarpGeometry(result.warpGeometry);
    page.suggestedCorners = cloneCorners(result.suggestedCorners);
    page.warpKind = result.warpKind || (currentCorners ? "manual" : "fallback");
    if (detect || !currentCorners) page.autoDetected = Boolean(result.autoDetected);
    page.detectionConfidence = result.detectionConfidence;
    page.paperWhiteRatio = result.paperWhiteRatio;
    page.paperAreaRatio = result.paperAreaRatio;
    page.autoLandscapeRotated = Boolean(result.autoLandscapeRotated);
    page.blurScore = result.blurScore;
    page.stage = "建立預覽";
    renderPages();
    await nextPaint();

    const finalCanvas = workerImageToCanvas(result);
    page.stage = "建立 JPEG";
    renderPages();
    await nextPaint();
    const quality = page.mode === "enhanced" ? JPEG_QUALITY_ENHANCED : JPEG_QUALITY_ORIGINAL;
    page.processedDataUrl = finalCanvas.toDataURL("image/jpeg", quality);
    page.outputWidth = finalCanvas.width;
    page.outputHeight = finalCanvas.height;
    page.outputBytes = dataUrlBytes(page.processedDataUrl);
    page.error = "";
  } catch (error) {
    console.error(error);
    page.error = error.message || "圖片處理失敗";
    page.processedDataUrl = "";
  } finally {
    page.busy = false;
    page.stage = "";
    state.processing--;
    renderPages();
    updateExportState();
  }
}

function setScanInputBusy(busy) {
  [cameraInput, galleryInput].forEach(input => {
    input.disabled = busy;
  });
  document.querySelectorAll(".scan-button").forEach(button => {
    button.classList.toggle("busy", busy);
    button.setAttribute("aria-disabled", busy ? "true" : "false");
  });
}

async function addFiles(fileList) {
  if (state.adding) {
    setEngineStatus("照片正在處理中，請等目前批次完成，不用重複選取。", "warn");
    return;
  }

  const files = [...fileList].filter(file => !file.type || file.type.startsWith("image/"));
  if (!files.length) {
    setEngineStatus("沒有可讀取的圖片。", "warn");
    return;
  }

  const available = Math.max(0, MAX_PAGES - state.pages.length);
  const accepted = files.slice(0, available);

  if (!accepted.length) {
    setEngineStatus(state.pages.length >= MAX_PAGES ? `最多支援 ${MAX_PAGES} 頁。` : "沒有可讀取的圖片。", "warn");
    return;
  }

  state.adding = true;
  setScanInputBusy(true);

  try {
    const pagesToProcess = accepted.map(file => ({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      file,
      mode: "enhanced",
      rotation: 0,
      corners: null,
      warpGeometry: null,
      suggestedCorners: null,
      warpKind: null,
      autoDetected: false,
      detectionConfidence: null,
      paperWhiteRatio: null,
      paperAreaRatio: null,
      autoLandscapeRotated: false,
      blurScore: null,
      processedDataUrl: "",
      stage: "等待處理",
      busy: false,
      error: ""
    }));

    state.pages.push(...pagesToProcess);
    renderPages();

    if (files.length > accepted.length) {
      setEngineStatus(`已加入 ${accepted.length} 頁；最多支援 ${MAX_PAGES} 頁，超出的照片未加入。`, "warn");
    } else {
      setEngineStatus(`已收到 ${accepted.length} 張照片，準備掃描…`);
    }

    // Warm the PDF engine while the first scan is running, so the export
    // button does not become the first place where a large CDN script loads.
    void ensurePdfReady();

    if (!state.cvReady) {
      const ready = await ensureScannerReady();
      if (!ready) {
        pagesToProcess.forEach(page => { page.error = "掃描引擎載入失敗，請重新整理後再試。"; });
        renderPages();
        setEngineStatus("掃描引擎載入失敗，請確認網路後重新整理。", "bad");
        return;
      }
    }

    for (let i = 0; i < pagesToProcess.length; i++) {
      const page = pagesToProcess[i];
      setEngineStatus(`正在掃描第 ${i + 1} / ${pagesToProcess.length} 頁…`);
      await processPage(page, {detect: true});
    }

    const failed = state.pages.filter(page => page.error).length;
    setEngineStatus(
      failed ? `有 ${failed} 頁處理失敗，請重新處理或重新拍攝。` : `完成，目前共 ${state.pages.length} 頁。`,
      failed ? "warn" : "ok"
    );
  } finally {
    state.adding = false;
    setScanInputBusy(false);
    renderPages();
    updateExportState();
  }
}

function pageWarnings(page) {
  const warnings = [];
  if (!page.autoDetected) {
    warnings.push("請確認四角");
  } else if (Number.isFinite(page.detectionConfidence) && page.detectionConfidence < 0.72) {
    warnings.push("建議確認四角");
  }
  if (Number.isFinite(page.blurScore) && page.blurScore < 35) warnings.push("照片可能偏糊");
  if (page.outputHeight > page.outputWidth * 1.12) warnings.push("頁面看起來是直向");
  return warnings;
}

function renderPages() {
  pagesEl.innerHTML = "";
  if (!state.pages.length) {
    pagesEl.innerHTML = '<div class="empty">尚未加入作文頁面</div>';
    renderFinalReview();
    return;
  }

  state.pages.forEach((page, index) => {
    const card = document.createElement("article");
    card.className = "page-card";
    card.dataset.pageId = page.id;
    const pageControlsBusy = page.busy || state.processing > 0 || state.adding || state.exporting || state.editorOpening;
    card.draggable = !pageControlsBusy;
    card.setAttribute("aria-busy", page.busy ? "true" : "false");
    const warnings = pageWarnings(page);
    const cornerWarning = warnings.find(warning => warning.includes("四角"));
    const needsCornerReview = Boolean(cornerWarning);
    const orientationText = page.outputWidth > page.outputHeight ? "橫向" : "請檢查方向";
    if (needsCornerReview) card.classList.add("needs-corners");

    card.innerHTML = `
      <div class="thumb ${page.processedDataUrl ? "clickable" : ""}" data-act="${page.processedDataUrl ? "preview" : ""}">
        ${page.processedDataUrl ? `<img src="${page.processedDataUrl}" alt="第 ${index + 1} 頁預覽">` : page.busy ? (page.stage || "處理中…") : page.error ? "處理失敗" : "準備中"}
      </div>
      <div>
        <div class="page-title">
          <h3>第 ${index + 1} 頁</h3>
          <span class="badge ${warnings.length ? "warn" : ""}">${page.busy ? (page.stage || "處理中") : page.error ? "處理失敗" : warnings.length ? warnings.join(" · ") : "掃描完成"}</span>
        </div>
        <div class="page-meta">
          ${page.error ? page.error : page.busy ? `正在${page.stage || "處理"}…` : page.outputWidth ? `已完成 · ${orientationText}` : "準備中"}
        </div>
        <div class="mode-toggle" aria-label="頁面顯示模式">
          <button type="button" data-mode="enhanced" class="${page.mode === "enhanced" ? "active" : ""}" ${pageControlsBusy ? "disabled" : ""}>作文清晰</button>
          <button type="button" data-mode="original" class="${page.mode === "original" ? "active" : ""}" ${pageControlsBusy ? "disabled" : ""}>原稿</button>
        </div>
        <div class="page-actions">
          ${page.processedDataUrl ? `<button type="button" data-act="preview" ${pageControlsBusy ? "disabled" : ""}>放大檢查</button>` : ""}
          <button type="button" data-act="crop" class="${needsCornerReview ? "corner-action" : ""}" ${pageControlsBusy ? "disabled" : ""}>調整四角</button>
          <button type="button" data-act="rotate" ${pageControlsBusy ? "disabled" : ""}>右轉 90°</button>
          ${page.error ? `<button type="button" data-act="retry" ${pageControlsBusy ? "disabled" : ""}>重新處理</button><button type="button" data-act="retake" ${pageControlsBusy ? "disabled" : ""}>重新拍攝</button>` : ""}
          <button type="button" data-act="up" ${index === 0 || pageControlsBusy ? "disabled" : ""}>上移</button>
          <button type="button" data-act="down" ${index === state.pages.length - 1 || pageControlsBusy ? "disabled" : ""}>下移</button>
          <button type="button" data-act="delete" class="danger" ${pageControlsBusy ? "disabled" : ""}>刪除</button>
        </div>
      </div>
    `;

    card.querySelectorAll('[data-act="preview"]').forEach(element => {
      element.onclick = () => openPreview(page, index);
    });
    const cropButton = card.querySelector('[data-act="crop"]');
    cropButton.onclick = async () => {
      if (state.editorOpening || pageControlsBusy || page.busy || state.processing > 0 || state.adding || state.exporting) return;
      const originalText = cropButton.textContent;
      cropButton.disabled = true;
      cropButton.setAttribute("aria-busy", "true");
      cropButton.textContent = "開啟中…";
      try {
        await openCropEditor(page.id);
      } finally {
        if (cropButton.isConnected) {
          cropButton.disabled = false;
          cropButton.removeAttribute("aria-busy");
          cropButton.textContent = originalText;
        }
      }
    };
    card.querySelector('[data-act="rotate"]').onclick = async () => {
      if (pageControlsBusy || page.busy || state.processing > 0 || state.exporting || state.editorOpening) return;
      page.rotation = (page.rotation + 90) % 360;
      await processPage(page);
    };
    card.querySelector('[data-act="up"]').onclick = () => movePage(index, -1);
    card.querySelector('[data-act="down"]').onclick = () => movePage(index, 1);
    card.querySelector('[data-act="delete"]').onclick = () => deletePage(index);
    const retakeButton = card.querySelector('[data-act="retake"]');
    if (retakeButton) {
      retakeButton.onclick = () => {
        if (pageControlsBusy || page.busy || state.processing > 0 || state.exporting || state.editorOpening) return;
        state.replacePageId = page.id;
        replaceInput.click();
      };
    }

    const retryButton = card.querySelector('[data-act="retry"]');
    if (retryButton) {
      retryButton.onclick = async () => {
        if (pageControlsBusy || page.busy || state.processing > 0 || state.exporting || state.editorOpening) return;
        page.error = "";
        await processPage(page, {detect: !page.autoDetected});
      };
    }

    card.querySelectorAll("[data-mode]").forEach(button => {
      button.onclick = async () => {
        const mode = button.dataset.mode;
        if (page.mode === mode || page.busy || state.processing > 0 || state.adding || state.exporting || state.editorOpening) return;
        page.mode = mode;
        await processPage(page);
      };
    });

    card.addEventListener("dragstart", event => {
      if (page.busy) {
        event.preventDefault();
        return;
      }
      state.dragPageId = page.id;
      card.classList.add("dragging");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      state.dragPageId = null;
      card.classList.remove("dragging");
      document.querySelectorAll(".page-card.drag-over").forEach(item => item.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", event => {
      if (!state.dragPageId || state.dragPageId === page.id) return;
      event.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", event => {
      event.preventDefault();
      card.classList.remove("drag-over");
      const from = state.pages.findIndex(item => item.id === state.dragPageId);
      const to = state.pages.findIndex(item => item.id === page.id);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = state.pages.splice(from, 1);
      state.pages.splice(to, 0, moved);
      state.dragPageId = null;
      renderPages();
    });

    pagesEl.appendChild(card);
  });
  renderFinalReview();
}

function renderFinalReview() {
  if (!reviewStatus || !reviewPages || !reviewFilename) return;

  reviewPages.innerHTML = "";
  const filename = currentFilename();
  reviewFilename.textContent = filename ? `檔名：${filename}` : "檔名：請先完整填寫交件資料";

  if (!state.pages.length) {
    reviewStatus.textContent = "尚未加入作文頁面";
    reviewStatus.className = "review-status";
    return;
  }

  const unfinished = state.pages.filter(page => page.busy || page.error || !page.processedDataUrl);
  const warningPages = state.pages
    .map((page, index) => ({page, index, warnings: pageWarnings(page)}))
    .filter(item => item.warnings.length);

  if (unfinished.length) {
    reviewStatus.textContent = `尚有 ${unfinished.length} 頁未完成，請先重新處理或重新拍攝。`;
    reviewStatus.className = "review-status warn";
  } else if (warningPages.length) {
    reviewStatus.textContent = `共 ${state.pages.length} 頁；有 ${warningPages.length} 頁需要你再確認。`;
    reviewStatus.className = "review-status warn";
  } else {
    reviewStatus.textContent = `✓ 共 ${state.pages.length} 頁，影像與頁面順序已可輸出。`;
    reviewStatus.className = "review-status ok";
  }

  state.pages.forEach((page, index) => {
    const warnings = pageWarnings(page);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `review-page ${warnings.length || page.error ? "warn" : ""}`;
    button.disabled = page.busy || state.processing > 0 || state.adding || state.exporting || state.editorOpening || !page.processedDataUrl;
    button.innerHTML = page.processedDataUrl
      ? `<img src="${page.processedDataUrl}" alt="第 ${index + 1} 頁最後檢查"><span>第 ${index + 1} 頁${warnings.length ? " · 請確認" : " · ✓"}</span>`
      : `<span>第 ${index + 1} 頁 · 尚未完成</span>`;
    if (page.processedDataUrl) button.onclick = () => openPreview(page, index);
    reviewPages.appendChild(button);
  });
}

function applyPreviewScale() {
  state.previewScale = Math.max(1, Math.min(4, state.previewScale));
  previewImage.style.width = `${state.previewScale * 100}%`;
  zoomLabel.textContent = `${Math.round(state.previewScale * 100)}%`;
}

function openPreview(page, index) {
  if (!page?.processedDataUrl || page.busy || state.processing > 0 || state.adding || state.exporting || state.editorOpening) return;
  state.previewScale = 1;
  previewTitle.textContent = `第 ${index + 1} 頁｜放大檢查字跡`;
  previewImage.src = page.processedDataUrl;
  applyPreviewScale();
  previewViewport.scrollTo({top: 0, left: 0});
  previewDialog.showModal();
}

zoomInBtn.addEventListener("click", () => {
  state.previewScale += 0.5;
  applyPreviewScale();
});
zoomOutBtn.addEventListener("click", () => {
  state.previewScale -= 0.5;
  applyPreviewScale();
});
zoomResetBtn.addEventListener("click", () => {
  state.previewScale = 1;
  applyPreviewScale();
});
previewDialog.addEventListener("close", () => {
  previewImage.removeAttribute("src");
  state.previewScale = 1;
});

function movePage(index, delta) {
  if (state.processing > 0 || state.adding || state.exporting || state.editorOpening) return;
  const next = index + delta;
  if (next < 0 || next >= state.pages.length) return;
  [state.pages[index], state.pages[next]] = [state.pages[next], state.pages[index]];
  renderPages();
}

function deletePage(index) {
  if (state.processing > 0 || state.adding || state.exporting || state.editorOpening) return;
  state.pages.splice(index, 1);
  renderPages();
  updateExportState();
}

function drawCropEditor() {
  if (!state.editorSource || !state.editorCorners) return;
  cropCanvas.width = state.editorSource.width;
  cropCanvas.height = state.editorSource.height;
  const ctx = cropCanvas.getContext("2d");
  ctx.drawImage(state.editorSource, 0, 0);

  const c = state.editorCorners;
  const points = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];

  ctx.save();
  ctx.lineWidth = Math.max(4, cropCanvas.width / 350);
  ctx.strokeStyle = "#22c55e";
  ctx.fillStyle = "rgba(34,197,94,.12)";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = "rgba(239,68,68,.72)";
  ctx.lineWidth = Math.max(6, cropCanvas.width / 180);
  ctx.beginPath();
  ctx.moveTo(cropCanvas.width / 2, 0);
  ctx.lineTo(cropCanvas.width / 2, cropCanvas.height);
  ctx.moveTo(0, cropCanvas.height / 2);
  ctx.lineTo(cropCanvas.width, cropCanvas.height / 2);
  ctx.stroke();
  ctx.restore();

  const radius = Math.max(18, cropCanvas.width / 55);
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = Math.max(5, cropCanvas.width / 300);
    ctx.strokeStyle = "#16a34a";
    ctx.stroke();
  }
  ctx.restore();
}

function pointerPosition(event) {
  const rect = cropCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (cropCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (cropCanvas.height / rect.height)
  };
}

function cornerForQuadrant(position) {
  const left = position.x < cropCanvas.width / 2;
  const top = position.y < cropCanvas.height / 2;
  if (top) return left ? "topLeftCorner" : "topRightCorner";
  return left ? "bottomLeftCorner" : "bottomRightCorner";
}

function drawCropMagnifier(position) {
  if (!state.editorSource || !position || !cropMagnifier) return;
  const rect = cropCanvas.getBoundingClientRect();
  const displayScale = cropCanvas.width / Math.max(1, rect.width);
  const zoom = 3;
  const sampleSize = (cropMagnifier.width * displayScale) / zoom;
  const pointX = Math.max(0, Math.min(state.editorSource.width, position.x));
  const pointY = Math.max(0, Math.min(state.editorSource.height, position.y));
  const sx = Math.max(0, Math.min(state.editorSource.width - sampleSize, pointX - sampleSize / 2));
  const sy = Math.max(0, Math.min(state.editorSource.height - sampleSize, pointY - sampleSize / 2));
  const crossX = (pointX - sx) * (cropMagnifier.width / sampleSize);
  const crossY = (pointY - sy) * (cropMagnifier.height / sampleSize);
  const ctx = cropMagnifier.getContext("2d");
  ctx.clearRect(0, 0, cropMagnifier.width, cropMagnifier.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    state.editorSource,
    sx, sy, sampleSize, sampleSize,
    0, 0, cropMagnifier.width, cropMagnifier.height
  );
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(crossX, 0);
  ctx.lineTo(crossX, cropMagnifier.height);
  ctx.moveTo(0, crossY);
  ctx.lineTo(cropMagnifier.width, crossY);
  ctx.stroke();
  cropMagnifier.classList.add("visible");
}

function hideCropMagnifier() {
  if (cropMagnifier) cropMagnifier.classList.remove("visible");
}

cropCanvas.addEventListener("pointerdown", event => {
  if (!state.editorCorners) return;
  const position = pointerPosition(event);
  const key = cornerForQuadrant(position);
  if (!key) return;
  state.draggingCorner = key;
  drawCropMagnifier(state.editorCorners[key]);
  cropCanvas.setPointerCapture(event.pointerId);
  event.preventDefault();
});

cropCanvas.addEventListener("pointermove", event => {
  if (!state.draggingCorner || !state.editorCorners) return;
  const pos = pointerPosition(event);
  const nextPosition = {
    x: Math.max(0, Math.min(cropCanvas.width, pos.x)),
    y: Math.max(0, Math.min(cropCanvas.height, pos.y))
  };
  state.editorCorners[state.draggingCorner] = nextPosition;
  drawCropEditor();
  drawCropMagnifier(nextPosition);
  event.preventDefault();
});

function endCornerDrag(event) {
  if (!state.draggingCorner) return;
  state.draggingCorner = null;
  hideCropMagnifier();
  if (event.pointerId !== undefined && cropCanvas.hasPointerCapture(event.pointerId)) {
    cropCanvas.releasePointerCapture(event.pointerId);
  }
}
cropCanvas.addEventListener("pointerup", endCornerDrag);
cropCanvas.addEventListener("pointercancel", endCornerDrag);

async function openCropEditor(pageId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page || page.busy || state.editorOpening || cropDialog.open) return;

  state.editorOpening = true;
  renderPages();
  setEngineStatus("正在開啟四角調整，請稍候…");
  await nextPaint();

  try {
    const source = await loadFileToCanvas(page.file);
    state.editorPageId = pageId;
    state.editorSource = source;
    const suggestedCorners = page.suggestedCorners && validCorners(page.suggestedCorners, source.width, source.height)
      ? page.suggestedCorners
      : null;
    state.editorCorners = cloneCorners(suggestedCorners || page.corners) || defaultCorners(source.width, source.height);
    drawCropEditor();
    cropDialog.showModal();
    setEngineStatus("請在圖片四個區域內拖曳，調整對應紙張角點。", "ok");
  } catch (error) {
    setEngineStatus(error.message, "bad");
  } finally {
    state.editorOpening = false;
    renderPages();
  }
}

redetectBtn.addEventListener("click", async () => {
  if (!state.editorSource) return;

  redetectBtn.disabled = true;
  const originalText = redetectBtn.textContent;
  redetectBtn.textContent = "偵測中…";
  setEngineStatus("正在重新自動偵測，請稍候…");
  await nextPaint();

  try {
    const ready = await ensureScannerReady();
    if (!ready) throw new Error("掃描引擎尚未準備完成");

    const {payload, transfer} = canvasWorkerPayload(state.editorSource);
    const result = await workerRequest("detect", payload, transfer, 45000);

    const confidence = Number.isFinite(result.confidence) ? Math.round(result.confidence * 100) : 0;
    if (result.corners) {
      state.editorCorners = result.corners;
      drawCropEditor();
      setEngineStatus(`已重新偵測白色紙張四角（信心 ${confidence}%）。`, "ok");
    } else {
      setEngineStatus(`找不到可靠白色紙張邊界（目前信心 ${confidence}%），已保留目前四角，請直接拖動圓點。`, "warn");
    }
  } catch (error) {
    console.error(error);
    setEngineStatus(error.message || "重新偵測失敗", "bad");
  } finally {
    redetectBtn.disabled = false;
    redetectBtn.textContent = originalText;
  }
});

saveCropBtn.addEventListener("click", async () => {
  const page = state.pages.find(item => item.id === state.editorPageId);
  if (state.cropApplying || !page || !state.editorCorners || !state.editorSource) return;
  if (!validCorners(state.editorCorners, state.editorSource.width, state.editorSource.height)) {
    setEngineStatus("四角範圍太小或交錯，請重新調整。", "warn");
    return;
  }

  state.cropApplying = true;
  const originalText = saveCropBtn.textContent;
  saveCropBtn.disabled = true;
  saveCropBtn.setAttribute("aria-busy", "true");
  saveCropBtn.textContent = "套用中…";
  page.corners = cloneCorners(state.editorCorners);
  page.warpGeometry = null;
  page.suggestedCorners = null;
  page.warpKind = "manual";
  page.autoDetected = true;
  page.detectionConfidence = 1;
  setEngineStatus("正在套用裁切並重新處理，請稍候…");
  cropDialog.close();
  try {
    await processPage(page);
  } finally {
    state.cropApplying = false;
    saveCropBtn.disabled = false;
    saveCropBtn.removeAttribute("aria-busy");
    saveCropBtn.textContent = originalText;
  }
});

cropDialog.addEventListener("close", () => {
  state.editorPageId = null;
  state.editorSource = null;
  state.editorCorners = null;
  state.draggingCorner = null;
  hideCropMagnifier();
});

async function exportPdf() {
  const filename = currentFilename();
  const readyPages = state.pages.length > 0 && state.pages.every(page => page.processedDataUrl && !page.busy);
  if (state.exporting || !filename || !readyPages || state.processing > 0) return;

  state.exporting = true;
  exportBtn.disabled = true;
  exportBtn.setAttribute("aria-busy", "true");
  exportBtn.textContent = "正在準備 PDF…";
  setExportStatus("正在準備 PDF，請不要重複按…");
  renderPages();
  await nextPaint();

  try {
    const pdfReady = await ensurePdfReady();
    if (!pdfReady) {
      setExportStatus("PDF 引擎載入失敗，請確認網路後再試。", "bad");
      return;
    }

    exportBtn.textContent = "正在產生 PDF…";
    setExportStatus(`正在產生 PDF（共 ${state.pages.length} 頁）…`);
    await nextPaint();

    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation: "l", unit: "mm", format: "a4", compress: true});
    const pageW = 297;
    const pageH = 210;
    const margin = 6;

    for (let index = 0; index < state.pages.length; index++) {
      const page = state.pages[index];
      if (index > 0) pdf.addPage("a4", "l");
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2;
      const scale = Math.min(maxW / page.outputWidth, maxH / page.outputHeight);
      const width = page.outputWidth * scale;
      const height = page.outputHeight * scale;
      setExportStatus(`正在產生 PDF：第 ${index + 1} / ${state.pages.length} 頁…`);
      await nextPaint();
      pdf.addImage(
        page.processedDataUrl,
        "JPEG",
        (pageW - width) / 2,
        (pageH - height) / 2,
        width,
        height,
        undefined,
        "FAST"
      );
    }

    exportBtn.textContent = "正在完成 PDF…";
    setExportStatus("正在完成 PDF…");
    await nextPaint();
    const bytes = pdf.output("arraybuffer").byteLength;
    pdf.save(filename);
    setExportStatus(`已下載：${filename}（約 ${humanBytes(bytes)}）`, "ok");
  } catch (error) {
    console.error(error);
    setExportStatus(`PDF 產生失敗：${error.message || "未知錯誤"}`, "bad");
  } finally {
    state.exporting = false;
    exportBtn.removeAttribute("aria-busy");
    exportBtn.textContent = EXPORT_BUTTON_LABEL;
    renderPages();
    updateExportState();
  }
}

cameraInput.addEventListener("change", async event => {
  await addFiles(event.target.files);
  event.target.value = "";
});
galleryInput.addEventListener("change", async event => {
  await addFiles(event.target.files);
  event.target.value = "";
});
replaceInput.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  const page = state.pages.find(item => item.id === state.replacePageId);
  state.replacePageId = null;
  event.target.value = "";
  if (!file || !page || page.busy || state.processing > 0 || state.adding) return;

  page.file = file;
  page.rotation = 0;
  page.corners = null;
  page.warpGeometry = null;
  page.suggestedCorners = null;
  page.warpKind = null;
  page.autoDetected = false;
  page.detectionConfidence = null;
  page.paperWhiteRatio = null;
  page.paperAreaRatio = null;
  page.autoLandscapeRotated = false;
  page.blurScore = null;
  page.processedDataUrl = "";
  page.outputWidth = null;
  page.outputHeight = null;
  page.outputBytes = null;
  page.error = "";
  setEngineStatus("已收到替換照片，正在重新掃描…");
  await processPage(page, {detect: true});
});

$("#className").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "");
  updateFilename();
});
$("#seatNo").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "");
  updateFilename();
});
$("#studentName").addEventListener("input", updateFilename);
$("#essayTitle").addEventListener("input", updateFilename);
$("#practice").addEventListener("change", updateFilename);
exportBtn.addEventListener("click", exportPdf);

function runSelfChecks() {
  console.assert(
    buildFilename({className: "116", seatNo: "1", studentName: "林小弦", essayTitle: "通關密語", practice: "一"}) ===
      "116-1_林小弦_通關密語（一）.pdf",
    "filename contract failed"
  );
  const corners = defaultCorners(1000, 1400);
  console.assert(validCorners(corners, 1000, 1400), "default corner contract failed");
}
runSelfChecks();

window.addEventListener("error", event => {
  console.error(event.error || event.message);
  setEngineStatus("掃描程式發生錯誤，請重新整理後再試。", "bad");
});
window.addEventListener("unhandledrejection", event => {
  console.error(event.reason);
  setEngineStatus("掃描處理失敗，請重新整理後再試。", "bad");
});


async function canvasToFile(canvas, name = "selftest.png") {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error("無法建立測試圖片")), "image/png");
  });
  return new File([blob], name, {type: "image/png"});
}

async function runBrowserSelfTest() {
  if (new URLSearchParams(location.search).get("selftest") !== "1") return;

  const marker = document.createElement("pre");
  marker.id = "selfTestResult";
  marker.style.cssText = "white-space:pre-wrap;padding:12px;background:#fff;border:1px solid #ddd";
  marker.textContent = "SELFTEST RUNNING";
  document.body.appendChild(marker);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#4b5563";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(120, 80);
    ctx.lineTo(790, 130);
    ctx.lineTo(750, 1110);
    ctx.lineTo(80, 1050);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    for (let y = 250; y < 1000; y += 100) {
      ctx.beginPath();
      ctx.moveTo(160, y);
      ctx.lineTo(700, y + 35);
      ctx.stroke();
    }

    ctx.fillStyle = "#111827";
    ctx.font = "34px sans-serif";
    ctx.fillText("作文掃描測試", 190, 210);
    ctx.font = "25px sans-serif";
    ctx.fillText("這是一張故意歪斜的作文頁。", 180, 320);
    ctx.fillText("應該可以被偵測、拉正與增強。", 170, 420);

    const file = await canvasToFile(canvas);
    await addFiles([file]);

    if (state.pages.length !== 1) throw new Error("頁面沒有成功加入");
    const page = state.pages[0];
    if (!page.processedDataUrl || page.processedDataUrl.length < 1000) throw new Error("掃描結果未產生");
    if (!validCorners(page.corners, page.sourceWidth, page.sourceHeight)) throw new Error("紙張四角無效");
    if (page.outputWidth <= page.outputHeight) throw new Error("作文預設應為橫向");
    const initialWarpGeometry = JSON.stringify(page.warpGeometry);

    page.rotation = 90;
    await processPage(page);
    if (!page.processedDataUrl) throw new Error("旋轉後處理失敗");
    if (JSON.stringify(page.warpGeometry) !== initialWarpGeometry) throw new Error("旋轉不應遺失自動校正幾何");

    page.rotation = 0;
    page.mode = "original";
    await processPage(page);
    if (!page.processedDataUrl) throw new Error("原稿模式處理失敗");
    if (JSON.stringify(page.warpGeometry) !== initialWarpGeometry) throw new Error("原稿模式不應遺失自動校正幾何");

    $("#className").value = "116";
    $("#seatNo").value = "1";
    $("#studentName").value = "林小弦";
    $("#essayTitle").value = "通關密語";
    $("#practice").value = "一";
    updateFilename();

    const expected = "116-1_林小弦_通關密語（一）.pdf";
    if (currentFilename() !== expected) throw new Error("檔名規則失敗");

    const pdfReady = await ensurePdfReady();
    if (!pdfReady) throw new Error("PDF 引擎載入失敗");

    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation: "l", unit: "mm", format: "a4", compress: true});
    pdf.addImage(page.processedDataUrl, "JPEG", 8, 8, 281, 194, undefined, "FAST");
    const pdfBytes = pdf.output("arraybuffer").byteLength;
    if (pdfBytes < 1000) throw new Error("PDF 產出異常");

    marker.textContent = [
      "SELFTEST PASS",
      `pages=${state.pages.length}`,
      `autoDetected=${page.autoDetected}`,
      `detectionConfidence=${Number.isFinite(page.detectionConfidence) ? page.detectionConfidence.toFixed(2) : "n/a"}`,
      `output=${page.outputWidth}x${page.outputHeight}`,
      `pdfBytes=${pdfBytes}`,
      `filename=${currentFilename()}`
    ].join("\n");
    document.documentElement.dataset.selftest = "pass";
  } catch (error) {
    console.error(error);
    marker.textContent = `SELFTEST FAIL\n${error?.stack || error}`;
    document.documentElement.dataset.selftest = "fail";
  }
}

runBrowserSelfTest();

const $ = selector => document.querySelector(selector);

const MAX_PAGES = 12;
const SOURCE_MAX_EDGE = 2200;
const JPEG_QUALITY_ENHANCED = 0.80;
const JPEG_QUALITY_ORIGINAL = 0.84;
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
const WORKER_URL = "./scan-worker.js?v=20260929-2";

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
  enginePromise: null,
  pdfPromise: null
};

const cameraInput = $("#cameraInput");
const galleryInput = $("#galleryInput");
const pagesEl = $("#pages");
const engineStatus = $("#engineStatus");
const exportBtn = $("#exportBtn");
const exportStatus = $("#exportStatus");
const cropDialog = $("#cropDialog");
const cropCanvas = $("#cropCanvas");
const redetectBtn = $("#redetectBtn");
const saveCropBtn = $("#saveCropBtn");

function cloneCorners(corners) {
  return corners ? {
    topLeftCorner: {...corners.topLeftCorner},
    topRightCorner: {...corners.topRightCorner},
    bottomLeftCorner: {...corners.bottomLeftCorner},
    bottomRightCorner: {...corners.bottomRightCorner}
  } : null;
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
}

function updateExportState() {
  const readyPages = state.pages.length > 0 && state.pages.every(page => page.processedDataUrl && !page.busy);
  exportBtn.disabled = !state.cvReady || state.processing > 0 || !readyPages || !currentFilename();
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
    const worker = startWorker();

    const timeout = setTimeout(() => {
      if (state.workerReady) return;
      state.enginePromise = null;
      setEngineStatus("掃描引擎準備時間較久，請再試一次。", "warn");
      resolve(false);
    }, 60000);

    const onMessage = event => {
      if (event.data?.type === "ready") {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        resolve(true);
      }
      if (event.data?.type === "init-error") {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        state.enginePromise = null;
        resolve(false);
      }
    };
    worker.addEventListener("message", onMessage);
  });

  return state.enginePromise;
}

function workerRequest(action, payload, transfer = [], timeoutMs = 45000) {
  const worker = startWorker();
  const id = ++state.workerSeq;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.workerPending.delete(id);
      reject(new Error("掃描處理逾時，請重試這一頁"));
    }, timeoutMs);

    state.workerPending.set(id, {resolve, reject, timer});
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

setEngineStatus("掃描引擎背景準備中，你可以先選擇照片。", "ok");
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
  const insetX = Math.round(width * 0.035);
  const insetY = Math.round(height * 0.035);
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

async function processPage(page, {detect = false} = {}) {
  page.busy = true;
  state.processing++;
  updateExportState();
  renderPages();

  try {
    const source = await loadFileToCanvas(page.file);
    page.sourceWidth = source.width;
    page.sourceHeight = source.height;

    const ready = await ensureScannerReady();
    if (!ready) throw new Error("掃描引擎尚未準備完成，請再試一次");

    const currentCorners = (!detect && page.corners && validCorners(page.corners, source.width, source.height))
      ? cloneCorners(page.corners)
      : null;

    const {payload, transfer} = canvasWorkerPayload(source);
    const result = await workerRequest("process", {
      ...payload,
      corners: currentCorners,
      mode: page.mode,
      rotation: page.rotation
    }, transfer, 60000);

    page.corners = result.corners || defaultCorners(source.width, source.height);
    page.autoDetected = currentCorners ? true : Boolean(result.autoDetected);
    page.blurScore = result.blurScore;

    const finalCanvas = workerImageToCanvas(result);
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
    state.processing--;
    renderPages();
    updateExportState();
  }
}

async function addFiles(fileList) {
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

  const pagesToProcess = accepted.map(file => ({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    file,
    mode: "enhanced",
    rotation: 0,
    corners: null,
    autoDetected: false,
    blurScore: null,
    processedDataUrl: "",
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
    failed ? `已加入頁面，但有 ${failed} 頁處理失敗，請刪除後重拍或重新加入。` : `完成，目前共 ${state.pages.length} 頁。`,
    failed ? "warn" : "ok"
  );
}

function pageWarnings(page) {
  const warnings = [];
  if (!page.autoDetected) warnings.push("請確認四角");
  if (Number.isFinite(page.blurScore) && page.blurScore < 35) warnings.push("照片可能偏糊");
  if (page.outputWidth > page.outputHeight * 1.12) warnings.push("頁面看起來是橫向");
  return warnings;
}

function renderPages() {
  pagesEl.innerHTML = "";
  if (!state.pages.length) {
    pagesEl.innerHTML = '<div class="empty">尚未加入作文頁面</div>';
    return;
  }

  state.pages.forEach((page, index) => {
    const card = document.createElement("article");
    card.className = "page-card";
    const warnings = pageWarnings(page);
    const sizeText = page.outputBytes ? ` · 約 ${humanBytes(page.outputBytes)}` : "";

    card.innerHTML = `
      <div class="thumb">
        ${page.processedDataUrl ? `<img src="${page.processedDataUrl}" alt="第 ${index + 1} 頁預覽">` : "處理中…"}
      </div>
      <div>
        <div class="page-title">
          <h3>第 ${index + 1} 頁</h3>
          <span class="badge ${warnings.length ? "warn" : ""}">${page.busy ? "處理中" : page.error ? "處理失敗" : warnings.length ? warnings.join(" · ") : "掃描完成"}</span>
        </div>
        <div class="page-meta">
          ${page.error ? page.error : page.outputWidth ? `${page.outputWidth} × ${page.outputHeight}px${sizeText}` : "準備中"}
        </div>
        <div class="mode-toggle" aria-label="頁面顯示模式">
          <button type="button" data-mode="enhanced" class="${page.mode === "enhanced" ? "active" : ""}">作文清晰</button>
          <button type="button" data-mode="original" class="${page.mode === "original" ? "active" : ""}">原稿</button>
        </div>
        <div class="page-actions">
          <button type="button" data-act="crop">調整四角</button>
          <button type="button" data-act="rotate">右轉 90°</button>
          <button type="button" data-act="up" ${index === 0 ? "disabled" : ""}>上移</button>
          <button type="button" data-act="down" ${index === state.pages.length - 1 ? "disabled" : ""}>下移</button>
          <button type="button" data-act="delete" class="danger">刪除</button>
        </div>
      </div>
    `;

    card.querySelector('[data-act="crop"]').onclick = () => openCropEditor(page.id);
    card.querySelector('[data-act="rotate"]').onclick = async () => {
      page.rotation = (page.rotation + 90) % 360;
      await processPage(page);
    };
    card.querySelector('[data-act="up"]').onclick = () => movePage(index, -1);
    card.querySelector('[data-act="down"]').onclick = () => movePage(index, 1);
    card.querySelector('[data-act="delete"]').onclick = () => deletePage(index);

    card.querySelectorAll("[data-mode]").forEach(button => {
      button.onclick = async () => {
        const mode = button.dataset.mode;
        if (page.mode === mode || page.busy) return;
        page.mode = mode;
        await processPage(page);
      };
    });

    pagesEl.appendChild(card);
  });
}

function movePage(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= state.pages.length) return;
  [state.pages[index], state.pages[next]] = [state.pages[next], state.pages[index]];
  renderPages();
}

function deletePage(index) {
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

  const radius = Math.max(12, cropCanvas.width / 80);
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

function nearestCorner(position) {
  const entries = Object.entries(state.editorCorners || {});
  if (!entries.length) return null;
  const rect = cropCanvas.getBoundingClientRect();
  const threshold = 34 * (cropCanvas.width / rect.width);
  let best = null;
  let bestDistance = Infinity;
  for (const [key, point] of entries) {
    const d = distance(position, point);
    if (d < bestDistance) {
      bestDistance = d;
      best = key;
    }
  }
  return bestDistance <= threshold ? best : null;
}

cropCanvas.addEventListener("pointerdown", event => {
  if (!state.editorCorners) return;
  const key = nearestCorner(pointerPosition(event));
  if (!key) return;
  state.draggingCorner = key;
  cropCanvas.setPointerCapture(event.pointerId);
  event.preventDefault();
});

cropCanvas.addEventListener("pointermove", event => {
  if (!state.draggingCorner || !state.editorCorners) return;
  const pos = pointerPosition(event);
  state.editorCorners[state.draggingCorner] = {
    x: Math.max(0, Math.min(cropCanvas.width, pos.x)),
    y: Math.max(0, Math.min(cropCanvas.height, pos.y))
  };
  drawCropEditor();
  event.preventDefault();
});

function endCornerDrag(event) {
  if (!state.draggingCorner) return;
  state.draggingCorner = null;
  if (event.pointerId !== undefined && cropCanvas.hasPointerCapture(event.pointerId)) {
    cropCanvas.releasePointerCapture(event.pointerId);
  }
}
cropCanvas.addEventListener("pointerup", endCornerDrag);
cropCanvas.addEventListener("pointercancel", endCornerDrag);

async function openCropEditor(pageId) {
  const page = state.pages.find(item => item.id === pageId);
  if (!page || page.busy) return;

  try {
    const source = await loadFileToCanvas(page.file);
    state.editorPageId = pageId;
    state.editorSource = source;
    state.editorCorners = cloneCorners(page.corners) || defaultCorners(source.width, source.height);
    drawCropEditor();
    cropDialog.showModal();
  } catch (error) {
    setEngineStatus(error.message, "bad");
  }
}

redetectBtn.addEventListener("click", async () => {
  if (!state.editorSource) return;

  redetectBtn.disabled = true;
  const originalText = redetectBtn.textContent;
  redetectBtn.textContent = "偵測中…";

  try {
    const ready = await ensureScannerReady();
    if (!ready) throw new Error("掃描引擎尚未準備完成");

    const {payload, transfer} = canvasWorkerPayload(state.editorSource);
    const result = await workerRequest("detect", payload, transfer, 45000);

    if (result.corners) {
      state.editorCorners = result.corners;
      drawCropEditor();
      setEngineStatus("已重新偵測紙張四角。", "ok");
    } else {
      setEngineStatus("仍然找不到可靠紙張邊界，請直接拖動四個圓點。", "warn");
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
  if (!page || !state.editorCorners) return;
  if (!validCorners(state.editorCorners, state.editorSource.width, state.editorSource.height)) {
    setEngineStatus("四角範圍太小或交錯，請重新調整。", "warn");
    return;
  }

  page.corners = cloneCorners(state.editorCorners);
  page.autoDetected = true;
  cropDialog.close();
  await processPage(page);
});

cropDialog.addEventListener("close", () => {
  state.editorPageId = null;
  state.editorSource = null;
  state.editorCorners = null;
  state.draggingCorner = null;
});

async function exportPdf() {
  const filename = currentFilename();
  if (!filename || !state.pages.length) return;

  exportBtn.disabled = true;
  setExportStatus("正在準備 PDF…");

  const pdfReady = await ensurePdfReady();
  if (!pdfReady) {
    setExportStatus("PDF 引擎載入失敗，請確認網路後再試。", "bad");
    updateExportState();
    return;
  }

  setExportStatus("正在產生 PDF…");

  try {
    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation: "p", unit: "mm", format: "a4", compress: true});
    const pageW = 210;
    const pageH = 297;
    const margin = 6;

    state.pages.forEach((page, index) => {
      if (index > 0) pdf.addPage("a4", "p");
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2;
      const scale = Math.min(maxW / page.outputWidth, maxH / page.outputHeight);
      const width = page.outputWidth * scale;
      const height = page.outputHeight * scale;
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
    });

    const bytes = pdf.output("arraybuffer").byteLength;
    pdf.save(filename);
    setExportStatus(`已下載：${filename}（約 ${humanBytes(bytes)}）`, "ok");
  } catch (error) {
    console.error(error);
    setExportStatus(`PDF 產生失敗：${error.message || "未知錯誤"}`, "bad");
  } finally {
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
    buildFilename({className: "116", seatNo: "1", studentName: "張沛芸", essayTitle: "通關密語", practice: "一"}) ===
      "116-1_張沛芸_通關密語（一）.pdf",
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

    page.rotation = 90;
    await processPage(page);
    if (!page.processedDataUrl) throw new Error("旋轉後處理失敗");

    page.rotation = 0;
    page.mode = "original";
    await processPage(page);
    if (!page.processedDataUrl) throw new Error("原稿模式處理失敗");

    $("#className").value = "116";
    $("#seatNo").value = "1";
    $("#studentName").value = "張沛芸";
    $("#essayTitle").value = "通關密語";
    $("#practice").value = "一";
    updateFilename();

    const expected = "116-1_張沛芸_通關密語（一）.pdf";
    if (currentFilename() !== expected) throw new Error("檔名規則失敗");

    const pdfReady = await ensurePdfReady();
    if (!pdfReady) throw new Error("PDF 引擎載入失敗");

    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation: "p", unit: "mm", format: "a4", compress: true});
    pdf.addImage(page.processedDataUrl, "JPEG", 8, 8, 194, 274, undefined, "FAST");
    const pdfBytes = pdf.output("arraybuffer").byteLength;
    if (pdfBytes < 1000) throw new Error("PDF 產出異常");

    marker.textContent = [
      "SELFTEST PASS",
      `pages=${state.pages.length}`,
      `autoDetected=${page.autoDetected}`,
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

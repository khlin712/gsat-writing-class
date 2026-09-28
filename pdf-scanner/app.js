const $ = selector => document.querySelector(selector);

const MAX_PAGES = 12;
const SOURCE_MAX_EDGE = 2200;
const ANALYSIS_MAX_EDGE = 1000;
const JPEG_QUALITY_ENHANCED = 0.80;
const JPEG_QUALITY_ORIGINAL = 0.84;

const state = {
  cvReady: false,
  scanner: null,
  pages: [],
  processing: 0,
  editorPageId: null,
  editorSource: null,
  editorCorners: null,
  draggingCorner: null
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

async function ensureScannerReady() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (window.cv && typeof window.cv.then === "function") {
      try { window.cv = await window.cv; } catch (_) {}
    }
    if (window.cv?.Mat && window.jscanify) {
      state.scanner = new window.jscanify();
      state.cvReady = true;
      setEngineStatus("掃描引擎已就緒", "ok");
      updateExportState();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  setEngineStatus("掃描引擎載入失敗，請確認網路後重新整理頁面。", "bad");
}

window.addEventListener("opencv-ready", ensureScannerReady, {once: true});
window.addEventListener("load", ensureScannerReady, {once: true});

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

function scaledCanvas(source, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d", {alpha: false}).drawImage(source, 0, 0, canvas.width, canvas.height);
  return {canvas, scale};
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

function blurScore(canvas) {
  const cv = window.cv;
  const {canvas: analysis} = scaledCanvas(canvas, ANALYSIS_MAX_EDGE);
  const src = cv.imread(analysis);
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    const sigma = stddev.data64F?.[0] || 0;
    return sigma * sigma;
  } finally {
    src.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete();
  }
}

function detectCorners(source) {
  const cv = window.cv;
  const {canvas: analysis, scale} = scaledCanvas(source, ANALYSIS_MAX_EDGE);
  const mat = cv.imread(analysis);
  let contour = null;
  try {
    contour = state.scanner.findPaperContour(mat);
    if (!contour) return null;
    const detected = state.scanner.getCornerPoints(contour);
    if (!detected || Object.values(detected).some(point => !point)) return null;

    const corners = {};
    for (const [key, point] of Object.entries(detected)) {
      corners[key] = {x: point.x / scale, y: point.y / scale};
    }
    return validCorners(corners, source.width, source.height) ? corners : null;
  } finally {
    if (contour?.delete) contour.delete();
    mat.delete();
  }
}

function outputDimensions(corners) {
  const w = Math.max(
    distance(corners.topLeftCorner, corners.topRightCorner),
    distance(corners.bottomLeftCorner, corners.bottomRightCorner)
  );
  const h = Math.max(
    distance(corners.topLeftCorner, corners.bottomLeftCorner),
    distance(corners.topRightCorner, corners.bottomRightCorner)
  );
  const safeW = Math.max(400, w);
  const safeH = Math.max(400, h);
  const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(safeW, safeH));
  return {
    width: Math.max(400, Math.round(safeW * scale)),
    height: Math.max(400, Math.round(safeH * scale))
  };
}

function rotateCanvas(source, degrees) {
  const turns = ((degrees % 360) + 360) % 360;
  if (!turns) return source;

  const swap = turns === 90 || turns === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? source.height : source.width;
  canvas.height = swap ? source.width : source.height;
  const ctx = canvas.getContext("2d", {alpha: false});
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(turns * Math.PI / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function enhanceEssay(source) {
  const cv = window.cv;
  const src = cv.imread(source);
  const gray = new cv.Mat();
  const background = new cv.Mat();
  const normalized = new cv.Mat();
  const soft = new cv.Mat();
  const sharp = new cv.Mat();
  const canvas = document.createElement("canvas");

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, background, new cv.Size(31, 31), 0, 0, cv.BORDER_DEFAULT);
    cv.divide(gray, background, normalized, 255);
    cv.GaussianBlur(normalized, soft, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.addWeighted(normalized, 1.28, soft, -0.28, 0, sharp);
    cv.imshow(canvas, sharp);
    return canvas;
  } finally {
    src.delete(); gray.delete(); background.delete(); normalized.delete(); soft.delete(); sharp.delete();
  }
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

    if (detect || !page.corners) {
      page.blurScore = blurScore(source);
      const autoCorners = detectCorners(source);
      page.autoDetected = Boolean(autoCorners);
      page.corners = autoCorners || defaultCorners(source.width, source.height);
    }

    if (!validCorners(page.corners, source.width, source.height)) {
      page.corners = defaultCorners(source.width, source.height);
      page.autoDetected = false;
    }

    const size = outputDimensions(page.corners);
    let extracted = state.scanner.extractPaper(source, size.width, size.height, page.corners);
    if (!extracted) throw new Error("無法完成紙張透視校正");

    extracted = rotateCanvas(extracted, page.rotation);
    const finalCanvas = page.mode === "enhanced" ? enhanceEssay(extracted) : extracted;
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
  if (!state.cvReady) {
    setEngineStatus("掃描引擎仍在載入，請稍候。", "warn");
    return;
  }

  const files = [...fileList].filter(file => file.type.startsWith("image/"));
  const available = Math.max(0, MAX_PAGES - state.pages.length);
  const accepted = files.slice(0, available);

  if (!accepted.length) {
    setEngineStatus(state.pages.length >= MAX_PAGES ? `最多支援 ${MAX_PAGES} 頁。` : "沒有可讀取的圖片。", "warn");
    return;
  }

  if (files.length > accepted.length) {
    setEngineStatus(`最多支援 ${MAX_PAGES} 頁，超出的照片未加入。`, "warn");
  } else {
    setEngineStatus(`正在處理 ${accepted.length} 頁…`);
  }

  for (const file of accepted) {
    const page = {
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
    };
    state.pages.push(page);
    renderPages();
    await processPage(page, {detect: true});
  }

  const failed = state.pages.filter(page => page.error).length;
  setEngineStatus(
    failed ? `已加入頁面，但有 ${failed} 頁需要重新處理。` : `完成，目前共 ${state.pages.length} 頁。`,
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

redetectBtn.addEventListener("click", () => {
  if (!state.editorSource) return;
  const detected = detectCorners(state.editorSource);
  if (detected) {
    state.editorCorners = detected;
    drawCropEditor();
  } else {
    setEngineStatus("仍然找不到可靠紙張邊界，請直接拖動四個圓點。", "warn");
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
  if (!window.jspdf?.jsPDF) {
    setExportStatus("PDF 引擎尚未載入，請確認網路後重試。", "bad");
    return;
  }

  exportBtn.disabled = true;
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

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

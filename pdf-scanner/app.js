<path>/Users/kaihsien/Desktop/essay-scanner/app.js</path>
<type>file</type>
<content>
1: const $ = selector => document.querySelector(selector);
2: 
3: const MAX_PAGES = 12;
4: const SOURCE_MAX_EDGE = 2200;
5: const ANALYSIS_MAX_EDGE = 1000;
6: const JPEG_QUALITY_ENHANCED = 0.80;
7: const JPEG_QUALITY_ORIGINAL = 0.84;
8: 
9: const state = {
10:   cvReady: false,
11:   scanner: null,
12:   pages: [],
13:   processing: 0,
14:   editorPageId: null,
15:   editorSource: null,
16:   editorCorners: null,
17:   draggingCorner: null
18: };
19: 
20: const cameraInput = $("#cameraInput");
21: const galleryInput = $("#galleryInput");
22: const pagesEl = $("#pages");
23: const engineStatus = $("#engineStatus");
24: const exportBtn = $("#exportBtn");
25: const exportStatus = $("#exportStatus");
26: const cropDialog = $("#cropDialog");
27: const cropCanvas = $("#cropCanvas");
28: const redetectBtn = $("#redetectBtn");
29: const saveCropBtn = $("#saveCropBtn");
30: 
31: function cloneCorners(corners) {
32:   return corners ? {
33:     topLeftCorner: {...corners.topLeftCorner},
34:     topRightCorner: {...corners.topRightCorner},
35:     bottomLeftCorner: {...corners.bottomLeftCorner},
36:     bottomRightCorner: {...corners.bottomRightCorner}
37:   } : null;
38: }
39: 
40: function distance(a, b) {
41:   return Math.hypot(a.x - b.x, a.y - b.y);
42: }
43: 
44: function sanitizePart(value) {
45:   return String(value || "")
46:     .trim()
47:     .replace(/[\\/:*?"<>|]/g, "")
48:     .replace(/\s+/g, "");
49: }
50: 
51: function buildFilename({className, seatNo, studentName, essayTitle, practice}) {
52:   const cls = sanitizePart(className).replace(/\D/g, "");
53:   const seat = sanitizePart(seatNo).replace(/\D/g, "");
54:   const name = sanitizePart(studentName);
55:   const title = sanitizePart(essayTitle);
56:   const round = sanitizePart(practice);
57:   if (!cls || !seat || !name || !title || !round) return "";
58:   return `${cls}-${seat}_${name}_${title}（${round}）.pdf`;
59: }
60: 
61: function currentFilename() {
62:   return buildFilename({
63:     className: $("#className").value,
64:     seatNo: $("#seatNo").value,
65:     studentName: $("#studentName").value,
66:     essayTitle: $("#essayTitle").value,
67:     practice: $("#practice").value
68:   });
69: }
70: 
71: function updateFilename() {
72:   $("#filenamePreview").textContent = currentFilename() || "請完整填寫資料";
73:   updateExportState();
74: }
75: 
76: function updateExportState() {
77:   const readyPages = state.pages.length > 0 && state.pages.every(page => page.processedDataUrl && !page.busy);
78:   exportBtn.disabled = !state.cvReady || state.processing > 0 || !readyPages || !currentFilename();
79: }
80: 
81: function setEngineStatus(message, kind = "") {
82:   engineStatus.textContent = message;
83:   engineStatus.className = `status ${kind}`.trim();
84: }
85: 
86: function setExportStatus(message, kind = "") {
87:   exportStatus.textContent = message;
88:   exportStatus.className = `status ${kind}`.trim();
89: }
90: 
91: function humanBytes(bytes) {
92:   if (!Number.isFinite(bytes)) return "";
93:   if (bytes < 1024) return `${bytes} B`;
94:   if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
95:   return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
96: }
97: 
98: function dataUrlBytes(dataUrl) {
99:   const comma = dataUrl.indexOf(",");
100:   const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
101:   return Math.floor(payload.length * 0.75);
102: }
103: 
104: async function ensureScannerReady() {
105:   const started = Date.now();
106:   while (Date.now() - started < 20000) {
107:     if (window.cv && typeof window.cv.then === "function") {
108:       try { window.cv = await window.cv; } catch (_) {}
109:     }
110:     if (window.cv?.Mat && window.jscanify) {
111:       state.scanner = new window.jscanify();
112:       state.cvReady = true;
113:       setEngineStatus("掃描引擎已就緒", "ok");
114:       updateExportState();
115:       return;
116:     }
117:     await new Promise(resolve => setTimeout(resolve, 250));
118:   }
119:   setEngineStatus("掃描引擎載入失敗，請確認網路後重新整理頁面。", "bad");
120: }
121: 
122: window.addEventListener("opencv-ready", ensureScannerReady, {once: true});
123: window.addEventListener("load", ensureScannerReady, {once: true});
124: 
125: async function loadFileToCanvas(file, maxEdge = SOURCE_MAX_EDGE) {
126:   const url = URL.createObjectURL(file);
127:   try {
128:     const image = new Image();
129:     image.decoding = "async";
130:     image.src = url;
131:     await image.decode();
132: 
133:     const naturalW = image.naturalWidth;
134:     const naturalH = image.naturalHeight;
135:     if (!naturalW || !naturalH) throw new Error("無法讀取圖片尺寸");
136: 
137:     const scale = Math.min(1, maxEdge / Math.max(naturalW, naturalH));
138:     const canvas = document.createElement("canvas");
139:     canvas.width = Math.max(1, Math.round(naturalW * scale));
140:     canvas.height = Math.max(1, Math.round(naturalH * scale));
141: 
142:     const ctx = canvas.getContext("2d", {alpha: false});
143:     ctx.fillStyle = "#fff";
144:     ctx.fillRect(0, 0, canvas.width, canvas.height);
145:     ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
146:     return canvas;
147:   } catch (error) {
148:     throw new Error("無法讀取這張照片。若為 HEIC 且瀏覽器不支援，請直接用本頁相機重拍。");
149:   } finally {
150:     URL.revokeObjectURL(url);
151:   }
152: }
153: 
154: function scaledCanvas(source, maxEdge) {
155:   const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
156:   const canvas = document.createElement("canvas");
157:   canvas.width = Math.max(1, Math.round(source.width * scale));
158:   canvas.height = Math.max(1, Math.round(source.height * scale));
159:   canvas.getContext("2d", {alpha: false}).drawImage(source, 0, 0, canvas.width, canvas.height);
160:   return {canvas, scale};
161: }
162: 
163: function defaultCorners(width, height) {
164:   const insetX = Math.round(width * 0.035);
165:   const insetY = Math.round(height * 0.035);
166:   return {
167:     topLeftCorner: {x: insetX, y: insetY},
168:     topRightCorner: {x: width - insetX, y: insetY},
169:     bottomLeftCorner: {x: insetX, y: height - insetY},
170:     bottomRightCorner: {x: width - insetX, y: height - insetY}
171:   };
172: }
173: 
174: function polygonArea(corners) {
175:   const pts = [
176:     corners.topLeftCorner,
177:     corners.topRightCorner,
178:     corners.bottomRightCorner,
179:     corners.bottomLeftCorner
180:   ];
181:   let sum = 0;
182:   for (let i = 0; i < pts.length; i++) {
183:     const a = pts[i];
184:     const b = pts[(i + 1) % pts.length];
185:     sum += a.x * b.y - b.x * a.y;
186:   }
187:   return Math.abs(sum) / 2;
188: }
189: 
190: function validCorners(corners, width, height) {
191:   if (!corners) return false;
192:   const points = Object.values(corners);
193:   if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
194:   return polygonArea(corners) >= width * height * 0.12;
195: }
196: 
197: function blurScore(canvas) {
198:   const cv = window.cv;
199:   const {canvas: analysis} = scaledCanvas(canvas, ANALYSIS_MAX_EDGE);
200:   const src = cv.imread(analysis);
201:   const gray = new cv.Mat();
202:   const lap = new cv.Mat();
203:   const mean = new cv.Mat();
204:   const stddev = new cv.Mat();
205:   try {
206:     cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
207:     cv.Laplacian(gray, lap, cv.CV_64F);
208:     cv.meanStdDev(lap, mean, stddev);
209:     const sigma = stddev.data64F?.[0] || 0;
210:     return sigma * sigma;
211:   } finally {
212:     src.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete();
213:   }
214: }
215: 
216: function detectCorners(source) {
217:   const cv = window.cv;
218:   const {canvas: analysis, scale} = scaledCanvas(source, ANALYSIS_MAX_EDGE);
219:   const mat = cv.imread(analysis);
220:   let contour = null;
221:   try {
222:     contour = state.scanner.findPaperContour(mat);
223:     if (!contour) return null;
224:     const detected = state.scanner.getCornerPoints(contour);
225:     if (!detected || Object.values(detected).some(point => !point)) return null;
226: 
227:     const corners = {};
228:     for (const [key, point] of Object.entries(detected)) {
229:       corners[key] = {x: point.x / scale, y: point.y / scale};
230:     }
231:     return validCorners(corners, source.width, source.height) ? corners : null;
232:   } finally {
233:     if (contour?.delete) contour.delete();
234:     mat.delete();
235:   }
236: }
237: 
238: function outputDimensions(corners) {
239:   const w = Math.max(
240:     distance(corners.topLeftCorner, corners.topRightCorner),
241:     distance(corners.bottomLeftCorner, corners.bottomRightCorner)
242:   );
243:   const h = Math.max(
244:     distance(corners.topLeftCorner, corners.bottomLeftCorner),
245:     distance(corners.topRightCorner, corners.bottomRightCorner)
246:   );
247:   const safeW = Math.max(400, w);
248:   const safeH = Math.max(400, h);
249:   const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(safeW, safeH));
250:   return {
251:     width: Math.max(400, Math.round(safeW * scale)),
252:     height: Math.max(400, Math.round(safeH * scale))
253:   };
254: }
255: 
256: function rotateCanvas(source, degrees) {
257:   const turns = ((degrees % 360) + 360) % 360;
258:   if (!turns) return source;
259: 
260:   const swap = turns === 90 || turns === 270;
261:   const canvas = document.createElement("canvas");
262:   canvas.width = swap ? source.height : source.width;
263:   canvas.height = swap ? source.width : source.height;
264:   const ctx = canvas.getContext("2d", {alpha: false});
265:   ctx.fillStyle = "#fff";
266:   ctx.fillRect(0, 0, canvas.width, canvas.height);
267:   ctx.translate(canvas.width / 2, canvas.height / 2);
268:   ctx.rotate(turns * Math.PI / 180);
269:   ctx.drawImage(source, -source.width / 2, -source.height / 2);
270:   return canvas;
271: }
272: 
273: function enhanceEssay(source) {
274:   const cv = window.cv;
275:   const src = cv.imread(source);
276:   const gray = new cv.Mat();
277:   const background = new cv.Mat();
278:   const normalized = new cv.Mat();
279:   const soft = new cv.Mat();
280:   const sharp = new cv.Mat();
281:   const canvas = document.createElement("canvas");
282: 
283:   try {
284:     cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
285:     cv.GaussianBlur(gray, background, new cv.Size(31, 31), 0, 0, cv.BORDER_DEFAULT);
286:     cv.divide(gray, background, normalized, 255);
287:     cv.GaussianBlur(normalized, soft, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
288:     cv.addWeighted(normalized, 1.28, soft, -0.28, 0, sharp);
289:     cv.imshow(canvas, sharp);
290:     return canvas;
291:   } finally {
292:     src.delete(); gray.delete(); background.delete(); normalized.delete(); soft.delete(); sharp.delete();
293:   }
294: }
295: 
296: async function processPage(page, {detect = false} = {}) {
297:   page.busy = true;
298:   state.processing++;
299:   updateExportState();
300:   renderPages();
301: 
302:   try {
303:     const source = await loadFileToCanvas(page.file);
304:     page.sourceWidth = source.width;
305:     page.sourceHeight = source.height;
306: 
307:     if (detect || !page.corners) {
308:       page.blurScore = blurScore(source);
309:       const autoCorners = detectCorners(source);
310:       page.autoDetected = Boolean(autoCorners);
311:       page.corners = autoCorners || defaultCorners(source.width, source.height);
312:     }
313: 
314:     if (!validCorners(page.corners, source.width, source.height)) {
315:       page.corners = defaultCorners(source.width, source.height);
316:       page.autoDetected = false;
317:     }
318: 
319:     const size = outputDimensions(page.corners);
320:     let extracted = state.scanner.extractPaper(source, size.width, size.height, page.corners);
321:     if (!extracted) throw new Error("無法完成紙張透視校正");
322: 
323:     extracted = rotateCanvas(extracted, page.rotation);
324:     const finalCanvas = page.mode === "enhanced" ? enhanceEssay(extracted) : extracted;
325:     const quality = page.mode === "enhanced" ? JPEG_QUALITY_ENHANCED : JPEG_QUALITY_ORIGINAL;
326: 
327:     page.processedDataUrl = finalCanvas.toDataURL("image/jpeg", quality);
328:     page.outputWidth = finalCanvas.width;
329:     page.outputHeight = finalCanvas.height;
330:     page.outputBytes = dataUrlBytes(page.processedDataUrl);
331:     page.error = "";
332:   } catch (error) {
333:     console.error(error);
334:     page.error = error.message || "圖片處理失敗";
335:     page.processedDataUrl = "";
336:   } finally {
337:     page.busy = false;
338:     state.processing--;
339:     renderPages();
340:     updateExportState();
341:   }
342: }
343: 
344: async function addFiles(fileList) {
345:   if (!state.cvReady) {
346:     setEngineStatus("掃描引擎仍在載入，請稍候。", "warn");
347:     return;
348:   }
349: 
350:   const files = [...fileList].filter(file => file.type.startsWith("image/"));
351:   const available = Math.max(0, MAX_PAGES - state.pages.length);
352:   const accepted = files.slice(0, available);
353: 
354:   if (!accepted.length) {
355:     setEngineStatus(state.pages.length >= MAX_PAGES ? `最多支援 ${MAX_PAGES} 頁。` : "沒有可讀取的圖片。", "warn");
356:     return;
357:   }
358: 
359:   if (files.length > accepted.length) {
360:     setEngineStatus(`最多支援 ${MAX_PAGES} 頁，超出的照片未加入。`, "warn");
361:   } else {
362:     setEngineStatus(`正在處理 ${accepted.length} 頁…`);
363:   }
364: 
365:   for (const file of accepted) {
366:     const page = {
367:       id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
368:       file,
369:       mode: "enhanced",
370:       rotation: 0,
371:       corners: null,
372:       autoDetected: false,
373:       blurScore: null,
374:       processedDataUrl: "",
375:       busy: false,
376:       error: ""
377:     };
378:     state.pages.push(page);
379:     renderPages();
380:     await processPage(page, {detect: true});
381:   }
382: 
383:   const failed = state.pages.filter(page => page.error).length;
384:   setEngineStatus(
385:     failed ? `已加入頁面，但有 ${failed} 頁需要重新處理。` : `完成，目前共 ${state.pages.length} 頁。`,
386:     failed ? "warn" : "ok"
387:   );
388: }
389: 
390: function pageWarnings(page) {
391:   const warnings = [];
392:   if (!page.autoDetected) warnings.push("請確認四角");
393:   if (Number.isFinite(page.blurScore) && page.blurScore < 35) warnings.push("照片可能偏糊");
394:   if (page.outputWidth > page.outputHeight * 1.12) warnings.push("頁面看起來是橫向");
395:   return warnings;
396: }
397: 
398: function renderPages() {
399:   pagesEl.innerHTML = "";
400:   if (!state.pages.length) {
401:     pagesEl.innerHTML = '<div class="empty">尚未加入作文頁面</div>';
402:     return;
403:   }
404: 
405:   state.pages.forEach((page, index) => {
406:     const card = document.createElement("article");
407:     card.className = "page-card";
408:     const warnings = pageWarnings(page);
409:     const sizeText = page.outputBytes ? ` · 約 ${humanBytes(page.outputBytes)}` : "";
410: 
411:     card.innerHTML = `
412:       <div class="thumb">
413:         ${page.processedDataUrl ? `<img src="${page.processedDataUrl}" alt="第 ${index + 1} 頁預覽">` : "處理中…"}
414:       </div>
415:       <div>
416:         <div class="page-title">
417:           <h3>第 ${index + 1} 頁</h3>
418:           <span class="badge ${warnings.length ? "warn" : ""}">${page.busy ? "處理中" : page.error ? "處理失敗" : warnings.length ? warnings.join(" · ") : "掃描完成"}</span>
419:         </div>
420:         <div class="page-meta">
421:           ${page.error ? page.error : page.outputWidth ? `${page.outputWidth} × ${page.outputHeight}px${sizeText}` : "準備中"}
422:         </div>
423:         <div class="mode-toggle" aria-label="頁面顯示模式">
424:           <button type="button" data-mode="enhanced" class="${page.mode === "enhanced" ? "active" : ""}">作文清晰</button>
425:           <button type="button" data-mode="original" class="${page.mode === "original" ? "active" : ""}">原稿</button>
426:         </div>
427:         <div class="page-actions">
428:           <button type="button" data-act="crop">調整四角</button>
429:           <button type="button" data-act="rotate">右轉 90°</button>
430:           <button type="button" data-act="up" ${index === 0 ? "disabled" : ""}>上移</button>
431:           <button type="button" data-act="down" ${index === state.pages.length - 1 ? "disabled" : ""}>下移</button>
432:           <button type="button" data-act="delete" class="danger">刪除</button>
433:         </div>
434:       </div>
435:     `;
436: 
437:     card.querySelector('[data-act="crop"]').onclick = () => openCropEditor(page.id);
438:     card.querySelector('[data-act="rotate"]').onclick = async () => {
439:       page.rotation = (page.rotation + 90) % 360;
440:       await processPage(page);
441:     };
442:     card.querySelector('[data-act="up"]').onclick = () => movePage(index, -1);
443:     card.querySelector('[data-act="down"]').onclick = () => movePage(index, 1);
444:     card.querySelector('[data-act="delete"]').onclick = () => deletePage(index);
445: 
446:     card.querySelectorAll("[data-mode]").forEach(button => {
447:       button.onclick = async () => {
448:         const mode = button.dataset.mode;
449:         if (page.mode === mode || page.busy) return;
450:         page.mode = mode;
451:         await processPage(page);
452:       };
453:     });
454: 
455:     pagesEl.appendChild(card);
456:   });
457: }
458: 
459: function movePage(index, delta) {
460:   const next = index + delta;
461:   if (next < 0 || next >= state.pages.length) return;
462:   [state.pages[index], state.pages[next]] = [state.pages[next], state.pages[index]];
463:   renderPages();
464: }
465: 
466: function deletePage(index) {
467:   state.pages.splice(index, 1);
468:   renderPages();
469:   updateExportState();
470: }
471: 
472: function drawCropEditor() {
473:   if (!state.editorSource || !state.editorCorners) return;
474:   cropCanvas.width = state.editorSource.width;
475:   cropCanvas.height = state.editorSource.height;
476:   const ctx = cropCanvas.getContext("2d");
477:   ctx.drawImage(state.editorSource, 0, 0);
478: 
479:   const c = state.editorCorners;
480:   const points = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
481: 
482:   ctx.save();
483:   ctx.lineWidth = Math.max(4, cropCanvas.width / 350);
484:   ctx.strokeStyle = "#22c55e";
485:   ctx.fillStyle = "rgba(34,197,94,.12)";
486:   ctx.beginPath();
487:   ctx.moveTo(points[0].x, points[0].y);
488:   for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
489:   ctx.closePath();
490:   ctx.fill();
491:   ctx.stroke();
492: 
493:   const radius = Math.max(12, cropCanvas.width / 80);
494:   for (const point of points) {
495:     ctx.beginPath();
496:     ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
497:     ctx.fillStyle = "#ffffff";
498:     ctx.fill();
499:     ctx.lineWidth = Math.max(5, cropCanvas.width / 300);
500:     ctx.strokeStyle = "#16a34a";
501:     ctx.stroke();
502:   }
503:   ctx.restore();
504: }
505: 
506: function pointerPosition(event) {
507:   const rect = cropCanvas.getBoundingClientRect();
508:   return {
509:     x: (event.clientX - rect.left) * (cropCanvas.width / rect.width),
510:     y: (event.clientY - rect.top) * (cropCanvas.height / rect.height)
511:   };
512: }
513: 
514: function nearestCorner(position) {
515:   const entries = Object.entries(state.editorCorners || {});
516:   if (!entries.length) return null;
517:   const rect = cropCanvas.getBoundingClientRect();
518:   const threshold = 34 * (cropCanvas.width / rect.width);
519:   let best = null;
520:   let bestDistance = Infinity;
521:   for (const [key, point] of entries) {
522:     const d = distance(position, point);
523:     if (d < bestDistance) {
524:       bestDistance = d;
525:       best = key;
526:     }
527:   }
528:   return bestDistance <= threshold ? best : null;
529: }
530: 
531: cropCanvas.addEventListener("pointerdown", event => {
532:   if (!state.editorCorners) return;
533:   const key = nearestCorner(pointerPosition(event));
534:   if (!key) return;
535:   state.draggingCorner = key;
536:   cropCanvas.setPointerCapture(event.pointerId);
537:   event.preventDefault();
538: });
539: 
540: cropCanvas.addEventListener("pointermove", event => {
541:   if (!state.draggingCorner || !state.editorCorners) return;
542:   const pos = pointerPosition(event);
543:   state.editorCorners[state.draggingCorner] = {
544:     x: Math.max(0, Math.min(cropCanvas.width, pos.x)),
545:     y: Math.max(0, Math.min(cropCanvas.height, pos.y))
546:   };
547:   drawCropEditor();
548:   event.preventDefault();
549: });
550: 
551: function endCornerDrag(event) {
552:   if (!state.draggingCorner) return;
553:   state.draggingCorner = null;
554:   if (event.pointerId !== undefined && cropCanvas.hasPointerCapture(event.pointerId)) {
555:     cropCanvas.releasePointerCapture(event.pointerId);
556:   }
557: }
558: cropCanvas.addEventListener("pointerup", endCornerDrag);
559: cropCanvas.addEventListener("pointercancel", endCornerDrag);
560: 
561: async function openCropEditor(pageId) {
562:   const page = state.pages.find(item => item.id === pageId);
563:   if (!page || page.busy) return;
564: 
565:   try {
566:     const source = await loadFileToCanvas(page.file);
567:     state.editorPageId = pageId;
568:     state.editorSource = source;
569:     state.editorCorners = cloneCorners(page.corners) || defaultCorners(source.width, source.height);
570:     drawCropEditor();
571:     cropDialog.showModal();
572:   } catch (error) {
573:     setEngineStatus(error.message, "bad");
574:   }
575: }
576: 
577: redetectBtn.addEventListener("click", () => {
578:   if (!state.editorSource) return;
579:   const detected = detectCorners(state.editorSource);
580:   if (detected) {
581:     state.editorCorners = detected;
582:     drawCropEditor();
583:   } else {
584:     setEngineStatus("仍然找不到可靠紙張邊界，請直接拖動四個圓點。", "warn");
585:   }
586: });
587: 
588: saveCropBtn.addEventListener("click", async () => {
589:   const page = state.pages.find(item => item.id === state.editorPageId);
590:   if (!page || !state.editorCorners) return;
591:   if (!validCorners(state.editorCorners, state.editorSource.width, state.editorSource.height)) {
592:     setEngineStatus("四角範圍太小或交錯，請重新調整。", "warn");
593:     return;
594:   }
595: 
596:   page.corners = cloneCorners(state.editorCorners);
597:   page.autoDetected = true;
598:   cropDialog.close();
599:   await processPage(page);
600: });
601: 
602: cropDialog.addEventListener("close", () => {
603:   state.editorPageId = null;
604:   state.editorSource = null;
605:   state.editorCorners = null;
606:   state.draggingCorner = null;
607: });
608: 
609: async function exportPdf() {
610:   const filename = currentFilename();
611:   if (!filename || !state.pages.length) return;
612:   if (!window.jspdf?.jsPDF) {
613:     setExportStatus("PDF 引擎尚未載入，請確認網路後重試。", "bad");
614:     return;
615:   }
616: 
617:   exportBtn.disabled = true;
618:   setExportStatus("正在產生 PDF…");
619: 
620:   try {
621:     const {jsPDF} = window.jspdf;
622:     const pdf = new jsPDF({orientation: "p", unit: "mm", format: "a4", compress: true});
623:     const pageW = 210;
624:     const pageH = 297;
625:     const margin = 6;
626: 
627:     state.pages.forEach((page, index) => {
628:       if (index > 0) pdf.addPage("a4", "p");
629:       const maxW = pageW - margin * 2;
630:       const maxH = pageH - margin * 2;
631:       const scale = Math.min(maxW / page.outputWidth, maxH / page.outputHeight);
632:       const width = page.outputWidth * scale;
633:       const height = page.outputHeight * scale;
634:       pdf.addImage(
635:         page.processedDataUrl,
636:         "JPEG",
637:         (pageW - width) / 2,
638:         (pageH - height) / 2,
639:         width,
640:         height,
641:         undefined,
642:         "FAST"
643:       );
644:     });
645: 
646:     const bytes = pdf.output("arraybuffer").byteLength;
647:     pdf.save(filename);
648:     setExportStatus(`已下載：${filename}（約 ${humanBytes(bytes)}）`, "ok");
649:   } catch (error) {
650:     console.error(error);
651:     setExportStatus(`PDF 產生失敗：${error.message || "未知錯誤"}`, "bad");
652:   } finally {
653:     updateExportState();
654:   }
655: }
656: 
657: cameraInput.addEventListener("change", async event => {
658:   await addFiles(event.target.files);
659:   event.target.value = "";
660: });
661: galleryInput.addEventListener("change", async event => {
662:   await addFiles(event.target.files);
663:   event.target.value = "";
664: });
665: 
666: $("#className").addEventListener("input", event => {
667:   event.target.value = event.target.value.replace(/\D/g, "");
668:   updateFilename();
669: });
670: $("#seatNo").addEventListener("input", event => {
671:   event.target.value = event.target.value.replace(/\D/g, "");
672:   updateFilename();
673: });
674: $("#studentName").addEventListener("input", updateFilename);
675: $("#essayTitle").addEventListener("input", updateFilename);
676: $("#practice").addEventListener("change", updateFilename);
677: exportBtn.addEventListener("click", exportPdf);
678: 
679: function runSelfChecks() {
680:   console.assert(
681:     buildFilename({className: "116", seatNo: "1", studentName: "張沛芸", essayTitle: "通關密語", practice: "一"}) ===
682:       "116-1_張沛芸_通關密語（一）.pdf",
683:     "filename contract failed"
684:   );
685:   const corners = defaultCorners(1000, 1400);
686:   console.assert(validCorners(corners, 1000, 1400), "default corner contract failed");
687: }
688: runSelfChecks();
689: 
690: if ("serviceWorker" in navigator && location.protocol === "https:") {
691:   navigator.serviceWorker.register("./sw.js").catch(() => {});
692: }
693: 
</content>
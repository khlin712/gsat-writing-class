const OPENCV_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
const MAX_OUTPUT_EDGE = 2200;
const ANALYSIS_EDGE = 1000;

let cvReadyPromise = null;

function waitFor(test, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (test()) return resolve();
      } catch (_) {}
      if (Date.now() - start > timeoutMs) return reject(new Error("OpenCV 初始化逾時"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function initOpenCV() {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = (async () => {
    importScripts(OPENCV_URL);

    const runtime = self.cv;
    if (!runtime) throw new Error("OpenCV 已載入，但找不到 cv runtime");

    if (!runtime.calledRun) {
      await new Promise((resolve, reject) => {
        const previous = runtime.onRuntimeInitialized;
        const timer = setTimeout(() => reject(new Error("OpenCV runtime 初始化逾時")), 60000);

        runtime.onRuntimeInitialized = () => {
          try { if (typeof previous === "function") previous(); } catch (_) {}
          clearTimeout(timer);
          resolve();
        };

        // Runtime may have completed between the check above and callback assignment.
        if (runtime.calledRun) {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    await waitFor(() => Boolean(runtime.Mat), 10000);
    return true;
  })();

  return cvReadyPromise;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function orderPoints(points) {
  const sums = points.map(p => p.x + p.y);
  const diffs = points.map(p => p.x - p.y);
  return {
    topLeftCorner: points[sums.indexOf(Math.min(...sums))],
    topRightCorner: points[diffs.indexOf(Math.max(...diffs))],
    bottomLeftCorner: points[diffs.indexOf(Math.min(...diffs))],
    bottomRightCorner: points[sums.indexOf(Math.max(...sums))]
  };
}

function defaultCorners(width, height) {
  // Low-confidence fallback keeps almost the entire photo instead of guessing a crop.
  const x = Math.round(width * 0.01);
  const y = Math.round(height * 0.01);
  return {
    topLeftCorner: {x, y},
    topRightCorner: {x: width - x, y},
    bottomLeftCorner: {x, y: height - y},
    bottomRightCorner: {x: width - x, y: height - y}
  };
}

function detectCorners(src) {
  const cv = self.cv;
  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const whiteMask = new cv.Mat();
  const edgeContours = new cv.MatVector();
  const edgeHierarchy = new cv.Mat();
  const whiteContours = new cv.MatVector();
  const whiteHierarchy = new cv.Mat();
  const pagePixels = Math.max(1, Math.round(src.cols * scale) * Math.round(src.rows * scale));
  const minimumArea = pagePixels * 0.16;

  function pointInConvexQuad(x, y, ordered) {
    const points = [
      ordered.topLeftCorner,
      ordered.topRightCorner,
      ordered.bottomRightCorner,
      ordered.bottomLeftCorner
    ];
    let direction = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (Math.abs(cross) < 0.001) continue;
      const current = cross > 0 ? 1 : -1;
      if (!direction) direction = current;
      else if (direction !== current) return false;
    }
    return true;
  }

  function paperWhiteRatio(ordered) {
    const points = Object.values(ordered);
    const minX = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
    const maxX = Math.min(gray.cols - 1, Math.ceil(Math.max(...points.map(p => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
    const maxY = Math.min(gray.rows - 1, Math.ceil(Math.max(...points.map(p => p.y))));
    const step = Math.max(2, Math.round(Math.max(gray.cols, gray.rows) / 260));
    let bright = 0;
    let sampled = 0;

    for (let y = minY; y <= maxY; y += step) {
      const rowOffset = y * gray.cols;
      for (let x = minX; x <= maxX; x += step) {
        if (!pointInConvexQuad(x, y, ordered)) continue;
        sampled++;
        if (gray.data[rowOffset + x] >= 150) bright++;
      }
    }
    return sampled ? bright / sampled : 0;
  }

  function candidateFromContour(contour) {
    const area = Math.abs(cv.contourArea(contour));
    if (area < minimumArea) return null;

    const perimeter = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) return null;

      const smallPoints = [];
      for (let j = 0; j < 4; j++) {
        const ptr = approx.intPtr(j, 0);
        smallPoints.push({x: ptr[0], y: ptr[1]});
      }
      const ordered = orderPoints(smallPoints);
      const whiteRatio = paperWhiteRatio(ordered);

      const rect = cv.minAreaRect(approx);
      const rectArea = Math.max(1, rect.size.width * rect.size.height);
      const rectangularity = Math.min(1, area / rectArea);
      const areaRatio = Math.min(1, area / pagePixels);

      // Essay paper is expected to be a large, bright, rectangular region.
      const areaScore = Math.min(1, areaRatio / 0.58);
      const confidence = Math.max(
        0,
        Math.min(1, areaScore * 0.42 + whiteRatio * 0.48 + rectangularity * 0.10)
      );

      return {
        confidence,
        whiteRatio,
        areaRatio,
        corners: {
          topLeftCorner: {x: ordered.topLeftCorner.x / scale, y: ordered.topLeftCorner.y / scale},
          topRightCorner: {x: ordered.topRightCorner.x / scale, y: ordered.topRightCorner.y / scale},
          bottomLeftCorner: {x: ordered.bottomLeftCorner.x / scale, y: ordered.bottomLeftCorner.y / scale},
          bottomRightCorner: {x: ordered.bottomRightCorner.x / scale, y: ordered.bottomRightCorner.y / scale}
        }
      };
    } finally {
      approx.delete();
    }
  }

  function considerContours(contours, currentBest) {
    let best = currentBest;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const candidate = candidateFromContour(contour);
        if (candidate && (!best || candidate.confidence > best.confidence)) best = candidate;
      } finally {
        contour.delete();
      }
    }
    return best;
  }

  try {
    cv.resize(
      src,
      small,
      new cv.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))),
      0, 0, cv.INTER_AREA
    );
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

    // 1) Traditional edge route catches paper even under uneven lighting.
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 45, 150);
    const edgeKernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, edgeKernel, new cv.Point(-1, -1), 1);
    edgeKernel.delete();
    cv.findContours(edges, edgeContours, edgeHierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // 2) Essay-specific route: large bright paper against a darker background.
    cv.threshold(gray, whiteMask, 150, 255, cv.THRESH_BINARY);
    const whiteKernel = cv.Mat.ones(7, 7, cv.CV_8U);
    cv.morphologyEx(whiteMask, whiteMask, cv.MORPH_CLOSE, whiteKernel, new cv.Point(-1, -1), 2);
    whiteKernel.delete();
    cv.findContours(whiteMask, whiteContours, whiteHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = considerContours(edgeContours, null);
    best = considerContours(whiteContours, best);

    if (!best) {
      return {corners: null, confidence: 0, whiteRatio: 0, areaRatio: 0};
    }

    // Below this confidence, preserve almost the full image and ask the user to confirm corners.
    const reliable = best.confidence >= 0.58 && best.whiteRatio >= 0.48 && best.areaRatio >= 0.16;
    return {
      corners: reliable ? best.corners : null,
      confidence: best.confidence,
      whiteRatio: best.whiteRatio,
      areaRatio: best.areaRatio
    };
  } finally {
    small.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    whiteMask.delete();
    edgeContours.delete();
    edgeHierarchy.delete();
    whiteContours.delete();
    whiteHierarchy.delete();
  }
}

function blurScore(src) {
  const cv = self.cv;
  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();

  try {
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, lap, cv.CV_32F);
    cv.meanStdDev(lap, mean, stddev);
    const sigma = stddev.data64F?.[0] ?? stddev.data32F?.[0] ?? 0;
    return sigma * sigma;
  } catch (_) {
    return null;
  } finally {
    small.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete();
  }
}

function perspective(src, corners) {
  const cv = self.cv;
  const width = Math.max(
    dist(corners.topLeftCorner, corners.topRightCorner),
    dist(corners.bottomLeftCorner, corners.bottomRightCorner)
  );
  const height = Math.max(
    dist(corners.topLeftCorner, corners.bottomLeftCorner),
    dist(corners.topRightCorner, corners.bottomRightCorner)
  );
  const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
  const outW = Math.max(400, Math.round(width * scale));
  const outH = Math.max(400, Math.round(height * scale));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners.topLeftCorner.x, corners.topLeftCorner.y,
    corners.topRightCorner.x, corners.topRightCorner.y,
    corners.bottomLeftCorner.x, corners.bottomLeftCorner.y,
    corners.bottomRightCorner.x, corners.bottomRightCorner.y
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW - 1, 0,
    0, outH - 1,
    outW - 1, outH - 1
  ]);
  const matrix = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();

  try {
    cv.warpPerspective(src, dst, matrix, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
    return dst.clone();
  } finally {
    srcTri.delete(); dstTri.delete(); matrix.delete(); dst.delete();
  }
}

function rotate(mat, degrees) {
  const cv = self.cv;
  const turns = ((degrees % 360) + 360) % 360;
  if (!turns) return mat.clone();
  const out = new cv.Mat();
  if (turns === 90) cv.rotate(mat, out, cv.ROTATE_90_CLOCKWISE);
  else if (turns === 180) cv.rotate(mat, out, cv.ROTATE_180);
  else if (turns === 270) cv.rotate(mat, out, cv.ROTATE_90_COUNTERCLOCKWISE);
  else return mat.clone();
  return out;
}

function enhance(mat) {
  const cv = self.cv;
  const gray = new cv.Mat();
  const background = new cv.Mat();
  const normalized = new cv.Mat();
  const toned = new cv.Mat();
  const soft = new cv.Mat();
  const sharp = new cv.Mat();

  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // Estimate local illumination so shadows/yellowish lighting do not turn the page gray.
    let kernelSize = Math.round(Math.min(gray.rows, gray.cols) / 28);
    kernelSize = Math.max(31, Math.min(71, kernelSize));
    if (kernelSize % 2 === 0) kernelSize += 1;

    cv.GaussianBlur(gray, background, new cv.Size(kernelSize, kernelSize), 0, 0, cv.BORDER_DEFAULT);
    cv.divide(gray, background, normalized, 255);

    // Essay-specific tone curve: push paper toward white while keeping handwriting grayscale detail.
    normalized.copyTo(toned);
    const pixels = toned.data;
    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i];
      let mapped;
      if (value < 170) {
        mapped = value * 0.88;
      } else if (value < 215) {
        mapped = 150 + (value - 170) * 2.0;
      } else {
        mapped = 240 + (value - 215) * (15 / 40);
      }
      pixels[i] = Math.max(0, Math.min(255, Math.round(mapped)));
    }

    // Light unsharp mask: clearer strokes without hard black/white thresholding.
    cv.GaussianBlur(toned, soft, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.addWeighted(toned, 1.16, soft, -0.16, 0, sharp);
    return sharp.clone();
  } finally {
    gray.delete();
    background.delete();
    normalized.delete();
    toned.delete();
    soft.delete();
    sharp.delete();
  }
}

function toRgba(mat) {
  const cv = self.cv;
  if (mat.channels() === 4) return mat.clone();
  const rgba = new cv.Mat();
  if (mat.channels() === 1) cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  else cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
  return rgba;
}

async function processImage(payload, reportProgress = () => {}) {
  const cv = self.cv;
  const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), payload.width, payload.height);
  const src = cv.matFromImageData(imageData);
  let warped = null;
  let rotated = null;
  let final = null;
  let rgba = null;

  try {
    reportProgress("detecting");
    const detection = payload.corners
      ? {corners: payload.corners, confidence: 1, whiteRatio: 1, areaRatio: 1}
      : detectCorners(src);
    const corners = detection.corners || defaultCorners(src.cols, src.rows);
    const automatic = !payload.corners && Boolean(detection.corners);
    const score = blurScore(src);

    reportProgress("perspective");
    warped = perspective(src, corners);
    rotated = rotate(warped, payload.rotation || 0);

    reportProgress(payload.mode === "enhanced" ? "enhancing" : "rendering");
    final = payload.mode === "enhanced" ? enhance(rotated) : rotated.clone();
    rgba = toRgba(final);

    reportProgress("encoding");
    const bytes = new Uint8ClampedArray(rgba.data.length);
    bytes.set(rgba.data);
    return {
      corners,
      autoDetected: automatic,
      detectionConfidence: detection.confidence,
      paperWhiteRatio: detection.whiteRatio,
      paperAreaRatio: detection.areaRatio,
      blurScore: score,
      width: rgba.cols,
      height: rgba.rows,
      buffer: bytes.buffer
    };
  } finally {
    src.delete();
    if (warped) warped.delete();
    if (rotated) rotated.delete();
    if (final) final.delete();
    if (rgba) rgba.delete();
  }
}

self.onmessage = async event => {
  const {id, action, payload} = event.data || {};
  try {
    await initOpenCV();
    if (action === "process") {
      const result = await processImage(payload, stage => {
        self.postMessage({id, type:"progress", stage});
      });
      self.postMessage({id, ok:true, result}, [result.buffer]);
      return;
    }
    if (action === "detect") {
      const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), payload.width, payload.height);
      const src = self.cv.matFromImageData(imageData);
      try {
        const detection = detectCorners(src);
        self.postMessage({id, ok:true, result:detection});
      } finally {
        src.delete();
      }
      return;
    }
    throw new Error("未知的掃描動作");
  } catch (error) {
    self.postMessage({id, ok:false, error:error?.message || String(error)});
  }
};

initOpenCV()
  .then(() => self.postMessage({type:"ready"}))
  .catch(error => self.postMessage({type:"init-error", error:error?.message || String(error)}));

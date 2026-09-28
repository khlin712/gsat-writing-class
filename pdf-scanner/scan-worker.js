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
  const x = Math.round(width * 0.035);
  const y = Math.round(height * 0.035);
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
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.resize(
      src,
      small,
      new cv.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))),
      0, 0, cv.INTER_AREA
    );
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 50, 160);

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let bestPoints = null;
    let bestArea = 0;
    const minimumArea = small.cols * small.rows * 0.12;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area <= minimumArea || area <= bestArea) {
        contour.delete();
        continue;
      }

      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

      if (approx.rows === 4) {
        const points = [];
        for (let j = 0; j < 4; j++) {
          const ptr = approx.intPtr(j, 0);
          points.push({x: ptr[0] / scale, y: ptr[1] / scale});
        }
        bestPoints = orderPoints(points);
        bestArea = area;
      }
      approx.delete();
      contour.delete();
    }

    if (bestPoints) return bestPoints;

    // Fallback: use the largest contour's extreme points by quadrant.
    let maxContour = null;
    let maxArea = minimumArea;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area > maxArea) {
        if (maxContour) maxContour.delete();
        maxContour = contour.clone();
        maxArea = area;
      }
      contour.delete();
    }
    if (!maxContour) return null;

    const rect = cv.minAreaRect(maxContour);
    const center = rect.center;
    const quadrants = {
      topLeftCorner: null,
      topRightCorner: null,
      bottomLeftCorner: null,
      bottomRightCorner: null
    };
    const bestDist = {topLeftCorner:0, topRightCorner:0, bottomLeftCorner:0, bottomRightCorner:0};

    for (let i = 0; i < maxContour.data32S.length; i += 2) {
      const p = {x:maxContour.data32S[i], y:maxContour.data32S[i+1]};
      let key;
      if (p.x <= center.x && p.y <= center.y) key = "topLeftCorner";
      else if (p.x > center.x && p.y <= center.y) key = "topRightCorner";
      else if (p.x <= center.x && p.y > center.y) key = "bottomLeftCorner";
      else key = "bottomRightCorner";
      const d = Math.hypot(p.x-center.x, p.y-center.y);
      if (d > bestDist[key]) {
        bestDist[key] = d;
        quadrants[key] = {x:p.x/scale, y:p.y/scale};
      }
    }
    maxContour.delete();
    return Object.values(quadrants).every(Boolean) ? quadrants : null;
  } finally {
    small.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
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
  const soft = new cv.Mat();
  const sharp = new cv.Mat();
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, background, new cv.Size(31,31), 0, 0, cv.BORDER_DEFAULT);
    cv.divide(gray, background, normalized, 255);
    cv.GaussianBlur(normalized, soft, new cv.Size(3,3), 0, 0, cv.BORDER_DEFAULT);
    cv.addWeighted(normalized, 1.22, soft, -0.22, 0, sharp);
    return sharp.clone();
  } finally {
    gray.delete(); background.delete(); normalized.delete(); soft.delete(); sharp.delete();
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

async function processImage(payload) {
  const cv = self.cv;
  const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), payload.width, payload.height);
  const src = cv.matFromImageData(imageData);
  let warped = null;
  let rotated = null;
  let final = null;
  let rgba = null;
  try {
    const detected = payload.corners || detectCorners(src);
    const corners = detected || defaultCorners(src.cols, src.rows);
    const automatic = !payload.corners && Boolean(detected);
    const score = blurScore(src);

    warped = perspective(src, corners);
    rotated = rotate(warped, payload.rotation || 0);
    final = payload.mode === "enhanced" ? enhance(rotated) : rotated.clone();
    rgba = toRgba(final);

    const bytes = new Uint8ClampedArray(rgba.data.length);
    bytes.set(rgba.data);
    return {
      corners,
      autoDetected: automatic,
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
      const result = await processImage(payload);
      self.postMessage({id, ok:true, result}, [result.buffer]);
      return;
    }
    if (action === "detect") {
      const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), payload.width, payload.height);
      const src = self.cv.matFromImageData(imageData);
      try {
        const corners = detectCorners(src);
        self.postMessage({id, ok:true, result:{corners}});
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

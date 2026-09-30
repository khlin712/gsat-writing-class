const OPENCV_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
const MAX_OUTPUT_EDGE = 3000;
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
  const neutralMask = new cv.Mat();
  const edgeContours = new cv.MatVector();
  const edgeHierarchy = new cv.Mat();
  const whiteContours = new cv.MatVector();
  const whiteHierarchy = new cv.Mat();
  const neutralContours = new cv.MatVector();
  const neutralHierarchy = new cv.Mat();
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

  function candidateFromContour(contour, source) {
    const area = Math.abs(cv.contourArea(contour));
    if (area < minimumArea) return null;

    const hull = new cv.Mat();
    let approx = null;
    try {
      cv.convexHull(contour, hull, false, true);
      const perimeter = cv.arcLength(hull, true);

      for (const epsilon of [0.015, 0.02, 0.03, 0.04, 0.06]) {
        const trial = new cv.Mat();
        cv.approxPolyDP(hull, trial, epsilon * perimeter, true);
        if (trial.rows === 4 && cv.isContourConvex(trial)) {
          approx = trial;
          break;
        }
        trial.delete();
      }
      if (!approx) return null;

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

      const areaScore = Math.min(1, areaRatio / 0.58);
      const confidence = Math.max(
        0,
        Math.min(1, areaScore * 0.42 + whiteRatio * 0.48 + rectangularity * 0.10)
      );

      return {
        source,
        confidence,
        whiteRatio,
        areaRatio,
        rectangularity,
        corners: {
          topLeftCorner: {x: ordered.topLeftCorner.x / scale, y: ordered.topLeftCorner.y / scale},
          topRightCorner: {x: ordered.topRightCorner.x / scale, y: ordered.topRightCorner.y / scale},
          bottomLeftCorner: {x: ordered.bottomLeftCorner.x / scale, y: ordered.bottomLeftCorner.y / scale},
          bottomRightCorner: {x: ordered.bottomRightCorner.x / scale, y: ordered.bottomRightCorner.y / scale}
        }
      };
    } finally {
      hull.delete();
      if (approx) approx.delete();
    }
  }

  function considerContours(contours, currentBest, source) {
    let best = currentBest;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const candidate = candidateFromContour(contour, source);
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

    // 1) Neutral-paper route: white essay paper under a strong shadow can be
    // too dark for a fixed brightness threshold, but remains relatively low-saturation.
    neutralMask.create(gray.rows, gray.cols, cv.CV_8UC1);
    const neutralPixels = neutralMask.data;
    const rgbaPixels = small.data;
    const grayPixels = gray.data;
    for (let i = 0; i < grayPixels.length; i++) {
      const offset = i * 4;
      const r = rgbaPixels[offset];
      const g = rgbaPixels[offset + 1];
      const b = rgbaPixels[offset + 2];
      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const chroma = maxChannel - minChannel;
      const lowSaturation = chroma <= Math.max(28, maxChannel * 0.38);
      neutralPixels[i] = grayPixels[i] >= 70 && lowSaturation ? 255 : 0;
    }
    const neutralCloseKernel = cv.Mat.ones(15, 15, cv.CV_8U);
    const neutralOpenKernel = cv.Mat.ones(5, 5, cv.CV_8U);
    cv.morphologyEx(neutralMask, neutralMask, cv.MORPH_CLOSE, neutralCloseKernel, new cv.Point(-1, -1), 2);
    cv.morphologyEx(neutralMask, neutralMask, cv.MORPH_OPEN, neutralOpenKernel, new cv.Point(-1, -1), 1);
    neutralCloseKernel.delete();
    neutralOpenKernel.delete();
    cv.findContours(neutralMask, neutralContours, neutralHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // 2) Traditional edge route catches paper even under uneven lighting.
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 45, 150);
    const edgeKernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, edgeKernel, new cv.Point(-1, -1), 1);
    edgeKernel.delete();
    cv.findContours(edges, edgeContours, edgeHierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // 3) Bright-paper route: large bright paper against a darker background.
    cv.threshold(gray, whiteMask, 150, 255, cv.THRESH_BINARY);
    const whiteKernel = cv.Mat.ones(7, 7, cv.CV_8U);
    cv.morphologyEx(whiteMask, whiteMask, cv.MORPH_CLOSE, whiteKernel, new cv.Point(-1, -1), 2);
    whiteKernel.delete();
    cv.findContours(whiteMask, whiteContours, whiteHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const bestNeutral = considerContours(neutralContours, null, "neutral");
    const bestEdge = considerContours(edgeContours, null, "edge");
    const bestWhite = considerContours(whiteContours, null, "white");
    const best = [bestEdge, bestWhite, bestNeutral].filter(Boolean)
      .sort((a, b) => b.confidence - a.confidence)[0] || null;

    if (!best) {
      return {corners: null, confidence: 0, whiteRatio: 0, areaRatio: 0};
    }

    let edgeReliable = false;
    if (bestEdge) {
      const c = bestEdge.corners;
      const width = Math.max(
        dist(c.topLeftCorner, c.topRightCorner),
        dist(c.bottomLeftCorner, c.bottomRightCorner)
      );
      const height = Math.max(
        dist(c.topLeftCorner, c.bottomLeftCorner),
        dist(c.topRightCorner, c.bottomRightCorner)
      );
      const ratio = width / Math.max(1, height);
      edgeReliable =
        bestEdge.confidence >= 0.88 &&
        bestEdge.whiteRatio >= 0.65 &&
        bestEdge.areaRatio >= 0.45 &&
        bestEdge.rectangularity >= 0.75 &&
        ratio >= 1.25 &&
        ratio <= 1.70;
    }

    const chosen = edgeReliable ? bestEdge : best;
    return {
      corners: edgeReliable ? bestEdge.corners : null,
      candidateCorners: chosen.corners,
      confidence: chosen.confidence,
      whiteRatio: chosen.whiteRatio,
      areaRatio: chosen.areaRatio
    };
  } finally {
    small.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    whiteMask.delete();
    neutralMask.delete();
    edgeContours.delete();
    edgeHierarchy.delete();
    whiteContours.delete();
    whiteHierarchy.delete();
    neutralContours.delete();
    neutralHierarchy.delete();
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


function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)));
  return sorted[pos];
}

function weightedLineFit(points) {
  if (!points || points.length < 20) return null;
  let work = points.slice();
  const scoreCut = percentile(work.map(p => p.score), 0.60);
  work = work.filter(p => p.score >= scoreCut);
  if (work.length < 20) return null;

  let a = 0;
  let b = 0;
  for (let iter = 0; iter < 4; iter++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of work) {
      const weight = Math.sqrt(Math.max(1, p.score));
      sw += weight;
      sx += weight * p.x;
      sy += weight * p.y;
      sxx += weight * p.x * p.x;
      sxy += weight * p.x * p.y;
    }
    const denom = sw * sxx - sx * sx;
    if (Math.abs(denom) < 1e-6) return null;
    a = (sw * sxy - sx * sy) / denom;
    b = (sy - a * sx) / sw;

    const residuals = work.map(p => Math.abs(p.y - (a * p.x + b)));
    const med = percentile(residuals, 0.5);
    const limit = Math.max(4, med * 2.5);
    const filtered = work.filter((p, i) => residuals[i] < limit);
    if (filtered.length < 15 || filtered.length === work.length) break;
    work = filtered;
  }

  let sumSq = 0;
  for (const p of work) {
    const r = p.y - (a * p.x + b);
    sumSq += r * r;
  }
  return {a, b, rms: Math.sqrt(sumSq / Math.max(1, work.length)), count: work.length};
}

function lineXofY(p1, p2) {
  const dy = p2.y - p1.y;
  if (Math.abs(dy) < 1e-6) return {c: 0, d: (p1.x + p2.x) / 2};
  const c = (p2.x - p1.x) / dy;
  return {c, d: p1.x - c * p1.y};
}

function intersectHorizontalVertical(horizontal, vertical) {
  const denom = 1 - horizontal.a * vertical.c;
  if (Math.abs(denom) < 1e-6) return null;
  const y = (horizontal.a * vertical.d + horizontal.b) / denom;
  const x = vertical.c * y + vertical.d;
  return {x, y};
}

function detectFoldGeometry(src, coarseCorners) {
  if (!coarseCorners) return null;
  const cv = self.cv;
  const targetWidth = Math.min(768, src.cols);
  const scale = targetWidth / src.cols;
  const targetHeight = Math.max(1, Math.round(src.rows * scale));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const smooth = new cv.Mat();

  try {
    cv.resize(src, small, new cv.Size(targetWidth, targetHeight), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, smooth, new cv.Size(0, 0), 2, 2, cv.BORDER_REPLICATE);

    const scaled = {};
    for (const [key, point] of Object.entries(coarseCorners)) {
      scaled[key] = {x: point.x * scale, y: point.y * scale};
    }

    const leftOuter = lineXofY(scaled.topLeftCorner, scaled.bottomLeftCorner);
    const rightOuter = lineXofY(scaled.topRightCorner, scaled.bottomRightCorner);
    const xLeft = Math.min(scaled.topLeftCorner.x, scaled.bottomLeftCorner.x);
    const xRight = Math.max(scaled.topRightCorner.x, scaled.bottomRightCorner.x);
    const widthSpan = xRight - xLeft;
    if (widthSpan < targetWidth * 0.45) return null;

    const k = Math.max(4, Math.round(targetHeight / 96));
    const topPoints = [];
    const bottomPoints = [];
    const data = smooth.data;
    const W = smooth.cols;
    const H = smooth.rows;
    const topStart = Math.max(k + 1, Math.round(H * 0.02));
    const topEnd = Math.min(H - k - 1, Math.round(H * 0.38));
    const bottomStart = Math.max(k + 1, Math.round(H * 0.62));
    const bottomEnd = Math.min(H - k - 1, Math.round(H * 0.99));

    for (let x = Math.max(0, Math.round(xLeft + 5)); x <= Math.min(W - 1, Math.round(xRight - 5)); x += 3) {
      let bestTopY = -1, bestTopScore = -Infinity;
      for (let y = topStart; y < topEnd; y++) {
        const score = data[(y + k) * W + x] - data[(y - k) * W + x];
        if (score > bestTopScore) {
          bestTopScore = score;
          bestTopY = y;
        }
      }
      if (bestTopScore > 18) topPoints.push({x, y: bestTopY, score: bestTopScore});

      let bestBottomY = -1, bestBottomScore = -Infinity;
      for (let y = bottomStart; y < bottomEnd; y++) {
        const score = data[(y - k) * W + x] - data[(y + k) * W + x];
        if (score > bestBottomScore) {
          bestBottomScore = score;
          bestBottomY = y;
        }
      }
      if (bestBottomScore > 18) bottomPoints.push({x, y: bestBottomY, score: bestBottomScore});
    }

    function fitPiece(points) {
      if (points.length < 80) return null;
      let best = null;
      for (let step = 0; step <= 24; step++) {
        const fraction = 0.42 + (0.16 * step / 24);
        const xCenter = xLeft + widthSpan * fraction;
        const gap = Math.max(8, widthSpan * 0.015);
        const left = points.filter(p => p.x < xCenter - gap);
        const right = points.filter(p => p.x > xCenter + gap);
        if (left.length < 30 || right.length < 30) continue;
        const fitLeft = weightedLineFit(left);
        const fitRight = weightedLineFit(right);
        if (!fitLeft || !fitRight) continue;

        const continuity = Math.abs(
          (fitLeft.a * xCenter + fitLeft.b) -
          (fitRight.a * xCenter + fitRight.b)
        );
        const score = fitLeft.rms + fitRight.rms + continuity * 0.30;
        if (!best || score < best.score) {
          best = {score, xCenter, left: fitLeft, right: fitRight};
        }
      }
      return best;
    }

    const topFit = fitPiece(topPoints);
    const bottomFit = fitPiece(bottomPoints);
    if (!topFit || !bottomFit) return null;

    const foldX = (topFit.xCenter + bottomFit.xCenter) / 2;
    const topCenterY =
      ((topFit.left.a * foldX + topFit.left.b) +
       (topFit.right.a * foldX + topFit.right.b)) / 2;
    const bottomCenterY =
      ((bottomFit.left.a * foldX + bottomFit.left.b) +
       (bottomFit.right.a * foldX + bottomFit.right.b)) / 2;

    const tl = intersectHorizontalVertical(topFit.left, leftOuter);
    const bl = intersectHorizontalVertical(bottomFit.left, leftOuter);
    const tr = intersectHorizontalVertical(topFit.right, rightOuter);
    const br = intersectHorizontalVertical(bottomFit.right, rightOuter);
    if (!tl || !tr || !bl || !br) return null;

    const sixSmall = {
      topLeft: tl,
      topCenter: {x: foldX, y: topCenterY},
      topRight: tr,
      bottomLeft: bl,
      bottomCenter: {x: foldX, y: bottomCenterY},
      bottomRight: br
    };

    const all = Object.values(sixSmall);
    if (all.some(p =>
      !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < -W * 0.08 || p.x > W * 1.08 ||
      p.y < -H * 0.08 || p.y > H * 1.08
    )) return null;

    const topWidth = dist(tl, tr);
    const bottomWidth = dist(bl, br);
    const leftHeight = dist(tl, bl);
    const rightHeight = dist(tr, br);
    const ratio = Math.max(topWidth, bottomWidth) / Math.max(1, Math.max(leftHeight, rightHeight));
    const foldFraction = (foldX - xLeft) / Math.max(1, widthSpan);
    const fitScore = topFit.score + bottomFit.score;

    if (
      ratio < 1.15 || ratio > 1.85 ||
      foldFraction < 0.38 || foldFraction > 0.62 ||
      fitScore > 55
    ) return null;

    const inverse = 1 / scale;
    const result = {};
    for (const [key, p] of Object.entries(sixSmall)) {
      result[key] = {x: p.x * inverse, y: p.y * inverse};
    }
    result.score = fitScore;
    return result;
  } finally {
    small.delete();
    gray.delete();
    smooth.delete();
  }
}

function piecewisePerspective(src, geometry) {
  const cv = self.cv;
  const aspect = Math.SQRT2;
  const outW = MAX_OUTPUT_EDGE;
  const outH = Math.round(outW / aspect);
  const half = Math.floor(outW / 2);

  const leftSrc = cv.matFromArray(4, 1, cv.CV_32FC2, [
    geometry.topLeft.x, geometry.topLeft.y,
    geometry.topCenter.x, geometry.topCenter.y,
    geometry.bottomLeft.x, geometry.bottomLeft.y,
    geometry.bottomCenter.x, geometry.bottomCenter.y
  ]);
  const leftDst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    half - 1, 0,
    0, outH - 1,
    half - 1, outH - 1
  ]);
  const rightSrc = cv.matFromArray(4, 1, cv.CV_32FC2, [
    geometry.topCenter.x, geometry.topCenter.y,
    geometry.topRight.x, geometry.topRight.y,
    geometry.bottomCenter.x, geometry.bottomCenter.y,
    geometry.bottomRight.x, geometry.bottomRight.y
  ]);
  const rightDst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW - half - 1, 0,
    0, outH - 1,
    outW - half - 1, outH - 1
  ]);
  const leftMatrix = cv.getPerspectiveTransform(leftSrc, leftDst);
  const rightMatrix = cv.getPerspectiveTransform(rightSrc, rightDst);
  const left = new cv.Mat();
  const right = new cv.Mat();
  const output = new cv.Mat();

  try {
    cv.warpPerspective(
      src, left, leftMatrix, new cv.Size(half, outH),
      cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255)
    );
    cv.warpPerspective(
      src, right, rightMatrix, new cv.Size(outW - half, outH),
      cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255)
    );

    output.create(outH, outW, src.type());
    const leftRoi = output.roi(new cv.Rect(0, 0, half, outH));
    const rightRoi = output.roi(new cv.Rect(half, 0, outW - half, outH));
    try {
      left.copyTo(leftRoi);
      right.copyTo(rightRoi);
    } finally {
      leftRoi.delete();
      rightRoi.delete();
    }
    return output.clone();
  } finally {
    leftSrc.delete(); leftDst.delete(); rightSrc.delete(); rightDst.delete();
    leftMatrix.delete(); rightMatrix.delete();
    left.delete(); right.delete(); output.delete();
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
  const backgroundSmall = new cv.Mat();
  const background = new cv.Mat();
  const normalized = new cv.Mat();
  const toned = new cv.Mat();
  const soft = new cv.Mat();
  const sharp = new cv.Mat();
  let output = null;

  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // Estimate only large-scale illumination. Downsampling first keeps handwriting
    // and grid lines out of the shadow model while staying fast on phone-sized images.
    const bgScale = Math.min(1, 420 / Math.max(gray.cols, gray.rows));
    const bgWidth = Math.max(1, Math.round(gray.cols * bgScale));
    const bgHeight = Math.max(1, Math.round(gray.rows * bgScale));
    cv.resize(gray, backgroundSmall, new cv.Size(bgWidth, bgHeight), 0, 0, cv.INTER_AREA);

    let kernelSize = Math.round(Math.min(bgWidth, bgHeight) / 6);
    kernelSize = Math.max(31, Math.min(61, kernelSize));
    if (kernelSize % 2 === 0) kernelSize += 1;
    cv.GaussianBlur(
      backgroundSmall,
      backgroundSmall,
      new cv.Size(kernelSize, kernelSize),
      0, 0,
      cv.BORDER_REPLICATE
    );
    cv.resize(backgroundSmall, background, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);

    cv.divide(gray, background, normalized, 248);

    // Adapt exposure to the page itself instead of using one fixed brightness curve.
    const histogram = new Uint32Array(256);
    for (const value of normalized.data) histogram[value]++;
    const targetCount = normalized.data.length * 0.90;
    let cumulative = 0;
    let p90 = 245;
    for (let value = 0; value < 256; value++) {
      cumulative += histogram[value];
      if (cumulative >= targetCount) {
        p90 = value;
        break;
      }
    }
    const gain = Math.max(0.95, Math.min(1.12, 246 / Math.max(1, p90)));

    normalized.copyTo(toned);
    const pixels = toned.data;
    for (let i = 0; i < pixels.length; i++) {
      const value = Math.max(0, Math.min(255, pixels[i] * gain));
      let mapped;
      if (value < 105) {
        mapped = value * 0.88;
      } else if (value < 185) {
        mapped = 92.4 + (value - 105);
      } else if (value < 232) {
        mapped = 172.4 + (value - 185) * 1.42;
      } else {
        mapped = 239.1 + (value - 232) * 0.70;
      }
      pixels[i] = Math.max(0, Math.min(255, Math.round(mapped)));
    }

    // Mild sharpening preserves fine strokes better than the previous stronger mask.
    cv.GaussianBlur(toned, soft, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.addWeighted(toned, 1.18, soft, -0.18, 0, sharp);

    // Keep red annotations and other colored writing. Correct luminance while
    // neutralizing only bright, low-chroma paper pixels toward white.
    output = mat.clone();
    const source = mat.data;
    const result = output.data;
    const luminance = sharp.data;
    const channels = mat.channels();

    if (channels < 3) return sharp.clone();

    for (let i = 0; i < luminance.length; i++) {
      const offset = i * channels;
      const r = source[offset];
      const g = source[offset + 1];
      const b = source[offset + 2];
      const originalY = Math.max(1, r * 0.299 + g * 0.587 + b * 0.114);
      const targetY = luminance[i];
      const ratio = targetY / originalY;

      let rr = Math.max(0, Math.min(255, r * ratio));
      let gg = Math.max(0, Math.min(255, g * ratio));
      let bb = Math.max(0, Math.min(255, b * ratio));

      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const chroma = maxChannel - minChannel;
      const brightBlend = Math.max(0, Math.min(1, (targetY - 190) / 55));
      const colorPreserve = Math.max(0, Math.min(1, (chroma - 12) / 45));
      const neutralBlend = brightBlend * 0.72 * (1 - colorPreserve);

      rr = rr * (1 - neutralBlend) + targetY * neutralBlend;
      gg = gg * (1 - neutralBlend) + targetY * neutralBlend;
      bb = bb * (1 - neutralBlend) + targetY * neutralBlend;

      result[offset] = Math.round(rr);
      result[offset + 1] = Math.round(gg);
      result[offset + 2] = Math.round(bb);
      if (channels === 4) result[offset + 3] = 255;
    }

    return output.clone();
  } finally {
    gray.delete();
    backgroundSmall.delete();
    background.delete();
    normalized.delete();
    toned.delete();
    soft.delete();
    sharp.delete();
    if (output) output.delete();
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
      ? {corners: payload.corners, candidateCorners: payload.corners, confidence: 1, whiteRatio: 1, areaRatio: 1}
      : detectCorners(src);
    const foldGeometry = payload.corners
      ? null
      : detectFoldGeometry(src, detection.candidateCorners || detection.corners);
    const corners = detection.corners || (
      foldGeometry ? {
        topLeftCorner: foldGeometry.topLeft,
        topRightCorner: foldGeometry.topRight,
        bottomLeftCorner: foldGeometry.bottomLeft,
        bottomRightCorner: foldGeometry.bottomRight
      } : defaultCorners(src.cols, src.rows)
    );
    const automatic = !payload.corners && Boolean(detection.corners || foldGeometry);
    const score = blurScore(src);

    reportProgress("perspective");
    warped = foldGeometry
      ? piecewisePerspective(src, foldGeometry)
      : perspective(src, corners);
    const landscapeRotation = payload.preferLandscape && warped.rows > warped.cols ? 90 : 0;
    rotated = rotate(warped, landscapeRotation + (payload.rotation || 0));

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
      autoLandscapeRotated: payload.preferLandscape && warped.rows > warped.cols,
      foldCorrected: Boolean(foldGeometry),
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

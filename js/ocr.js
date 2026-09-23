// ocr.js — Tesseract.js 封装、图片压缩、多栏版面检测

// 引擎与语言包全部走本地 vendor：无 CDN 依赖，弱网/离线均不卡死
// tessdata_best 高精度中文模型（默认 fast 模型对密排小字错字率高）
// worker 通过 blob 加载、core 由 worker 内 importScripts 加载，必须传绝对 URL
const VENDOR_URL = new URL('vendor/', import.meta.url).href;
const OCR_WORKER_PATH = VENDOR_URL + 'worker.min.js';
const OCR_CORE_PATH = VENDOR_URL;
const OCR_LANG_PATH = VENDOR_URL + 'lang';
const OCR_MAX_EDGE = 2560; // 长边像素上限：密排三栏书在 1600 下每栏仅 ~500px，识别崩坏

/**
 * 压缩图片到长边 maxEdge（拍照原图往往过大）。保持彩色（页面预览需要原色）。
 * 返回 { canvas, dataUrl, width, height }
 */
export async function compressImage(fileOrBlob, maxEdge = OCR_MAX_EDGE) {
  const bitmap = await loadBitmap(fileOrBlob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return { canvas, dataUrl, width: w, height: h };
}

function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(blob).catch(() => loadViaImg(blob));
  }
  return loadViaImg(blob);
}

function loadViaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// 灰度 + 对比度归一化（书页拍照常偏灰发暗，拉伸后识别率明显提升）
// ---------------------------------------------------------------------------
function toGrayscaleCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  // 采样 1% 像素求 1%/99% 分位，做线性拉伸
  const samples = [];
  for (let i = 0; i < d.length; i += 4 * 13) {
    samples.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.01)] ?? 0;
  const hi = samples[Math.floor(samples.length * 0.99)] ?? 255;
  const span = Math.max(1, hi - lo);

  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.max(0, Math.min(255, ((g - lo) / span) * 255));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// 多栏版面检测：对正文带（纵向 30%~97%）做列墨水投影，找贯通的白色栏缝。
// 返回 { count, bounds: [{x, w}, ...] }，坐标为 source 全图像素。
// ---------------------------------------------------------------------------
function detectColumns(source) {
  const W = Math.min(380, source.width);
  const s = W / source.width;
  const H = Math.round(source.height * s);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(source, 0, 0, W, H);
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const darkAt = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 150;
  };

  // 先求每行墨量，挑出"正文文本行"（墨量 2%~55%）：
  // 全黑页眉横条/整幅插图会污染栏缝检测，必须排除
  const yTop = Math.floor(H * 0.28);
  const yBot = Math.floor(H * 0.97);
  const textRows = [];
  for (let y = yTop; y < yBot; y++) {
    let ink = 0;
    for (let x = 0; x < W; x++) if (darkAt(x, y)) ink++;
    const ratio = ink / W;
    if (ratio >= 0.02 && ratio <= 0.55) textRows.push(y);
  }
  if (textRows.length < 8) return { count: 1, bounds: [{ x: 0, w: source.width }] }; // 文本行不足，按单栏处理

  // 分带找栏缝：拍照轻微透视时栏缝并非完全垂直，全页累计投影会被零星墨点
  // "填"没；改为把正文区分成 6 个水平条带，各带独立找低墨列，再对条带结果
  // 投票聚类——真正的栏缝会在多数条带的相近 x 位置重复出现。
  const BANDS = 6;
  const votes = [];
  for (let b = 0; b < BANDS; b++) {
    const by0 = Math.round(yTop + (yBot - yTop) * b / BANDS);
    const by1 = Math.round(yTop + (yBot - yTop) * (b + 1) / BANDS);
    const rows = [];
    for (let y = by0; y < by1; y++) {
      let ink = 0;
      for (let x = 0; x < W; x++) if (darkAt(x, y)) ink++;
      const r = ink / W;
      if (r >= 0.02 && r <= 0.55) rows.push(y);
    }
    if (rows.length < 5) continue;
    let runStart = -1;
    for (let x = 0; x <= W; x++) {
      let v = 1;
      if (x < W) {
        let n = 0;
        for (const y of rows) if (darkAt(x, y)) n++;
        v = n / rows.length;
      }
      if (v < 0.015) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart >= 3) votes.push((runStart + x - 1) / 2);
        runStart = -1;
      }
    }
  }

  // 跨条带聚类（容差 ±3.5% 页宽）
  const clusters = [];
  for (const v of votes) {
    const c = clusters.find((cc) => Math.abs(cc.sum / cc.n - v) <= W * 0.035);
    if (c) { c.sum += v; c.n += 1; }
    else clusters.push({ sum: v, n: 1 });
  }
  const needVotes = 4; // 至少 4/6 条带命中，排除偶然字间竖缝
  const candidates = clusters
    .filter((c) => c.n >= needVotes)
    .map((c) => ({ p: c.sum / c.n, n: c.n }))
    .filter((c) => c.p > W * 0.12 && c.p < W * 0.88)
    .sort((a, b) => a.p - b.p);

  const balance = (widths) => Math.min(...widths) / Math.max(...widths);

  // 三栏：枚举两个候选切点，要求三块等宽（容差 0.55）
  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].p, b = candidates[j].p;
      const widths = [a, b - a, W - b];
      const bal = balance(widths);
      if (bal > 0.55 && a > W * 0.22 && a < W * 0.46 && b > W * 0.54 && b < W * 0.78) {
        const score = bal + (candidates[i].n + candidates[j].n) / 100;
        if (!best || score > best.score) best = { score, cuts: [a, b] };
      }
    }
  }
  if (best) return boundsFromGaps(source.width, best.cuts.map((p) => p / s));

  // 二栏：一个居中栏缝
  const mid = candidates.find((c) => c.p > W * 0.40 && c.p < W * 0.60);
  if (mid && balance([mid.p, W - mid.p]) > 0.7) {
    return boundsFromGaps(source.width, [mid.p / s]);
  }

  return { count: 1, bounds: [{ x: 0, w: source.width }] };
}

function boundsFromGaps(fullW, cuts) {
  const inset = Math.max(6, Math.round(fullW * 0.004)); // 栏内缩，避免切到栏边半个字
  const pts = [0, ...cuts, fullW];
  const bounds = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const x = i === 0 ? 0 : Math.round(pts[i]) + inset;
    const right = i === pts.length - 2 ? fullW : Math.round(pts[i + 1]) - inset;
    bounds.push({ x, w: right - x });
  }
  return { count: bounds.length, bounds };
}

function cjkCount(t) {
  let cjk = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
  }
  return cjk;
}

/**
 * 判断一行是否"完整正文行"：密排正文每行有十几个以上汉字；插图暗部误识出的
 * 乱码行通常只有 1~5 个零散"汉字"。阈值取 7，另接受"四位段号+至少 2 字"。
 * 用于丢弃顶部插图区 OCR 出的零散乱码。
 */
function denseTextLine(text) {
  // 跳转行（查看/段落 + 段号）通常很短，但属于有效正文锚点；OCR 可能在字间插空格
  if (/(?:查\s*看|段\s*落)[\s"“”‘’]*[0-9OolIDQ]{4}/.test(text)) return true;
  if (/^[0-9OolIDQ]{4}/.test(text)) return cjkCount(text) >= 2;
  return cjkCount(text) >= 7;
}

// ---------------------------------------------------------------------------
// 行投影分带：按行墨水统计切出文本行（绕开 Tesseract 对密排三栏的行切分缺陷）。
// 处理：整页竖线/栏缝暗条掩码、局部暗条导致的巨块递归拆分、黑底页眉剔除、
// 行内 x 范围裁剪。返回 [{ y0, y1, x0, x1 }]（canvas 像素坐标）。
// 真实书 12 页 bench 验证：行数 +15%、漏行大幅减少、junk 显著下降。
// ---------------------------------------------------------------------------
function computeLineBands(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const dark = (x, y) => { const i = (y * W + x) * 4; return d[i] < 140; };
  const thr = Math.max(3, Math.round(W * 0.012));

  const colDark = (y0, y1) => {
    const cd = new Int32Array(W);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (dark(x, y)) cd[x]++;
    return cd;
  };
  const rowInk = (y0, y1, mask) => {
    const rows = new Int32Array(y1 - y0);
    for (let y = y0; y < y1; y++) {
      let ink = 0;
      for (let x = 0; x < W; x++) if (mask[x] && dark(x, y)) ink++;
      rows[y - y0] = ink;
    }
    return rows;
  };
  const toBands = (rows, y0, thrX = thr) => {
    const out = []; let s = -1;
    for (let i = 0; i < rows.length; i++) {
      const on = rows[i] >= thrX && rows[i] < W * 0.75;
      if (on && s < 0) s = i;
      else if (!on && s >= 0) { out.push([y0 + s, y0 + i - 1]); s = -1; }
    }
    if (s >= 0) out.push([y0 + s, y0 + rows.length - 1]);
    return out;
  };

  // 1) 整页竖线掩码（书脊阴影/装订线整列暗 → 不参与行墨水统计）
  const cdPage = colDark(0, H - 1);
  const pageMask = new Uint8Array(W);
  for (let x = 0; x < W; x++) pageMask[x] = cdPage[x] / H > 0.85 ? 0 : 1;

  let bands = toBands(rowInk(0, H, pageMask), 0);
  const hs = bands.map((b) => b[1] - b[0]).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 20;

  // 2) 巨块（局部暗条/书脊阴影干扰多行粘连）→ 局部列掩码 + 高阈值递归拆分
  //    （正文行墨水远高于阴影暗条）
  const final = [];
  const process = (b) => {
    const h = b[1] - b[0];
    if (h > medH * 3.2 && h > 40) {
      const cd = colDark(b[0], b[1]);
      const localMask = new Uint8Array(W);
      for (let x = 0; x < W; x++) localMask[x] = cd[x] / (h + 1) > 0.7 ? 0 : 1;
      let sub = toBands(rowInk(b[0], b[1] + 1, localMask), b[0]);
      if (sub.length <= 1) sub = toBands(rowInk(b[0], b[1] + 1, localMask), b[0], Math.max(40, thr * 5));
      if (sub.length > 1) { for (const s2 of sub) process(s2); }
      else final.push(b); // 拆不动，保留原块（避免无限递归）
    } else final.push(b);
  };
  for (const b of bands) process(b);

  // 3) 合并同行碎片 + 过滤噪声/黑底页眉 + 计算行内 x 范围（去左右空边）
  const merged = [];
  for (const b of final) {
    const last = merged[merged.length - 1];
    if (last && b[0] - last[1] < 8) last[1] = b[1];
    else merged.push([...b]);
  }
  const out = [];
  for (const [y0, y1] of merged) {
    const h = y1 - y0;
    if (h < Math.max(12, medH * 0.4) || h > medH * 3.2) continue;
    let sum = 0;
    for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) sum += d[(y * W + x) * 4];
    if (sum / (h + 1) / W < 150) continue; // 黑底页眉/色带
    const cd = colDark(y0, y1);
    let x0 = -1, x1 = -1;
    for (let x = 0; x < W; x++) {
      if (cd[x] / (h + 1) > 0.6) continue; // 行内竖线
      if (cd[x] >= 2) { if (x0 < 0) x0 = x; x1 = x; }
    }
    if (x0 < 0) continue;
    out.push({ y0, y1, x0: Math.max(0, x0 - 6), x1: Math.min(W - 1, x1 + 6) });
  }
  return out;
}

// 从源图裁一行并等比缩放到目标高度（PSM7 单行识别的最佳输入尺寸）
function makeLineCanvas(src, x0, top, x1, bot, targetH = 72) {
  const w = x1 - x0 + 1, h = bot - top;
  const nw = Math.max(1, Math.round(w * targetH / h));
  const c = document.createElement('canvas');
  c.width = nw; c.height = targetH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, top, w, h, 0, 0, nw, targetH);
  return c;
}

/**
 * 检测页面上的深色横向色带（黑底白字的页眉/章节横幅）。
 * 横幅上的白字 OCR 出来是乱码，必须剔除，否则会被当成跨页续文拼进正文。
 * 用"整行亮度中位数"判断：正文行白底中位亮度很高，黑带行整行偏暗。
 * 必须在对比度归一化之前的图上检测（归一化会把黑带拉灰）。
 * 返回 [{ y0, y1 }]（像素坐标）；只检查页高 10%~45% 区间。
 */
function detectDarkBands(canvas) {
  const W = Math.min(380, canvas.width);
  const s = W / canvas.width;
  const H = Math.round(canvas.height * s);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(canvas, 0, 0, W, H);
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const bands = [];
  let runStart = -1;
  let runX0 = W, runX1 = 0;
  const yStart = Math.floor(H * 0.10), yEnd = Math.floor(H * 0.45);
  for (let y = yStart; y <= yEnd; y++) {
    let isBand = false;
    let bx0 = W, bx1 = 0;
    if (y < yEnd) {
      // 横幅可能只占页宽的一部分（标题条常非通栏），用"最长暗像素连续游程"判断：
      // 正文行不可能出现横跨 18% 页宽的连续深色；同时记录游程横向范围
      let run = 0, maxRun = 0, rStart = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (v < 100) {
          if (run === 0) rStart = x;
          run++;
          if (run > maxRun) { maxRun = run; bx0 = rStart; bx1 = x; }
        } else run = 0;
      }
      isBand = maxRun >= W * 0.18;
    }
    if (isBand && runStart < 0) { runStart = y; runX0 = bx0; runX1 = bx1; }
    if (isBand) { runX0 = Math.min(runX0, bx0); runX1 = Math.max(runX1, bx1); }
    if (!isBand && runStart >= 0) {
      const bh = y - runStart;
      if (bh >= H * 0.012 && bh <= H * 0.08) {
        // 二次确认：白字横幅的暗底上有大量白色文字笔画；深色插图暗部几乎没有亮像素。
        // 统计候选矩形内亮像素（>190）占比，>=22% 才认定为黑底白字横幅。
        let light = 0, total = 0;
        for (let yy = runStart; yy < y; yy++) {
          for (let xx = runX0; xx <= runX1; xx++) {
            const ii = (yy * W + xx) * 4;
            const vv = 0.299 * d[ii] + 0.587 * d[ii + 1] + 0.114 * d[ii + 2];
            if (vv > 190) light++;
            total++;
          }
        }
        if (total > 0 && light / total >= 0.22) {
          bands.push({
            y0: (runStart / s) - 6, y1: (y / s) + 6,
            x0: (runX0 / s) - 8, x1: (runX1 / s) + 8, // 横幅横向范围（过滤时用，避免误删其他栏）
          });
        }
      }
      runStart = -1;
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Tesseract Worker 单例（createWorker 含 WASM/语言包加载，复用避免每页重载）
// ---------------------------------------------------------------------------
let workerPromise = null;
let workerLogger = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker('chi_sim', 1, {
      workerPath: OCR_WORKER_PATH,
      corePath: OCR_CORE_PATH,
      langPath: OCR_LANG_PATH,
      gzip: true,
      logger: (m) => { workerLogger?.(m.status, m.progress ?? 0); },
    }).catch((err) => {
      workerPromise = null; // 失败后重置，允许下次重试（否则一次网络抖动永久失败）
      throw err;
    });
  }
  return workerPromise;
}

/**
 * 识别图片：自动多栏检测 → 逐栏识别 → 按栏序合并，行坐标映射回整页坐标系。
 * dataUrl 或 canvas 均可。
 * 返回 { lines: [{text, x0, y0, x1, y1, column}], fullText, width, height, columns }
 */
export async function recognizeImage(dataUrlOrCanvas, onProgress) {
  if (!window.Tesseract) throw new Error('OCR 引擎未加载，请检查网络后刷新页面');

  let source;
  if (typeof dataUrlOrCanvas === 'string') {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im); im.onerror = reject;
      im.src = dataUrlOrCanvas;
    });
    const scale = Math.min(1, OCR_MAX_EDGE / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    source = cv;
  } else {
    const scale = Math.min(1, OCR_MAX_EDGE / Math.max(dataUrlOrCanvas.width, dataUrlOrCanvas.height));
    if (scale < 1) {
      const cv = document.createElement('canvas');
      cv.width = Math.round(dataUrlOrCanvas.width * scale);
      cv.height = Math.round(dataUrlOrCanvas.height * scale);
      cv.getContext('2d').drawImage(dataUrlOrCanvas, 0, 0, cv.width, cv.height);
      source = cv;
    } else source = dataUrlOrCanvas;
  }

  const darkBands = detectDarkBands(source); // 必须在归一化前检测黑带
  const gray = toGrayscaleCanvas(source);
  const { count, bounds } = detectColumns(gray);

  workerLogger = (status, p) => { if (status !== 'recognizing text') onProgress?.(status, p); };
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '7' }); // 单行识别模式
  const allLines = [];
  const colTexts = [];
  for (let ci = 0; ci < bounds.length; ci++) {
    const b = bounds[ci];
    // 密排多栏的栏宽常只有 ~850px（每字 ~25px，低于 Tesseract 最佳区间），
    // 放大 1.5 倍再识别可显著降低误识。栏已够宽（≥1150px）时不放大，避免浪费。
    const k = b.w < 1150 ? 1.5 : 1;
    const cc = document.createElement('canvas');
    cc.width = Math.round(b.w * k);
    cc.height = Math.round(gray.height * k);
    const cctx = cc.getContext('2d');
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(gray, b.x, 0, b.w, gray.height, 0, 0, cc.width, cc.height);

    // 行投影分带 → 逐行裁剪（上下留 15% 呼吸空间）→ 缩放到 72px 高 → PSM7 识别
    const bands = computeLineBands(cc);
    const colLines = [];
    for (let li = 0; li < bands.length; li++) {
      const { y0, y1, x0, x1 } = bands[li];
      const bh = y1 - y0;
      const pad = Math.round(bh * 0.15);
      const top = Math.max(0, y0 - pad), bot = Math.min(cc.height, y1 + pad + 1);
      const lineUrl = makeLineCanvas(cc, x0, top, x1, bot).toDataURL('image/png');
      const r = await worker.recognize(lineUrl);
      let text = (r.data.text ?? '').replace(/[\n\r]+/g, ' ').trim();
      // 段号利用大字号特征二次校验：行首 2~4 位疑似数字 → 只裁行首区域，
      // 用纯数字白名单重识别，四位数结果才回填（bench 实测段号识别显著提升）
      const m = text.match(/^([0-9OolIDQ]{2,4})(?![0-9OolIDQ])/);
      if (m && cjkCount(text) >= 2) {
        const numW = Math.min(x1 - x0 + 1, Math.round(bh * 3.4));
        const numUrl = makeLineCanvas(cc, x0, top, Math.min(x1, x0 + numW - 1), bot).toDataURL('image/png');
        await worker.setParameters({ tessedit_char_whitelist: '0123456789' });
        const rn = await worker.recognize(numUrl);
        await worker.setParameters({ tessedit_char_whitelist: '' });
        const digits = (rn.data.text ?? '').replace(/\D/g, '');
        if (digits.length === 4) text = digits + text.slice(m[1].length);
      }
      if (text) colLines.push({
        text,
        x0: x0 / k + b.x, y0: y0 / k, x1: x1 / k + b.x, y1: y1 / k, column: ci,
      });
      onProgress?.('recognizing text', ((ci + (li + 1) / bands.length) / bounds.length) * 0.95);
    }
    // 过滤：页眉深色横幅内的白字乱码（横幅可能只占一栏宽，必须同时命中横向范围）；
    // 页脚 1.3% 内的页码行
    let kept = colLines.filter((l) => {
      const cy = (l.y0 + l.y1) / 2;
      const cx = (l.x0 + l.x1) / 2;
      if (darkBands.some((band2) => cy >= band2.y0 && cy <= band2.y1 && cx >= band2.x0 && cx <= band2.x1)) return false;
      if (l.y0 > gray.height * 0.987) return false;
      return true;
    });
    // 每栏第一条"完整正文行"（足够长的密排文字）之上的识别结果，都是顶部插图/页眉噪声，丢弃。
    // 不能只用"含 3 个汉字"：插图暗部纹理常被误识成 3 个左右的零散汉字。
    const firstGood = kept.findIndex((l) => denseTextLine(l.text));
    if (firstGood > 0) kept = kept.slice(firstGood);
    allLines.push(...kept);
    colTexts.push(kept.map((l) => l.text).join('\n'));
  }
  onProgress?.('recognizing text', 1);

  // 按栏、纵向排序（不可跨栏按 y 混排）
  allLines.sort((a, b) => (a.column - b.column) || (a.y0 - b.y0));

  return {
    lines: allLines,
    fullText: colTexts.join('\n'),
    width: gray.width,
    height: gray.height,
    columns: count,
  };
}

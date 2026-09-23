// pdfimport.js — pdf.js 渲染 PDF 页为图片（依赖 index.html 引入的 window.pdfjsLib，本地 vendor）

/**
 * 加载 PDF 文件。返回 { doc, numPages }。
 */
export async function loadPdf(file) {
  if (!window.pdfjsLib) throw new Error('PDF 引擎未加载，请刷新页面重试');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('vendor/pdf.worker.min.js', import.meta.url).href;
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  return { doc, numPages: doc.numPages };
}

/**
 * 渲染第 pageNumber 页为 canvas（缩放到长边 ≤ maxEdge）。
 * 返回 { canvas, dataUrl }。
 */
export async function renderPdfPage(doc, pageNumber, maxEdge = 2560) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxEdge / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PDF 透明底涂白，避免 JPEG 压缩发黑
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { canvas, dataUrl };
}

/**
 * canvas 转 Blob（供压缩管线复用统一入口）。
 */
export function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

// app.js — 单页应用入口：hash 路由 + 视图 + 扫描流程 + 朗读 + 跳转
import * as db from './db.js';
import * as parser from './parser.js';
import * as tts from './tts.js';
import * as ocr from './ocr.js';
import * as pdfimport from './pdfimport.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function showModal(title, contentNode, actions = []) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal' },
    el('div', { class: 'modal-title' }, title),
    contentNode,
    el('div', { class: 'modal-actions' },
      actions.map((a) => el('button', { class: `btn ${a.class || ''}`, onclick: () => a.onclick?.(overlay) }, a.label))),
  );
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay && !overlay.dataset.lock) overlay.remove(); });
  document.body.append(overlay);
  return overlay;
}

function confirmDialog(title, msg) {
  return new Promise((resolve) => {
    const overlay = showModal(title, el('p', { class: 'modal-msg' }, msg), [
      { label: '取消', onclick: (o) => { o.remove(); resolve(false); } },
      { label: '确定', class: 'danger', onclick: (o) => { o.remove(); resolve(true); } },
    ]);
    overlay.dataset.lock = '1';
  });
}

// ---------------------------------------------------------------------------
// 设置（语音 / 语速）
// ---------------------------------------------------------------------------
const settings = {
  get voiceURI() { return localStorage.getItem('sb-voice') || ''; },
  get rate() { return parseFloat(localStorage.getItem('sb-rate') || '1') || 1; },
  set voiceURI(v) { localStorage.setItem('sb-voice', v); },
  set rate(v) { localStorage.setItem('sb-rate', String(v)); },
};

async function currentVoice(voices) {
  const list = voices || await tts.getVoices();
  if (!list.length) return null;
  const saved = list.find((v) => v.voiceURI === settings.voiceURI);
  return saved || tts.pickDefaultVoice(list);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const routes = [
  { re: /^#\/$/, fn: renderShelf },
  { re: /^#\/book\/(\d+)$/, fn: (m) => renderBook(Number(m[1])) },
  { re: /^#\/read\/(\d+)$/, fn: (m) => renderRead(Number(m[1])) },
  { re: /^#\/para\/(\d+)$/, fn: (m) => renderParagraphDetail(Number(m[1])) },
  { re: /^#\/scan\/(\d+)$/, fn: (m) => renderScan(Number(m[1])) },
  { re: /^#\/settings$/, fn: renderSettings },
];

async function route() {
  const hash = location.hash || '#/';
  tts.stop();
  for (const r of routes) {
    const m = r.re.exec(hash);
    if (m) { await r.fn(m); return; }
  }
  location.hash = '#/';
}

function setHeader(title, showBack = false) {
  const header = $('#app-header');
  header.innerHTML = '';
  if (showBack) {
    header.append(el('button', { class: 'icon-btn', onclick: () => history.back(), 'aria-label': '返回' }, '←'));
  }
  header.append(el('h1', {}, title));
}

function setBottomNav(active) {
  const nav = $('#bottom-nav');
  nav.style.display = active ? '' : 'none';
  if (!active) return;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.nav === active);
  }
}

function nav(hash) { location.hash = hash; }

// ---------------------------------------------------------------------------
// 书架
// ---------------------------------------------------------------------------
async function renderShelf() {
  setHeader('我的书架');
  setBottomNav('shelf');
  const v = view();
  v.innerHTML = '';

  const books = await db.listBooks();
  const grid = el('div', { class: 'card-list' });
  if (!books.length) {
    grid.append(el('div', { class: 'empty-hint' }, '书架还是空的，先新建一本书吧'));
  }
  for (const b of books) {
    const chapters = await db.listChapters(b.id);
    const card = el('div', { class: 'card book-card', onclick: () => nav(`#/book/${b.id}`) },
      el('div', { class: 'book-spine' }),
      el('div', { class: 'book-info' },
        el('h2', {}, b.title),
        el('p', { class: 'muted' }, `${chapters.length} 个章节`),
      ),
      el('button', {
        class: 'icon-btn danger', 'aria-label': '删除',
        onclick: async (e) => {
          e.stopPropagation();
          if (await confirmDialog('删除书籍', `确定删除《${b.title}》及其全部章节和段落吗？`)) {
            await db.deleteBook(b.id);
            route();
          }
        },
      }, '✕'),
    );
    grid.append(card);
  }

  const input = el('input', { class: 'input', placeholder: '书名，如《惊险岔路口》', maxlength: '60' });
  const form = el('div', { class: 'card new-form' },
    input,
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const title = input.value.trim();
        if (!title) { toast('请输入书名'); return; }
        const id = await db.addBook(title);
        nav(`#/book/${id}`);
      },
    }, '新建书'),
  );

  v.append(grid, form);
}

// ---------------------------------------------------------------------------
// 书详情（章节列表）
// ---------------------------------------------------------------------------
async function renderBook(bookId) {
  const book = await db.getBook(bookId);
  if (!book) { nav('#/'); return; }
  setHeader(book.title, true);
  setBottomNav(null);
  const v = view();
  v.innerHTML = '';

  const chapters = await db.listChapters(bookId);
  const list = el('div', { class: 'card-list' });
  if (!chapters.length) list.append(el('div', { class: 'empty-hint' }, '还没有章节，扫描前先建一个'));

  for (const ch of chapters) {
    const paras = await db.listParagraphs(ch.id);
    const textCount = paras.filter((p) => p.type === 'text').length;
    const pending = paras.some((p) => p.pending);
    list.append(el('div', { class: 'card chapter-card' },
      el('div', { class: 'chapter-title' },
        el('h3', {}, ch.title),
        pending ? el('span', { class: 'badge pending-badge' }, '续扫中') : null,
      ),
      el('p', { class: 'muted' }, `${textCount} 个段落${pending ? '（上一页段落未闭合）' : ''}`),
      el('div', { class: 'row-btns' },
        el('button', { class: 'btn', onclick: () => nav(`#/read/${ch.id}`) }, '阅读'),
        el('button', { class: 'btn primary', onclick: () => nav(`#/scan/${ch.id}`) }, pending ? '继续扫描' : '扫描'),
        el('button', {
          class: 'icon-btn danger', 'aria-label': '删除章节',
          onclick: async () => {
            if (await confirmDialog('删除章节', `确定删除「${ch.title}」及其中所有段落吗？`)) {
              await db.deleteChapter(ch.id);
              route();
            }
          },
        }, '✕'),
      ),
    ));
  }

  const input = el('input', { class: 'input', placeholder: '章节名，如 第一章', maxlength: '60' });
  const form = el('div', { class: 'card new-form' },
    input,
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        const title = input.value.trim();
        if (!title) { toast('请输入章节名'); return; }
        const id = await db.addChapter(bookId, title);
        nav(`#/scan/${id}`);
      },
    }, '新建章节并扫描'),
  );

  v.append(list, form);
}

// ---------------------------------------------------------------------------
// 章节段落目录（一级导航）：全部段落列表，点击进入段落详情
// ---------------------------------------------------------------------------
async function renderRead(chapterId) {
  const chapter = await db.getChapter(chapterId);
  if (!chapter) { nav('#/'); return; }
  const paras = (await db.listParagraphs(chapterId)).filter((p) => p.type === 'text');

  setHeader(chapter.title, true);
  setBottomNav(null);
  const v = view();
  v.innerHTML = '';

  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn small', onclick: () => nav(`#/scan/${chapterId}`) }, '继续扫描'),
    el('button', { class: 'btn small', onclick: () => showImportTextModal(chapterId) }, '导入文本'),
  );

  const list = el('div', { class: 'card para-toc' });
  if (!paras.length) {
    list.append(el('div', { class: 'empty-hint' }, '本章节还没有内容，去扫描几页或导入文本吧'));
  }
  for (const p of paras) {
    const brief = p.text.length > 30 ? p.text.slice(0, 30) + '…' : (p.text || '（空段落）');
    list.append(el('button', { class: 'toc-item', onclick: () => nav(`#/para/${p.id}`) },
      el('span', { class: 'toc-number' }, p.number || '—'),
      el('span', { class: 'toc-brief' }, brief),
    ));
  }

  v.append(toolbar, list);
}

// ---------------------------------------------------------------------------
// 段落详情（二级导航）：正文大字阅读 + 跳转 + 朗读 + 编辑/删除
// ---------------------------------------------------------------------------
async function renderParagraphDetail(paraId) {
  const p = await db.getParagraph(paraId);
  if (!p || p.type !== 'text') { nav('#/'); return; }
  const chapter = await db.getChapter(p.chapterId);
  if (!chapter) { nav('#/'); return; }
  const paras = (await db.listParagraphs(p.chapterId)).filter((x) => x.type === 'text');
  const idx = paras.findIndex((x) => x.id === p.id);
  const voice = await currentVoice();

  setHeader(p.number ? `${chapter.title} · ${p.number}` : chapter.title, true);
  setBottomNav(null);
  const v = view();
  v.innerHTML = '';

  const body = el('p', { class: 'para-detail-body' });
  for (const token of parser.tokenizeText(p.text)) {
    if (token.type === 'jump') {
      body.append(el('button', {
        class: 'jump-link',
        onclick: () => {
          const dest = paras.find((x) => x.number === token.target);
          if (dest) nav(`#/para/${dest.id}`);
          else toast(`未找到段落 ${token.target}`);
        },
      }, token.value));
    } else {
      body.append(token.value);
    }
  }

  const speakBtn = el('button', { class: 'btn', onclick: () => toggleSpeak(p, voice, card, speakBtn) }, '▶ 朗读本段');
  const card = el('div', { class: 'card para-detail text-para' },
    body,
    el('div', { class: 'row-btns detail-btns' },
      speakBtn,
      el('button', { class: 'btn', onclick: () => showParagraphEditor(p) }, '✎ 编辑'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (await confirmDialog('删除段落', '确定删除这个段落吗？')) {
            await db.deleteParagraph(p.id);
            nav(`#/read/${p.chapterId}`);
          }
        },
      }, '🗑 删除'),
    ),
  );

  const prev = paras[idx - 1], next = paras[idx + 1];
  const navBtns = el('div', { class: 'row-btns detail-nav-btns' },
    prev ? el('button', { class: 'btn big', onclick: () => nav(`#/para/${prev.id}`) }, '← 上一段') : null,
    next ? el('button', { class: 'btn big primary', onclick: () => nav(`#/para/${next.id}`) }, '下一段 →') : null,
  );

  v.append(card, navBtns);
}

// ---------------------------------------------------------------------------
// 文本导入：粘贴豆包等外部 App 识别的高精度文本，按段号切分入库
// ---------------------------------------------------------------------------
function showImportTextModal(chapterId) {
  const textarea = el('textarea', {
    class: 'input', rows: '12',
    placeholder: '粘贴豆包等 App 识别出的书页文本…\n每行一段；行首四位数字会识别为段号',
  });
  showModal('导入文本',
    el('div', { class: 'import-form' },
      el('p', { class: 'muted' }, '外部识别的准确率通常更高，粘贴后自动按段号切分为段落。可以多次导入，自动续接。'),
      textarea,
    ),
    [
      {
        label: '导入', class: 'primary',
        onclick: async (o) => {
          const text = textarea.value.trim();
          if (!text) { toast('请先粘贴文本'); return; }
          try {
            const r = await importChapterText(chapterId, text);
            o.remove();
            toast(r.merged ? '已拼接到未闭合段落' : `已导入 ${r.count} 个段落`);
            route();
          } catch (err) {
            toast('导入失败：' + err.message);
          }
        },
      },
      { label: '取消', onclick: (o) => o.remove() },
    ]);
}

async function importChapterText(chapterId, text) {
  const lines = text.split(/\r?\n/).map((t) => ({ text: t }));
  const page = parser.parsePage(lines);
  const segs = page.segments.map((s) => ({ ...s }));
  let leading = page.leadingText;
  let merged = false;

  // 跨页续接逻辑与扫描入库一致
  const pendingP = await db.getPendingParagraph(chapterId);
  if (pendingP) {
    if (leading) {
      await db.updateParagraph(pendingP.id, { text: parser.joinText(pendingP.text, leading) });
      leading = '';
      merged = true;
    }
    if (segs.length) await db.updateParagraph(pendingP.id, { pending: false });
  } else if (leading && segs.length) {
    segs[0].text = parser.joinText(leading, segs[0].text);
    leading = '';
  }

  if (segs.length) {
    await db.addParagraphs(chapterId, segs.map((s, i) => ({
      type: 'text', number: s.number, text: s.text, pending: i === segs.length - 1,
    })));
  } else if (leading) {
    await db.addParagraphs(chapterId, [{ type: 'text', number: null, text: leading, pending: true }]);
  }
  return { count: segs.length, merged };
}

function showParagraphEditor(p) {
  const textarea = el('textarea', { class: 'input', rows: '6' });
  textarea.value = p.text;
  const numInput = el('input', { class: 'input num-input', maxlength: '4', placeholder: '段号' });
  numInput.value = p.number || '';
  showModal('编辑段落',
    el('div', { class: 'edit-form' },
      el('label', {}, '段号'),
      numInput,
      el('label', {}, '正文'),
      textarea,
    ),
    [
      {
        label: '删除段落', class: 'danger',
        onclick: async (o) => {
          if (await confirmDialog('删除段落', '确定删除这个段落吗？')) {
            await db.deleteParagraph(p.id);
            o.remove();
            nav(`#/read/${p.chapterId}`);
          }
        },
      },
      {
        label: '保存', class: 'primary',
        onclick: async (o) => {
          const number = numInput.value.trim();
          if (number && !/^\d{4}$/.test(parser.fixDigits(number))) { toast('段号应为四位数字'); return; }
          await db.updateParagraph(p.id, {
            text: textarea.value,
            number: number ? parser.fixDigits(number) : null,
          });
          o.remove();
          route();
        },
      },
      { label: '取消', onclick: (o) => o.remove() },
    ]);
}

async function toggleSpeak(p, voice, paraNode, speakBtn) {
  const text = parser.stripSpeech(p.text);
  if (!text) { toast('本段没有可朗读的文字'); return; }
  if (!tts.ttsSupported()) { toast('当前浏览器不支持语音朗读'); return; }
  if (speakBtn.dataset.on === '1') { // 正在朗读 → 停止
    tts.stop();
    return;
  }
  if (!voice) { toast('没有可用语音，请在设置中检查'); return; }
  paraNode.classList.add('speaking');
  speakBtn.dataset.on = '1';
  speakBtn.textContent = '■ 停止';
  const done = () => {
    paraNode.classList.remove('speaking');
    speakBtn.dataset.on = '';
    speakBtn.textContent = '▶ 朗读';
  };
  tts.speak(text, { voice, rate: settings.rate, onend: done });
}

// ---------------------------------------------------------------------------
// 扫描（拍照 / 相册 / PDF，连续识别 + 跨页合并）
// ---------------------------------------------------------------------------
const scan = {
  chapterId: null,
  chapter: null,
  book: null,
  mode: 'photo',           // 'photo' | 'pdf'
  pdf: null,               // { doc, numPages, pageIndex }
  stage: 'idle',           // idle → preview → recognizing → editing
  pageData: null,          // 识别结果 { segments, leadingText }（编辑中副本）
  pageCount: 0,
  busy: false,
  cancelFast: false,
};

async function renderScan(chapterId) {
  const chapter = await db.getChapter(chapterId);
  if (!chapter) { nav('#/'); return; }
  if (scan.chapterId !== chapterId) {
    // 切换章节时才重置会话状态（同章节往返保留 PDF / 编辑中数据）
    Object.assign(scan, {
      mode: 'photo', pdf: null, stage: 'idle',
      pageData: null, pageDataUrl: null,
      busy: false, cancelFast: false, pageCount: 0, pageIndexLabel: null,
    });
  }
  scan.chapterId = chapterId;
  scan.chapter = chapter;
  scan.book = await db.getBook(chapter.bookId);
  drawScanView();
}

function drawScanView() {
  const { chapter, book } = scan;
  setHeader(`${book ? book.title + ' · ' : ''}${chapter ? chapter.title : '扫描'}`, true);
  setBottomNav(null);
  const v = view();
  v.innerHTML = '';
  const wrap = el('div', { class: 'scan-wrap' });
  v.append(wrap);

  wrap.append(el('p', { class: 'muted scan-tip' }, `本会话已处理 ${scan.pageCount} 页`));

  if (scan.stage === 'idle') drawScanIdle(wrap);
  else if (scan.stage === 'preview') drawScanPreview(wrap);
  else if (scan.stage === 'recognizing') drawScanRecognizing(wrap, scan.progressText || '正在准备识别…', scan.progress || 0);
  else if (scan.stage === 'editing') drawScanEditing(wrap);
}

function drawScanIdle(wrap) {
  const cameraInput = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none', id: 'camera-input',
  });
  const galleryInput = el('input', {
    type: 'file', accept: 'image/*', style: 'display:none', id: 'gallery-input',
  });
  const pdfInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none', id: 'pdf-input' });
  wrap.append(cameraInput, galleryInput, pdfInput);

  const onImg = (input) => () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) handlePhotoFile(f);
  };
  cameraInput.addEventListener('change', onImg(cameraInput));
  galleryInput.addEventListener('change', onImg(galleryInput));
  pdfInput.addEventListener('change', () => {
    const f = pdfInput.files?.[0];
    pdfInput.value = '';
    if (f) handlePdfFile(f);
  });

  wrap.append(el('div', { class: 'card scan-actions' },
    el('button', { class: 'btn primary big', onclick: () => cameraInput.click() }, '📷 拍摄书页'),
    el('button', { class: 'btn big', onclick: () => galleryInput.click() }, '🖼 从相册选择'),
    el('button', { class: 'btn big', onclick: () => pdfInput.click() }, '📄 从 PDF 导入'),
  ));

  if (scan.pdf) {
    // PDF 已加载：提供继续/快速导入入口
    wrap.append(el('div', { class: 'card scan-actions' },
      el('p', { class: 'muted' }, `PDF 已加载：共 ${scan.pdf.numPages} 页，下一页 ${Math.min(scan.pdf.pageIndex, scan.pdf.numPages)}`),
      el('div', { class: 'row-btns' },
        el('button', { class: 'btn primary', onclick: () => renderCurrentPdfPage() }, '继续处理下一页'),
        el('button', { class: 'btn', onclick: () => fastImportRemaining() }, '⚡ 快速导入全部剩余页'),
      ),
    ));
  } else {
    const pending = el('p', { class: 'muted' });
    db.getPendingParagraph(scan.chapterId).then((p) => {
      if (p) pending.textContent = '上一页最后一段尚未闭合，本页开头的续文会自动拼接到该段。';
    });
    wrap.append(pending);
  }
}

async function handlePhotoFile(file) {
  if (scan.busy) return;
  scan.busy = true;
  try {
    const { dataUrl } = await ocr.compressImage(file);
    scan.pageDataUrl = dataUrl;
    scan.mode = 'photo';
    scan.pageIndexLabel = null;
    scan.stage = 'preview';
    drawScanView();
  } catch (err) {
    toast('图片处理失败：' + err.message);
  }
  scan.busy = false;
}

async function handlePdfFile(file) {
  if (scan.busy) return;
  scan.busy = true;
  try {
    const { doc, numPages } = await pdfimport.loadPdf(file);
    scan.pdf = { doc, numPages, pageIndex: 1 };
    scan.mode = 'pdf';
    await renderCurrentPdfPage();
  } catch (err) {
    toast('PDF 加载失败：' + (err.message || '文件可能已加密或损坏'));
  }
  scan.busy = false;
}

async function renderCurrentPdfPage() {
  const { doc, pageIndex, numPages } = scan.pdf;
  const { dataUrl } = await pdfimport.renderPdfPage(doc, pageIndex);
  scan.pageDataUrl = dataUrl;
  scan.pageIndexLabel = `PDF 第 ${pageIndex} / ${numPages} 页`;
  scan.stage = 'preview';
  drawScanView();
}

function drawScanPreview(wrap) {
  if (scan.pageIndexLabel) {
    wrap.append(el('p', { class: 'muted' }, scan.pageIndexLabel));
  }
  wrap.append(el('div', { class: 'preview-box' }, el('img', { class: 'preview-img', src: scan.pageDataUrl, alt: '书页预览' })));
  wrap.append(el('div', { class: 'row-btns' },
    el('button', {
      class: 'btn primary big',
      onclick: () => startRecognize(),
    }, '🔍 开始识别'),
    el('button', {
      class: 'btn big',
      onclick: async () => {
        scan.stage = 'idle';
        if (scan.mode === 'pdf') {
          if (scan.pdf.pageIndex < scan.pdf.numPages) { scan.pdf.pageIndex += 1; await renderCurrentPdfPage(); return; }
        }
        drawScanView();
      },
    }, scan.mode === 'pdf' ? '跳过此页' : '重新选择'),
    el('button', { class: 'btn big', onclick: () => finishScan(false) }, '结束扫描'),
  ));
}

async function startRecognize() {
  scan.stage = 'recognizing';
  scan.progressText = '正在加载识别引擎…';
  scan.progress = 0;
  drawScanView();
  try {
    const rec = await ocr.recognizeImage(scan.pageDataUrl, (status, progress) => {
      const map = {
        'loading tesseract core': '加载识别引擎…',
        'initializing tesseract': '初始化引擎…',
        'loading language traineddata': '加载高精度中文模型…',
        'initializing api': '初始化接口…',
        'recognizing text': '识别文字中…',
      };
      scan.progressText = map[status] || status;
      scan.progress = progress;
      const bar = $('#ocr-progress-bar');
      const label = $('#ocr-progress-text');
      if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
      if (label) label.textContent = scan.progressText;
    });
    const page = parser.parsePage(rec.lines);
    scan.pageData = {
      segments: page.segments.map((s) => ({ ...s })),
      leadingText: page.leadingText,
    };
    scan.stage = 'editing';
    drawScanView();
  } catch (err) {
    console.error(err);
    toast('识别失败：' + (err.message || '请重试'));
    scan.stage = 'preview';
    drawScanView();
  }
}

function drawScanRecognizing(wrap, text, progress) {
  wrap.append(el('div', { class: 'card recognizing-card' },
    el('p', { id: 'ocr-progress-text' }, text),
    el('div', { class: 'progress-track' }, el('div', { id: 'ocr-progress-bar', class: 'progress-bar', style: `width:${Math.round(progress * 100)}%` })),
    el('p', { class: 'muted' }, '高精度模型识别较慢，密排书页约需 1~2 分钟，请勿锁屏'),
  ));
}

function drawScanEditing(wrap) {
  const { pageData } = scan;

  const editArea = el('div', { class: 'seg-edit-list' });

  // 页首续文（跨页合并预览）
  if (pageData.leadingText) {
    const lead = el('textarea', { class: 'input', rows: '2', id: 'lead-text' });
    lead.value = pageData.leadingText;
    editArea.append(el('div', { class: 'card lead-card' },
      el('h4', {}, '本页开头（无段号文字）'),
      el('p', { class: 'muted' }, '这些文字会自动拼接到上一页最后一段'),
      lead,
    ));
    db.getPendingParagraph(scan.chapterId).then((p) => {
      if (!p) {
        editArea.querySelector('.lead-card .muted').textContent =
          '没有未闭合段落，这些文字将并入本页第一段';
      }
    });
  }

  // 段落编辑
  if (!pageData.segments.length) {
    editArea.append(el('div', { class: 'empty-hint' }, '本页没有识别到段号。若整页都是上一段的续文，直接保存即可。'));
  }
  pageData.segments.forEach((seg, i) => {
    const numInput = el('input', { class: 'input seg-num', value: seg.number, maxlength: '4' });
    const textarea = el('textarea', { class: 'input', rows: '4' });
    textarea.value = seg.text;
    numInput.addEventListener('change', () => {
      const fixed = parser.fixDigits(numInput.value.trim());
      if (/^\d{4}$/.test(fixed)) { seg.number = fixed; numInput.value = fixed; }
      else toast('段号需为四位数字');
    });
    textarea.addEventListener('input', () => { seg.text = textarea.value; });
    editArea.append(el('div', { class: 'card seg-card' },
      el('div', { class: 'seg-head' },
        el('label', {}, '段号'), numInput,
        el('button', {
          class: 'icon-btn danger', 'aria-label': '删除此段',
          onclick: (e) => {
            const idx = pageData.segments.indexOf(seg); // 以对象定位，避免删除后索引错位
            if (idx > -1) pageData.segments.splice(idx, 1);
            e.currentTarget.closest('.seg-card').remove();
          },
        }, '✕'),
      ),
      textarea,
    ));
  });

  editArea.append(el('button', {
    class: 'btn small add-seg-btn',
    onclick: () => {
      pageData.segments.push({ number: '', text: '', y0: Infinity, y1: Infinity });
      drawScanView();
    },
  }, '＋ 手动添加一段'));

  wrap.append(
    el('h3', { class: 'section-title' }, '识别结果（可修正）'),
    editArea,
    el('div', { class: 'row-btns scan-save-btns' },
      el('button', { class: 'btn primary big', onclick: () => saveAndNext() }, '✔ 保存并继续下一页'),
      el('button', { class: 'btn big', onclick: () => finishScan(true) }, '💾 保存并结束'),
      el('button', { class: 'btn big', onclick: () => { scan.stage = 'idle'; drawScanView(); } }, '放弃本页'),
    ),
  );
}

// 保存当前页（编辑后的数据）→ 下一页
async function saveAndNext() {
  if (scan.busy) return;
  scan.busy = true;
  try {
    await saveCurrentPage();
    scan.pageCount += 1;
    scan.pageData = null;
    scan.stage = 'idle';
    if (scan.mode === 'pdf') {
      if (scan.pdf.pageIndex < scan.pdf.numPages) {
        scan.pdf.pageIndex += 1;
        await renderCurrentPdfPage();
      } else {
        toast('PDF 已到最后一页');
        await finishScanInternal(false);
        return;
      }
    } else {
      drawScanView();
    }
  } catch (err) {
    console.error(err);
    toast('保存失败：' + err.message);
    drawScanView();
  } finally {
    scan.busy = false;
  }
}

async function finishScan(saveFirst) {
  if (saveFirst) {
    if (scan.busy) return;
    scan.busy = true;
    try {
      await saveCurrentPage();
      scan.pageCount += 1;
    } catch (err) {
      toast('保存失败：' + err.message);
      return;
    } finally {
      scan.busy = false;
    }
  }
  await finishScanInternal(true);
}

async function finishScanInternal(navigateBack) {
  await db.closePending(scan.chapterId);
  scan.stage = 'idle';
  scan.pdf = null;
  scan.pageData = null;
  if (navigateBack) nav(`#/read/${scan.chapterId}`);
  else drawScanView();
}

// 当前页入库核心逻辑（也被快速导入复用）
async function saveCurrentPage() {
  const chapterId = scan.chapterId;
  const pageData = scan.pageData;
  if (!pageData) return;

  const leadEl = $('#lead-text');
  let leadingText = leadEl ? leadEl.value.trim() : (pageData.leadingText || '');
  const segments = pageData.segments
    .map((s) => ({ ...s, number: s.number ? parser.fixDigits(s.number) : null }))
    .filter((s) => s.text.trim() || s.number);

  const pendingP = await db.getPendingParagraph(chapterId);

  // 1) 跨页合并
  if (pendingP) {
    if (leadingText) {
      await db.updateParagraph(pendingP.id, { text: parser.joinText(pendingP.text, leadingText) });
      leadingText = '';
    }
    if (segments.length) await db.updateParagraph(pendingP.id, { pending: false });
  } else if (leadingText && segments.length) {
    // 无 pending：并入本页第一段
    segments[0].text = parser.joinText(leadingText, segments[0].text);
    leadingText = '';
  }

  // 2) 文本段入库（最后一段 pending）
  let created = [];
  if (segments.length) {
    created = await db.addParagraphs(chapterId, segments.map((s, i) => ({
      type: 'text', number: s.number, text: s.text, pending: i === segments.length - 1,
    })));
  } else if (leadingText) {
    created = await db.addParagraphs(chapterId, [{ type: 'text', number: null, text: leadingText, pending: true }]);
  }
}

// PDF 快速导入（自动处理剩余页，不逐页编辑；复用 saveCurrentPage 入库逻辑）
async function fastImportRemaining() {
  if (scan.busy || !scan.pdf) return;
  scan.busy = true;
  scan.cancelFast = false;
  const total = scan.pdf.numPages - scan.pdf.pageIndex + 1;
  let done = 0, errors = 0;

  const progressCard = el('div', { class: 'card recognizing-card' },
    el('p', { id: 'fast-text' }, '准备快速导入…'),
    el('div', { class: 'progress-track' }, el('div', { id: 'fast-bar', class: 'progress-bar', style: 'width:0%' })),
    el('button', { class: 'btn small', onclick: () => { scan.cancelFast = true; } }, '取消'),
  );
  view().prepend(progressCard);

  try {
    for (let i = scan.pdf.pageIndex; i <= scan.pdf.numPages; i++) {
      if (scan.cancelFast) break;
      const label = $('#fast-text');
      if (label) label.textContent = `快速导入：第 ${i} / ${scan.pdf.numPages} 页`;
      try {
        const { dataUrl } = await pdfimport.renderPdfPage(scan.pdf.doc, i);
        scan.pageDataUrl = dataUrl;
        const rec = await ocr.recognizeImage(dataUrl);
        const page = parser.parsePage(rec.lines);
        scan.pageData = {
          segments: page.segments.map((s) => ({ ...s })),
          leadingText: page.leadingText,
        };
        await saveCurrentPage();
        scan.pdf.pageIndex = i + 1;
        done += 1;
      } catch (err) {
        console.error('页处理失败', i, err);
        errors += 1;
      }
      const bar = $('#fast-bar');
      if (bar) bar.style.width = `${Math.round((done + errors) / total * 100)}%`;
    }
    await db.closePending(scan.chapterId);
    toast(`快速导入完成：成功 ${done} 页${errors ? `，失败 ${errors} 页` : ''}`);
  } finally {
    scan.busy = false;
    scan.stage = 'idle';
    scan.pdf = null;
  }
  nav(`#/read/${scan.chapterId}`);
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
async function renderSettings() {
  setHeader('设置');
  setBottomNav('settings');
  const v = view();
  v.innerHTML = '';

  const voiceList = await tts.getVoices();
  const voiceSel = el('select', { class: 'input' });
  if (!voiceList.length) {
    voiceSel.append(el('option', {}, '（未检测到可用语音）'));
  } else {
    for (const voice of voiceList) {
      const opt = el('option', { value: voice.voiceURI }, `${voice.name}（${voice.lang}）`);
      voiceSel.append(opt);
    }
  }
  const saved = await currentVoice(voiceList);
  if (saved) voiceSel.value = saved.voiceURI;
  voiceSel.addEventListener('change', () => { settings.voiceURI = voiceSel.value; toast('语音已保存'); });

  const rateInput = el('input', { type: 'range', class: 'rate-slider', min: '0.5', max: '2', step: '0.1', value: String(settings.rate) });
  const rateLabel = el('span', { class: 'muted' }, `当前 ${settings.rate.toFixed(1)}x`);
  rateInput.addEventListener('input', () => {
    settings.rate = parseFloat(rateInput.value);
    rateLabel.textContent = `当前 ${settings.rate.toFixed(1)}x`;
  });

  const testBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      const voice = await currentVoice();
      tts.speak('你好，这是一段朗读测试。', { voice, rate: settings.rate });
    },
  }, '▶ 试听语音');

  v.append(el('div', { class: 'card settings-card' },
    el('h3', {}, '朗读'),
    el('label', {}, '朗读语音'),
    voiceSel,
    el('div', { class: 'rate-row' }, el('label', {}, '语速'), rateInput, rateLabel),
    testBtn,
    !tts.ttsSupported() ? el('p', { class: 'warn' }, '当前浏览器不支持语音合成') : null,
  ));

  const exportBtn = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        const data = await db.exportData();
        const json = JSON.stringify(data);
        const a = el('a', {
          href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
          download: `剧情书备份-${new Date().toISOString().slice(0, 10)}.json`,
        });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (err) { toast('导出失败：' + err.message); }
    },
  }, '⬇ 导出全部数据（JSON）');

  const importInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!(await confirmDialog('导入数据', '导入将清空并替换当前全部书籍数据，确定继续吗？'))) return;
      await db.importData(data);
      toast('导入完成');
      nav('#/');
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  });
  const importBtn = el('button', { class: 'btn', onclick: () => importInput.click() }, '⬆ 导入数据');

  v.append(el('div', { class: 'card settings-card' },
    el('h3', {}, '数据'),
    exportBtn, importBtn, importInput,
    el('p', { class: 'muted' }, '数据保存在本机浏览器中，建议定期导出备份'),
  ));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 离线缓存失败不影响使用 */ });
  }
  if (!('indexedDB' in window)) {
    setHeader('无法使用');
    view().innerHTML = '<div class="empty-hint">当前浏览器（可能是隐私模式）不支持本地存储，无法保存扫描内容。</div>';
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

init();

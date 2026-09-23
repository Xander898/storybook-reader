// tts.js — Web Speech API 朗读封装
// 移动端浏览器的 speechSynthesis.pause() 普遍不可靠（点了之后往往仍在播放），
// 因此朗读采用「按句分块顺序播放」：
//   暂停 = cancel 当前句并记住位置；继续 = 从该句开头重读；停止 = 清空队列。
// 只依赖 speak / cancel 两个各平台都可靠的 API，暂停粒度为一句（几秒），可接受。
let cachedVoices = [];

export function getVoices() {
  return new Promise((resolve) => {
    if (cachedVoices.length) { resolve(cachedVoices); return; }
    const got = () => {
      const v = speechSynthesis.getVoices();
      if (v.length) { cachedVoices = v; resolve(v); return true; }
      return false;
    };
    if (got()) return;
    let done = false;
    speechSynthesis.addEventListener('voiceschanged', () => {
      if (!done && got()) done = true;
    }, { once: false });
    // 兜底：某些浏览器不触发 voiceschanged
    setTimeout(() => { if (!done) { done = true; resolve(speechSynthesis.getVoices()); } }, 2000);
  });
}

export function ttsSupported() {
  return 'speechSynthesis' in window;
}

/** 中文语音优先：zh-CN > zh-* > 任意 */
export function pickDefaultVoice(voices) {
  const zhCN = voices.find((v) => v.lang === 'zh-CN' || v.lang === 'zh_CN');
  if (zhCN) return zhCN;
  const zh = voices.find((v) => /^zh/i.test(v.lang));
  if (zh) return zh;
  return voices[0] ?? null;
}

// ---------------------------------------------------------------------------
// 分块顺序播放
// ---------------------------------------------------------------------------
let chunks = [];        // 按句切分的文本块
let chunkIndex = 0;     // 当前播放到第几块
let qVoice = null, qRate = 1, qPitch = 1;
let qActive = false;    // 播放会话存在（朗读中或已暂停）
let qPaused = false;
let qOnend = null;      // 整段播完 / 被停止时的回调
let uttGen = 0;         // 代际计数：pause/stop/resume 时递增，使旧 utterance 的回调失效（防竞态）

// 按句末标点切句，一句一块（暂停粒度 = 一句话）；仅相邻极短碎片才合并，避免间隙过多
function splitIntoChunks(text, minLen = 12) {
  const re = /[^。！？!?；;…\n]*[。！？!?；;…\n]+|[^。！？!?；;…\n]+/g;
  const raw = [];
  let m;
  while ((m = re.exec(text)) !== null) if (m[0]) raw.push(m[0]);
  const out = [];
  let cur = '';
  for (const s of raw) {
    if (cur && (cur.length >= 50 || (cur.length >= minLen && s.length >= minLen))) { out.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

function speakCurrent() {
  if (!qActive || qPaused) return;
  if (chunkIndex >= chunks.length) {
    qActive = false;
    const cb = qOnend;
    qOnend = null; chunks = [];
    if (cb) cb(); // 全部读完
    return;
  }
  const myGen = ++uttGen;
  const u = new SpeechSynthesisUtterance(chunks[chunkIndex]);
  if (qVoice) { u.voice = qVoice; u.lang = qVoice.lang; } else u.lang = 'zh-CN';
  u.rate = qRate;
  u.pitch = qPitch;
  u.onend = () => { if (myGen !== uttGen || !qActive) return; chunkIndex += 1; speakCurrent(); };
  u.onerror = () => { if (myGen !== uttGen || !qActive) return; chunkIndex += 1; speakCurrent(); };
  speechSynthesis.speak(u);
}

/**
 * 朗读文本。options: { voice, rate, pitch, onend }
 */
export function speak(text, options = {}) {
  if (!ttsSupported()) return false;
  stop();
  if (!text) return false;
  chunks = splitIntoChunks(text);
  if (!chunks.length) return false;
  chunkIndex = 0;
  qVoice = options.voice || null;
  qRate = options.rate ?? 1;
  qPitch = options.pitch ?? 1;
  qOnend = options.onend ?? null;
  qActive = true;
  qPaused = false;
  // 稍等 cancel 生效，规避部分浏览器 speak-after-cancel 静音的 bug
  setTimeout(speakCurrent, 80);
  return true;
}

/** 停止并清空进度（下次朗读从头开始） */
export function stop() {
  if (!ttsSupported()) return;
  const cb = qOnend;
  uttGen += 1;
  qActive = false; qPaused = false;
  chunks = []; chunkIndex = 0; qOnend = null;
  speechSynthesis.cancel();
  if (cb) cb(); // 主动停止时也要触发结束回调（清除高亮）
}

/** 暂停：取消当前句，记住位置 */
export function pause() {
  if (!ttsSupported() || !qActive || qPaused) return;
  qPaused = true;
  uttGen += 1;              // 当前句被 cancel 后触发的 onend 不再推进进度
  speechSynthesis.cancel();
}

/** 继续：从暂停所在的那一句开头重读 */
export function resume() {
  if (!ttsSupported() || !qActive || !qPaused) return;
  qPaused = false;
  setTimeout(speakCurrent, 80);
}

export function paused() { return qActive && qPaused; }
export function speaking() { return qActive && !qPaused; }

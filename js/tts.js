// tts.js — Web Speech API 朗读封装
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

let onEndCallback = null;

/**
 * 朗读文本。options: { voice, rate, onend }
 */
export function speak(text, options = {}) {
  if (!ttsSupported()) return false;
  stop();
  if (!text) return false;
  const u = new SpeechSynthesisUtterance(text);
  if (options.voice) { u.voice = options.voice; u.lang = options.voice.lang; }
  else u.lang = 'zh-CN';
  u.rate = options.rate ?? 1;
  u.pitch = options.pitch ?? 1;
  onEndCallback = options.onend ?? null;
  u.onend = () => { const cb = onEndCallback; onEndCallback = null; if (cb) cb(); };
  u.onerror = () => { const cb = onEndCallback; onEndCallback = null; if (cb) cb(); };
  speechSynthesis.speak(u);
  return true;
}

export function stop() {
  if (!ttsSupported()) return;
  const cb = onEndCallback;
  onEndCallback = null;
  speechSynthesis.cancel();
  if (cb) cb(); // 主动停止时也要触发结束回调（清除高亮）
}

export function speaking() {
  return ttsSupported() && speechSynthesis.speaking && !speechSynthesis.paused;
}

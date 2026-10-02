// cloudtts.js — 豆包云端语音合成（火山方舟语音模型，浏览器直连）
// 与豆包识别共用方舟 API Key。走 HTTP 非流式接口：一次请求一句话，返回 MP3 分片。
// 播放策略：按句合成 + <audio> 顺序播放，边播边预合成下一句，减少句间停顿；
// 暂停/继续是真断点（保留 MP3 播放进度），比浏览器内置引擎的整句重读更自然。
import { splitIntoChunks } from './tts.js';

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
const RESOURCE_ID = 'seed-tts-2.0'; // 豆包语音合成 2.0 音色对应此资源 ID

// 精选 2.0 音色（resource_id: seed-tts-2.0），首个为默认
export const CLOUD_VOICES = [
  { id: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声 · 长文朗读' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 · 通用女声' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi · 情感女声' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩' },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 · 通用男声' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 · 年轻男声' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛' },
];
export const DEFAULT_CLOUD_VOICE = CLOUD_VOICES[0].id;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// base64 → 字节（每个分片单独解码再拼字节；直接拼接 base64 字符串会因填充位错位产生乱码）
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 合成一句文本 → MP3 Blob。失败抛错（含可读原因）。 */
export async function synthesize(text, { apiKey, speaker, rate = 1 }) {
  const audioParams = { format: 'mp3', sample_rate: 24000 };
  // 语速映射为接口的 1~10 档（5 = 正常）；正常语速时不传，走服务端默认
  if (rate && rate !== 1) audioParams.speech_rate = Math.max(1, Math.min(10, Math.round(rate * 5)));
  let resp;
  try {
    resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Connect-Id': uuid(),
      },
      body: JSON.stringify({
        user: { uid: 'sb-reader' },
        req_params: {
          text,
          speaker: speaker || DEFAULT_CLOUD_VOICE,
          audio_params: audioParams,
        },
      }),
    });
  } catch {
    throw new Error('网络请求失败（无网络、信号弱或跨域被拦截），请稍后重试');
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 160); } catch { /* 忽略 */ }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('API Key 无效或未开通豆包语音模型（seed-tts-2.0），请在方舟控制台检查权限');
    }
    throw new Error(`HTTP ${resp.status}${detail ? '：' + detail : ''}`);
  }
  let body;
  try { body = await resp.text(); }
  catch { throw new Error('接收音频数据中断，请稍后重试'); }
  const parts = [];
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.code === 0 && o.data) parts.push(b64ToBytes(o.data));
    else if (o.code != null && o.code !== 0 && o.code !== 20000000) {
      throw new Error(o.message || ('错误码 ' + o.code));
    }
  }
  if (!parts.length) throw new Error('云端未返回音频');
  let total = 0;
  for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return new Blob([bytes], { type: 'audio/mpeg' });
}

// ---------------------------------------------------------------------------
// iOS 解锁：部分浏览器要求首次播放在用户手势内触发，
// 否则后续异步 play() 会被自动播放策略拦截。手势内先播一段 50ms 静音。
// ---------------------------------------------------------------------------
const SILENT_WAV = (() => {
  const sr = 8000, n = Math.floor(sr * 0.05); // 50ms 静音
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  w(36, 'data'); dv.setUint32(40, n, true);
  let bin = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
})();

function unlockAudio() {
  const a = new Audio(SILENT_WAV);
  a.play().then(() => { a.pause(); a.src = ''; }).catch(() => { /* 已解锁或被忽略均无碍 */ });
}

// ---------------------------------------------------------------------------
// 队列播放器：合成第 i 句 → 播放，同时预合成第 i+1 句
// ---------------------------------------------------------------------------
let qGen = 0;            // 代际计数：stop/fail 后旧会话的所有回调失效
let qSentences = [];
let qIdx = 0;
let qAudio = null;        // 当前 <audio>
let qUrls = [];           // blob URL，播完统一回收
let qPrefetch = null;      // 下一句的合成 Promise
let qOpts = null;
let qActive = false;
let qPaused = false;

function cleanup() {
  if (qAudio) { qAudio.pause(); qAudio.onended = null; qAudio.onerror = null; qAudio.src = ''; qAudio = null; }
  for (const u of qUrls) URL.revokeObjectURL(u);
  qUrls = [];
  qPrefetch = null;
}

/** 复位会话；fire=true 时触发调用方的 onend（用户主动停止），否则静默（被新朗读覆盖） */
function resetSession(fire) {
  qGen += 1;
  const opts = qOpts;
  qActive = false; qPaused = false;
  qSentences = []; qIdx = 0;
  cleanup();
  qOpts = null;
  if (fire && opts && opts.onend) opts.onend();
}

function failSession(msg) {
  qGen += 1;
  qActive = false; qPaused = false;
  qSentences = []; qIdx = 0;
  cleanup();
  const cb = qOpts && qOpts.onerror;
  qOpts = null;
  if (cb) cb(msg);
}

async function fetchSentence(gen, i) {
  const blob = await synthesize(qSentences[i], qOpts);
  if (gen !== qGen) throw new Error('会话已结束');
  const url = URL.createObjectURL(blob);
  qUrls.push(url);
  return url;
}

function waitIfPaused(gen) {
  return new Promise((resolve) => {
    const tick = () => {
      if (gen !== qGen || !qActive || !qPaused) resolve();
      else setTimeout(tick, 120);
    };
    tick();
  });
}

async function playSentence(gen) {
  if (gen !== qGen || !qActive) return;
  await waitIfPaused(gen);
  if (gen !== qGen || !qActive) return;

  let url = null;
  if (qPrefetch) {
    url = await qPrefetch; // 预合成失败时返回 null，走现场重试
    qPrefetch = null;
  }
  if (gen !== qGen || !qActive) return;
  if (!url) {
    try { url = await fetchSentence(gen, qIdx); }
    catch (err) { if (gen === qGen) failSession(err.message); return; }
  }
  if (gen !== qGen || !qActive) return;

  // 边播边预合成下一句，缩短句间停顿
  if (qIdx + 1 < qSentences.length) qPrefetch = fetchSentence(gen, qIdx + 1).catch(() => null);

  const audio = new Audio(url);
  qAudio = audio;
  try { await audio.play(); }
  catch {
    if (gen === qGen && qActive) failSession('音频播放被浏览器拦截，请重试');
    return;
  }
  if (gen !== qGen || !qActive) return;

  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve; // 解码异常按播完处理，避免卡死
  });
  if (gen !== qGen || !qActive) return;

  qIdx += 1;
  if (qIdx < qSentences.length) playSentence(gen);
  else resetSession(true); // 全部读完，正常触发 onend
}

/**
 * 云端朗读整段文本。options: { apiKey, speaker, rate, onend, onerror }
 * onend：读完或被停止时触发；onerror：合成/播放失败时触发（含可读原因）。
 */
export function cloudSpeak(text, options = {}) {
  if (!options.apiKey) { if (options.onerror) options.onerror('未配置 API Key'); return false; }
  resetSession(false); // 被新朗读覆盖的旧会话静默结束，不触发其 onend
  const sentences = splitIntoChunks(text);
  if (!sentences.length) return false;
  unlockAudio(); // 必须在用户手势的同步调用链内执行
  qGen += 1;
  const gen = qGen;
  qSentences = sentences; qIdx = 0;
  qOpts = options;
  qActive = true; qPaused = false;
  playSentence(gen);
  return true;
}

/** 停止并清空进度（触发 onend） */
export function cloudStop() {
  if (!qActive && !qOpts) return;
  resetSession(true);
}

/** 暂停：保留当前句播放进度（真断点） */
export function cloudPause() {
  if (!qActive || qPaused) return;
  qPaused = true;
  if (qAudio) qAudio.pause();
}

/** 从暂停处继续播放 */
export function cloudResume() {
  if (!qActive || !qPaused) return;
  qPaused = false;
  if (qAudio) qAudio.play().catch(() => { /* 系统瞬时占用，忽略 */ });
}

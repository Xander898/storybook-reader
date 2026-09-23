// ---------------------------------------------------------------------------
// 云端识别：豆包（火山方舟 doubao-1.5-vision-pro）
// 浏览器不能直连方舟 API（无 CORS），经 IGA Pages 部署的 api/ocr.js 代理转发。
// API Key 只保存在本机 localStorage，随请求发给代理，代理不落盘。
// ---------------------------------------------------------------------------

// 代理地址（部署在 IGA Pages，与本站分离——GitHub Pages 无法承载 API 函数）
const PROXY_URL = 'https://storybook-ocr.iga.pages.dev/api/ocr';

const TRANSCRIBE_PROMPT = [
  '请逐字转录这张书页图片中的全部正文文字，要求：',
  '1. 按阅读顺序逐行转录：先左栏从上到下，再中栏，再右栏；',
  '2. 严格原样转录每一个字，不要纠正错别字、不要改写、不要缩写、不要跳过任何内容；',
  '3. 行首的四位数字段号（如 0001）必须原样保留，独占一行；',
  '4. 忽略页眉、页脚、页码和图片；',
  '5. 中文标点使用全角形式；',
  '6. 只输出转录的正文，不要任何解释、注释或代码块标记。',
].join('\n');

export function getArkKey() { return localStorage.getItem('sb-ark-key') || ''; }
export function setArkKey(k) { localStorage.setItem('sb-ark-key', k.trim()); }
export function getModel() { return localStorage.getItem('sb-ark-model') || 'doubao-1.5-vision-pro-32k-250115'; }
export function setModel(m) { localStorage.setItem('sb-ark-model', m.trim()); }

// 云端识别用图：2048 长边足够视觉模型，且显著降低 token 消耗
async function compressForCloud(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('图片加载失败'));
    i.src = dataUrl;
  });
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

// 请求代理。onStage(stage) 用于界面提示。
export async function cloudRecognize(dataUrl, onStage) {
  const key = getArkKey();
  if (!key) throw new Error('未配置豆包 API Key，请到「设置」中填写');

  onStage && onStage('正在压缩图片…');
  const image = await compressForCloud(dataUrl);

  onStage && onStage('豆包云端识别中（约 10~30 秒）…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let resp;
  try {
    resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, image, model: getModel(), prompt: TRANSCRIBE_PROMPT }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请重试');
    throw new Error('无法连接识别服务（' + err.message + '），请检查网络');
  } finally {
    clearTimeout(timer);
  }

  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('API Key 无效或已过期，请在设置中检查');
    throw new Error((data && data.error) || `识别服务返回 ${resp.status}`);
  }

  let text = (data.text || '').trim();
  // 去掉模型偶尔包上的代码块围栏
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!text) throw new Error('云端未识别到文字，请重拍清晰一点');
  return text;
}

// 用一条最小文本请求验证 Key 有效性（不消耗图片 token）
export async function testArkKey(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key, image: null,
        model: getModel(),
        prompt: 'ping',
        ping: true,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true };
    if (resp.status === 401) return { ok: false, error: 'API Key 无效或未开通该模型' };
    return { ok: false, error: data.error || `服务返回 ${resp.status}` };
  } catch (err) {
    return { ok: false, error: '无法连接识别服务：' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

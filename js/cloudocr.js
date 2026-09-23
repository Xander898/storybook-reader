// ---------------------------------------------------------------------------
// 云端识别：豆包（火山方舟 doubao-1.5-vision-pro）
// 方舟 API 已支持 CORS（动态回显 Origin），浏览器直连，无需代理服务器。
// API Key 只保存在本机 localStorage，随请求直发火山方舟。
// ---------------------------------------------------------------------------

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

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

// 直连方舟。onStage(stage) 用于界面提示。
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
    resp = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: TRANSCRIBE_PROMPT },
          ],
        }],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请重试');
    throw new Error('无法连接火山方舟（' + err.message + '），请检查网络');
  } finally {
    clearTimeout(timer);
  }

  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error('API Key 无效或未开通该模型，请在设置中检查');
    throw new Error((data && data.error && data.error.message) || `方舟 API 返回 ${resp.status}`);
  }

  let text = (data?.choices?.[0]?.message?.content || '').trim();
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
    const resp = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true };
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'API Key 无效或未开通该模型' };
    return { ok: false, error: (data && data.error && data.error.message) || `方舟返回 ${resp.status}` };
  } catch (err) {
    return { ok: false, error: '无法连接火山方舟：' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

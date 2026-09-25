// ---------------------------------------------------------------------------
// 云端识别：豆包（火山方舟 视觉理解模型）
// 方舟 API 已支持 CORS（动态回显 Origin），浏览器直连，无需代理服务器。
// API Key 只保存在本机 localStorage，随请求直发火山方舟。
//
// 模型说明：
// 「doubao-seed-evolving」是官方快速迭代别名，始终指向最新多模态模型，
// 不会像带日期的版本号（如 doubao-1-5-vision-pro-32k-250115）那样过期下线。
// 若某个模型在当前账号未开通，会自动依次尝试下面的候选模型。
// ---------------------------------------------------------------------------

import * as db from './db.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

// 候选模型（按优先级）。第一个为稳定别名，其余为已验证可用的历史视觉模型兜底。
const DEFAULT_MODELS = [
  'doubao-seed-evolving',
  'doubao-seed-1-6-vision-250815',
  'doubao-seed-1-6-flash-250828',
  'doubao-1-5-thinking-vision-pro-250428',
];

// 转录提示词：按是否需要图标匹配动态拼接图标规则
function buildTranscribePrompt(hasIcons) {
  const lines = [
    '请逐字转录这张书页图片中的全部正文文字，要求：',
    '1. 按阅读顺序逐行转录：先左栏从上到下，再中栏，再右栏；',
    '2. 严格原样转录每一个字，不要纠正错别字、不要改写、不要缩写、不要跳过任何内容；',
    '3. 行首的段落编号必须原样保留、独占一行：四位数字段号（如 0001），以及希腊字母段号（α、Ω）和数字范围段号（如 1-2、3-4、9-10）；',
    '4. 忽略页眉、页脚、页码和整幅插图；',
    '5. 中文标点使用全角形式；',
  ];
  if (hasIcons) {
    lines.push(
      '6. 书页正文里如果出现图标/图形符号（骰子、生命、攻击、金币等非文字小图标），请对照第二张「图标库对照图」判断：若与库中某张相似，则在图标原位置输出 `〔图标：库中名称〕`；若库中没有相似项，则输出 `〔图标：简短中文描述〕`。图标必须保留在原位置，不要删除、不要跳过、不要改写成普通文字；',
      '7. 只输出转录的正文，不要任何解释、注释或代码块标记。',
    );
  } else {
    lines.push('6. 只输出转录的正文，不要任何解释、注释或代码块标记。');
  }
  return lines.join('\n');
}

export function getArkKey() { return localStorage.getItem('sb-ark-key') || ''; }
export function setArkKey(k) { localStorage.setItem('sb-ark-key', k.trim()); }

// 用户可在设置中自定义模型（可选）；未设置时使用候选列表。
export function getModel() { return localStorage.getItem('sb-ark-model') || DEFAULT_MODELS[0]; }
export function setModel(m) { localStorage.setItem('sb-ark-model', m.trim()); }

function getCandidates() {
  const custom = (localStorage.getItem('sb-ark-model') || '').trim();
  const list = custom ? [custom, ...DEFAULT_MODELS] : DEFAULT_MODELS.slice();
  return [...new Set(list)];
}

// 判断报错是否属于「模型不存在 / 未开通」，若是则换下一个候选模型重试
function isModelUnavailable(status, msg) {
  if (status === 404) return true;
  return /does not exist|not have access|not found|model.*(invalid|unavailable|decommissioned|下线)/i.test(msg || '');
}

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

// 单次请求方舟。timeoutMs 单次超时。
async function callArk(key, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

function buildBody(model, content, extra) {
  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0.1,
    ...extra,
  };
  // 新一代 seed 模型默认开启深度思考，转录任务无需思考：更快更省
  if (/^doubao-seed/.test(model)) body.thinking = { type: 'disabled' };
  return body;
}

// 把 Blob 图片加载为 Image
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

// 生成「图标库对照图」：把每张图标按网格绘制，下方标注中文名。
// 作为第二张图一并发给模型，供其视觉匹配页面图标。库为空或含坏图时降级，返回 null 表示无需附带。
export async function buildIconMontage(icons) {
  if (!icons || !icons.length) return null;
  const CELL = 128;   // 每格边长
  const LABEL = 30;   // 名称区高度
  const PAD = 12;
  const COLS = Math.min(icons.length, 5);
  const ROWS = Math.ceil(icons.length / COLS);
  const c = document.createElement('canvas');
  c.width = COLS * (CELL + PAD) + PAD;
  c.height = ROWS * (CELL + LABEL + PAD) + PAD;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (CELL + PAD);
    const y = PAD + row * (CELL + LABEL + PAD);
    try {
      const img = await blobToImage(ic.blob);
      const s = Math.min(CELL / img.width, (CELL - 8) / img.height);
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      ctx.drawImage(img, x + (CELL - w) / 2, y + (CELL - h) / 2, w, h);
    } catch (e) { /* 坏图跳过 */ }
    ctx.fillStyle = '#000';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ic.name, x + CELL / 2, y + CELL + LABEL / 2 + 7, CELL);
  }
  return c.toDataURL('image/png');
}

// 直连方舟，自动在候选模型间降级。onStage(stage) 用于界面提示。
export async function cloudRecognize(dataUrl, onStage) {
  const key = getArkKey();
  if (!key) throw new Error('未配置豆包 API Key，请到「设置」中填写');

  onStage && onStage('正在压缩图片…');
  const image = await compressForCloud(dataUrl);

  // 图标库非空时生成对照图，并启用图标匹配规则
  const icons = await db.listIcons();
  const montage = await buildIconMontage(icons);
  const content = [
    { type: 'image_url', image_url: { url: image } },
  ];
  if (montage) content.push({ type: 'image_url', image_url: { url: montage } });
  content.push({ type: 'text', text: buildTranscribePrompt(!!montage) });

  const candidates = getCandidates();
  let lastErr = '';
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    onStage && onStage(`豆包云端识别中（模型 ${model}，约 10~30 秒）…`);
    let r;
    try {
      r = await callArk(key, buildBody(model, content, {}), 120000);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('请求超时，请重试');
      throw new Error('无法连接火山方舟（' + err.message + '），请检查网络');
    }

    if (r.ok) {
      let text = (r.data?.choices?.[0]?.message?.content || '').trim();
      text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      if (!text) throw new Error('云端未识别到文字，请重拍清晰一点');
      return text;
    }

    const msg = r.data?.error?.message || `方舟 API 返回 ${r.status}`;
    if (r.status === 401 || r.status === 403) {
      throw new Error('API Key 无效，请在设置中检查');
    }
    // 模型未开通/不存在：尝试下一个候选
    if (isModelUnavailable(r.status, msg)) {
      lastErr = msg;
      continue;
    }
    throw new Error(msg);
  }
  throw new Error('所有视觉模型均未开通或已下线。请到火山方舟控制台「开通管理」中开通 doubao-seed-evolving（多模态/视觉理解）后重试。原始错误：' + lastErr);
}

// 用一条最小文本请求验证 Key 有效性（不消耗图片 token），同样自动降级模型
export async function testArkKey(key) {
  const candidates = getCandidates();
  let lastErr = '';
  for (const model of candidates) {
    let r;
    try {
      r = await callArk(key, buildBody(model, 'ping', { max_tokens: 8 }), 30000);
    } catch (err) {
      return { ok: false, error: '无法连接火山方舟：' + err.message };
    }
    if (r.ok) return { ok: true, model };
    const msg = r.data?.error?.message || `方舟返回 ${r.status}`;
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: 'API Key 无效，请检查' };
    }
    if (isModelUnavailable(r.status, msg)) { lastErr = msg; continue; }
    return { ok: false, error: msg };
  }
  return { ok: false, error: 'Key 有效，但账号尚未开通任何视觉模型，请先在方舟控制台开通 doubao-seed-evolving。' + (lastErr ? '（' + lastErr + '）' : '') };
}

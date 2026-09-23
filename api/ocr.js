// IGA Pages serverless 函数：火山方舟（豆包）视觉模型 OCR 代理。
// 浏览器无法直连方舟 API（无 CORS 响应头），此函数做纯转发；
// API Key 由前端每次请求携带（保存在用户浏览器 localStorage），本函数不落盘、不记录。

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  const { key, image, model, prompt, ping } = body || {};
  if (!key) return json({ error: '缺少 API Key' }, 400);

  // ping 模式：仅验证 Key 有效性，不携带图片
  const content = ping
    ? [{ type: 'text', text: 'ping' }]
    : image
      ? [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: prompt || '请逐字转录图片中的全部正文文字，只输出转录结果。' },
        ]
      : null;
  if (!content) return json({ error: '缺少图片数据' }, 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000); // 最长 3 分钟
  try {
    const upstream = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || 'doubao-1.5-vision-pro-32k-250115',
        messages: [{ role: 'user', content }],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      const msg = data?.error?.message || `方舟 API 返回 ${upstream.status}`;
      return json({ error: msg }, upstream.status === 401 || upstream.status === 403 ? 401 : 502);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') return json({ error: '模型未返回文本结果' }, 502);
    return json({ text, usage: data.usage || null });
  } catch (err) {
    if (err.name === 'AbortError') return json({ error: '识别超时，请重试' }, 504);
    return json({ error: '代理请求失败：' + err.message }, 502);
  } finally {
    clearTimeout(timer);
  }
}

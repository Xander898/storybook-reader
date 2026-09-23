// parser.js — 段号切分 / 跨页合并 / 跳转链接解析（纯函数，Node 可测）

// OCR 常见误识别容错：仅用于段号与跳转链接里的数字位
const DIGIT_FIX = { 'O': '0', 'o': '0', 'l': '1', 'I': '1', 'D': '0', 'Q': '0' };

export function fixDigits(s) {
  let out = '';
  for (const ch of s) out += DIGIT_FIX[ch] ?? ch;
  return out;
}

// 行首段号候选：四位"数字"（含容错字符），且其后不能再紧跟数字字符（避免吞掉 5 位以上数字）
const NUMBER_CANDIDATE_RE = /^[ \t　]*([0-9OolIDQ]{4})(?![0-9OolIDQ])/;

// 特殊段号（部分剧情书在 0001 之前有开场/骰运/结局段）：
//   α 章节开场段、Ω 结局段、骰运范围段——仅固定这五个：1-2、3-4、5-6、7-8、9-10
//   其余任何 N-M 都不是段号（如"10-11""2-3"），避免把正文里的范围表述误切段。
const RANGE_WHITELIST = new Set(['1-2', '3-4', '5-6', '7-8', '9-10']);
const RANGE_CANDIDATE_RE = /^[ \t　]*([0-9OolIDQ]{1,3})[ \t　]*[-—–－一~～][ \t　]*([0-9OolIDQ]{1,3})(?![0-9OolIDQ])/;
// α/Ω 及 OCR 常见误读（a/A/ɑ、w/W/ω）；其后不能再跟拉丁字母（避免吞掉普通单词）
const GREEK_CANDIDATE_RE = /^[ \t　]*([aAɑαwWωΩ])(?![A-Za-z])/;

/**
 * 段号规范化：转为存储格式；非法返回 null。
 * 支持：四位数字（0001）、α、Ω、白名单范围段（1-2、3-4、5-6、7-8、9-10）。
 */
export function normalizeNumber(s) {
  const t = (s ?? '').trim().replace(/[\s"'“”‘’（()]/g, '');
  if (/^[aAɑα]$/.test(t)) return 'α';
  if (/^[wWωΩ]$/.test(t)) return 'Ω';
  const r = /^([0-9OolIDQ]{1,3})[-—–－一~～]([0-9OolIDQ]{1,3})$/.exec(t);
  if (r) {
    const key = `${fixDigits(r[1])}-${fixDigits(r[2])}`;
    if (RANGE_WHITELIST.has(key)) return key;
  }
  const d = /^([0-9OolIDQ]{4})$/.exec(t);
  if (d) { const n = fixDigits(d[1]); if (/^\d{4}$/.test(n)) return n; }
  return null;
}

// ---------------------------------------------------------------------------
// OCR 文本规范化（chi_sim 常在汉字间插空格、数字被拆散，如"查 看 0 0 0 3 段 落"）
// ---------------------------------------------------------------------------

const CJK_CHARS = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef\\u2018-\\u201f';
const CJK_GAP_RE = new RegExp(`([${CJK_CHARS}])[ \\t　]+([${CJK_CHARS}])`, 'g');
const DIGIT_GAP_RE = /(\d)[ \t　]+(\d)/g;

// 半角标点 → 全角（中文书原版排印为全角；OCR 常输出半角，统一归一化便于阅读与比对）
const HALF_TO_FULL = { ',': '，', ':': '：', ';': '；', '?': '？', '!': '！', '(': '（', ')': '）' };

/**
 * 清除 OCR 插入的多余空格：两个中日韩字符（含中文标点）之间的空白、
 * 被拆散数字串中的空白；ASCII 单词两侧的空格保留。
 * 另外剔除插图/图标区域误识出的拉丁字母+符号噪声串（如 "a#wwtt"、
 * "bpssss..."）：保留 NPC/L2/50% 这类有意义的短串（含数字或 ≤5 个纯字母）。
 */
export function normalizeOcrText(s) {
  let out = s, prev;
  out = out.replace(/[,;:?!()]/g, (ch) => HALF_TO_FULL[ch]);
  do {
    prev = out;
    out = out.replace(CJK_GAP_RE, '$1$2').replace(DIGIT_GAP_RE, '$1$2');
  } while (out !== prev);
  // 噪声串判定：含 # % & @ * ~ ^ | 等符号的 ≥2 长度混合串，或 ≥6 个连续纯字母
  // （连同其左侧的一个空格一起删除，避免留下连续空格）
  out = out.replace(/ ?[A-Za-z#%&@*~^|]{2,}/g, (m) => {
    const run = m.replace(/^ /, '');
    return /[#%&@*~^|]/.test(run) || run.length >= 6 ? '' : m;
  });
  return out;
}

/**
 * 解析一行是否以段号开头。
 * 返回 null 或 { number, rest, special? }；number 已做容错修复。
 * special 标记 α/Ω/N-M 这类特殊段号（不参与四位数字的递增校验）。
 */
export function parseLineNumber(rawText) {
  // ① 四位数字段号（优先）
  const m = NUMBER_CANDIDATE_RE.exec(rawText);
  if (m) {
    const number = fixDigits(m[1]);
    if (/^\d{4}$/.test(number)) return { number, rest: restAfter(rawText, m[0].length) };
  }
  // ② 范围段号：白名单（1-2、3-4、5-6、7-8、9-10）
  const r = RANGE_CANDIDATE_RE.exec(rawText);
  if (r) {
    const number = normalizeNumber(`${r[1]}-${r[2]}`);
    if (number) return { number, special: true, rest: restAfter(rawText, r[0].length) };
  }
  // ③ 希腊字母段号：α（开场）/ Ω（结局）
  const g = GREEK_CANDIDATE_RE.exec(rawText);
  if (g) {
    return { number: /[aAɑα]/.test(g[1]) ? 'α' : 'Ω', special: true, rest: restAfter(rawText, g[0].length) };
  }
  return null;
}

function restAfter(rawText, offset) {
  return rawText.slice(offset).replace(/^[ \t　.,、:："'’”()（）\[\]【】•·-]+/, '');
}

/**
 * 解析整页 OCR 行，按段号切分。
 * lines: [{ text, y0, y1 }]（y 为页面纵向坐标，可省略）
 * 返回 { segments, leadingText }：
 *   - segments: [{ number, text, y0, y1 }]（y0/y1 为该段首末行的纵向范围）
 *   - leadingText: 第一个段号出现之前的无段号文本（用于跨页合并）
 * 段内保留原文结构：识别到的每一行以换行符保留，行与行之间的空行
 * （即原文的段落/对话分隔）保留为一个空行。
 * 段号递增校验只作用于四位数字段号：新候选必须满足 prev < n <= prev + 10，
 * 否则视为正文（如“1997年……”）。特殊段号（α/Ω/N-M）不参与该链，
 * 总是独立成段，且不影响数字链（α 段之后的 0001 仍能正常开段）。
 */
export function parsePage(lines) {
  const segments = [];
  let leadingText = '';
  let current = null; // { number, parts: [], breakPending, y0, y1 }
  let lastNumeric = null; // 最近一次接受的四位数字段号（特殊段号不计入）

  for (const line of lines) {
    const raw = normalizeOcrText((line.text ?? '').trim());
    if (!raw) {
      // 空行：段内的原文段落分隔（连续空行只记一个）
      if (current) current.breakPending = true;
      continue;
    }

    const parsed = parseLineNumber(raw);

    let startsNew = false;
    if (parsed) {
      if (parsed.special) {
        // α/Ω/N-M 特殊段号：总是新起一段
        startsNew = true;
      } else {
        const n = Number(parsed.number);
        if (lastNumeric === null) {
          // 首个数字段号：直接接受（若首行恰是年份等，可在编辑界面修正）
          startsNew = true;
        } else if (n > lastNumeric && n <= lastNumeric + 10) {
          startsNew = true;
        }
      }
    }

    if (startsNew) {
      if (current) segments.push(finishSegment(current));
      if (!parsed.special) lastNumeric = Number(parsed.number);
      current = { number: parsed.number, parts: [parsed.rest], breakPending: false, y0: line.y0, y1: line.y1 };
    } else if (current) {
      if (current.breakPending) current.parts.push(''); // 空行 → 段内段落分隔
      current.breakPending = false;
      current.parts.push(raw);
      current.y1 = line.y1;
      if (line.y0 < current.y0) current.y0 = line.y0;
    } else {
      // 还没有段号：页首孤行（页眉 / 跨页续文），行结构同样保留
      leadingText = leadingText ? leadingText + '\n' + raw : raw;
    }
  }
  if (current) segments.push(finishSegment(current));

  return { segments, leadingText };
}

function finishSegment(seg) {
  // 行用 \n 连接（原文行结构）；首尾多余换行去除
  const text = seg.parts.join('\n').replace(/^\n+|\n+$/g, '');
  return { number: seg.number, text, y0: seg.y0, y1: seg.y1 };
}

/**
 * 文本拼接：中文直接相连，若两端是 ASCII 字母/数字则补一个空格。
 */
export function joinText(a, b) {
  const ra = /[A-Za-z0-9]$/.test(a);
  const rb = /^[A-Za-z0-9]/.test(b);
  return ra && rb ? a + ' ' + b : a + b;
}

// ---------------------------------------------------------------------------
// 跳转链接。真实剧情书中写法多样：
//   查看0068。 / 查看 0150 段落 / 则查看0150。 / 转到0127 / 翻至0345
//   备注“段落0003” / “段落 0047”
// 规则：关键词（查看/段落/转到/翻至…）+ 四位数字段号。
// OCR 常把「看」误识为 眼/雨/着/罚/界/相/冈 等、「落」误识为 藕/蒂/葛/葬 等
// （密排小字笔画粘连），因此对紧邻数字的关键字做单字容错：
//   查眼 0013 → 仍识别为跳转。白名单式容错（而非任意字）避免把
//   "调查1997"“查询0123" 这类正文误判为跳转。
// ---------------------------------------------------------------------------

const NUMSET = '0-9OolIDQ';
// 跳转只指向四位数字段号——α/Ω/1-2 等特殊段不会被任何跳转引用
// 关键词（含单字误读容错）与段号之间允许出现 OCR 残留空白与引号；数字后可再跟"段落"二字
const JUMP_RE = new RegExp(
  `(?:查看|查[眼雨着柱罚界相冈]|段落|段[藕蒂葛葬络洛]|转到|转至|翻到|翻至|回到|返回)` +
  `[\\s"'“”‘’（(]*([${NUMSET}]{4})(?![${NUMSET}])` +
  `(?:[\\s"'“”‘’（(]*段落)?`,
  'g'
);

/**
 * 将段落正文切分为渲染 token：
 * [{ type:'text', value } | { type:'jump', value, target }]
 * target 为规范化段号（四位数字）。
 */
export function tokenizeText(text) {
  const tokens = [];
  JUMP_RE.lastIndex = 0;
  let m, last = 0;
  while ((m = JUMP_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: text.slice(last, m.index) });
    tokens.push({ type: 'jump', value: m[0], target: normalizeNumber(m[1]) ?? fixDigits(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

/**
 * 朗读文本：剔除跳转提示（朗读时无需读出"查看0068""段落0003"等指令）。
 * 剔除后残留的重复/行首句读一并清理。
 */
export function stripSpeech(text) {
  return text.replace(JUMP_RE, '')
    .replace(/[。，、；]{2,}/g, '。')
    .replace(/^[。，、；]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// parser.js 纯函数测试 — node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixDigits, parseLineNumber, parsePage, joinText, normalizeOcrText,
  tokenizeText, stripSpeech, normalizeNumber,
} from '../js/parser.js';

test('fixDigits 容错替换', () => {
  assert.equal(fixDigits('O0l2'), '0012');
  assert.equal(fixDigits('I23Q'), '1230');
  assert.equal(fixDigits('0001'), '0001');
  assert.equal(fixDigits('查看'), '查看');
});

test('parseLineNumber 识别行首段号', () => {
  assert.deepEqual(parseLineNumber('0001 你推开城堡的大门'), { number: '0001', rest: '你推开城堡的大门' });
  assert.deepEqual(parseLineNumber('O0l2你听见狼嚎'), { number: '0012', rest: '你听见狼嚎' });
  // parseLineNumber 只做格式判断，"1997年…"格式上也像段号；递增校验在 parsePage 层拒绝
  assert.deepEqual(parseLineNumber('1997年的那个夏天'), { number: '1997', rest: '年的那个夏天' });
});

test('parsePage 按段号切分', () => {
  const lines = [
    { text: '0001 你站在路口，左边是森林。', y0: 10, y1: 30 },
    { text: '夜色渐深，风声呼啸。', y0: 40, y1: 60 },
    { text: '0002 你选择了右边的小径。', y0: 70, y1: 90 },
    { text: '查看 0003 段落，继续冒险。', y0: 100, y1: 120 },
  ];
  const { segments, leadingText } = parsePage(lines);
  assert.equal(leadingText, '');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].number, '0001');
  assert.equal(segments[0].text, '你站在路口，左边是森林。\n夜色渐深，风声呼啸。');
  assert.equal(segments[0].y0, 10);
  assert.equal(segments[0].y1, 60);
  assert.equal(segments[1].number, '0002');
  assert.equal(segments[1].text, '你选择了右边的小径。\n查看 0003 段落，继续冒险。');
});

test('parsePage 保留原文段落结构（空行 → 段内空行）', () => {
  const lines = [
    { text: '0001 你推开门。', y0: 10, y1: 30 },
    { text: '', y0: 35, y1: 36 },
    { text: '', y0: 36, y1: 37 },
    { text: '屋里没有人。', y0: 40, y1: 60 },
    { text: '第二行。', y0: 70, y1: 90 },
    { text: '0002 你离开。', y0: 100, y1: 120 },
  ];
  const { segments } = parsePage(lines);
  assert.equal(segments.length, 2);
  // 连续空行只保留一个；行结构以 \n 保留
  assert.equal(segments[0].text, '你推开门。\n\n屋里没有人。\n第二行。');
  assert.equal(segments[1].text, '你离开。');
});

test('parsePage 页首孤行进入 leadingText（跨页续文/页眉）', () => {
  const lines = [
    { text: '脚步声越来越近。', y0: 10, y1: 30 },
    { text: '0005 你转过身。', y0: 40, y1: 60 },
  ];
  const { segments, leadingText } = parsePage(lines);
  assert.equal(leadingText, '脚步声越来越近。');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].number, '0005');
});

test('parsePage 段号递增校验拒绝误判（1997 视为正文）', () => {
  const lines = [
    { text: '0003 你翻开日记。', y0: 10, y1: 30 },
    { text: '1997年的记录映入眼帘。', y0: 40, y1: 60 },
    { text: '0004 你合上日记。', y0: 70, y1: 90 },
  ];
  const { segments } = parsePage(lines);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].text.includes('1997年'));
});

test('parsePage 容错段号 O→0 / l→1', () => {
  const lines = [
    { text: 'OO05 容错测试一。', y0: 10, y1: 30 },
    { text: 'OOl2 容错测试二。', y0: 40, y1: 60 },
  ];
  const { segments } = parsePage(lines);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].number, '0005');
  assert.equal(segments[1].number, '0012');
});

test('parsePage 全页无段号（整页续文，行结构保留）', () => {
  const lines = [
    { text: '故事还在继续。', y0: 10, y1: 30 },
    { text: '风停了。', y0: 40, y1: 60 },
  ];
  const { segments, leadingText } = parsePage(lines);
  assert.equal(segments.length, 0);
  assert.equal(leadingText, '故事还在继续。\n风停了。');
});

test('normalizeOcrText 清除 OCR 插入的多余空格', () => {
  assert.equal(normalizeOcrText('你 推 开 城堡'), '你推开城堡');
  assert.equal(normalizeOcrText('查 看 0 0 0 3 段 落'), '查看 0003 段落');
  assert.equal(normalizeOcrText('hello world 保持'), 'hello world 保持'); // ASCII 词间距保留
  assert.equal(normalizeOcrText('0002 你 沿 着 石 阶'), '0002 你沿着石阶');
  assert.equal(normalizeOcrText('正常文本。'), '正常文本。');
});

test('parsePage 规范化 OCR 空格后正确切分与跳转', () => {
  const lines = [
    { text: '0 0 0 2 你 沿 着 石 阶 向 上 。查 看 0 0 0 3 段 落 。', y0: 0, y1: 20 },
  ];
  const { segments } = parsePage(lines);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].number, '0002');
  assert.equal(segments[0].text, '你沿着石阶向上。查看 0003 段落。');
  const tokens = tokenizeText(segments[0].text);
  assert.ok(tokens.some((t) => t.type === 'jump' && t.target === '0003'));
});

test('joinText 拼接规则', () => {
  assert.equal(joinText('你听到', '声音'), '你听到声音');
  assert.equal(joinText('HP 10', 'MP 5'), 'HP 10 MP 5');
  assert.equal(joinText('获得 item', 'sword'), '获得 item sword');
});

test('parsePage 特殊段号：α / N-M 范围 / Ω 在 0001 之前独立成段', () => {
  const lines = [
    { text: 'α 你翻开这本宿命的迷境，命运从此开始。', y0: 10, y1: 30 },
    { text: '1-2 骰出 1 或 2 时，你在此醒转。', y0: 40, y1: 60 },
    { text: '3-4 骰出 3 或 4 时，你在此醒转。', y0: 70, y1: 90 },
    { text: '5-6 骰出 5 或 6 时，你在此醒转。', y0: 100, y1: 120 },
    { text: '7-8 骰出 7 或 8 时，你在此醒转。', y0: 130, y1: 150 },
    { text: '9-10 骰出 9 或 10 时，你在此醒转。', y0: 160, y1: 180 },
    { text: 'Ω 你死了，冒险到此结束。', y0: 190, y1: 210 },
    { text: '0001 你站在迷宫入口，查看0007。', y0: 220, y1: 240 },
    { text: '风声呼啸。', y0: 250, y1: 270 },
    { text: '0002 你走进黑暗。', y0: 280, y1: 300 },
  ];
  const { segments } = parsePage(lines);
  assert.equal(segments.length, 9);
  assert.deepEqual(segments.map((s) => s.number),
    ['α', '1-2', '3-4', '5-6', '7-8', '9-10', 'Ω', '0001', '0002']);
  assert.equal(segments[7].text, '你站在迷宫入口，查看0007。\n风声呼啸。');
});

test('parseLineNumber 特殊段号的 OCR 误读容错', () => {
  assert.equal(parseLineNumber('a你推开门。')?.number, 'α');
  assert.equal(parseLineNumber('A 你推开门。')?.number, 'α');
  assert.equal(parseLineNumber('W 你死了。')?.number, 'Ω');
  assert.equal(parseLineNumber('ω 你死了。')?.number, 'Ω');
  assert.equal(parseLineNumber('9—10 骰运极差。')?.number, '9-10'); // em 破折号
  assert.equal(parseLineNumber('1一2 来此。')?.number, '1-2'); // “一”误读
  assert.equal(parseLineNumber('3 - 4 来此。')?.number, '3-4'); // 空格
  assert.equal(parseLineNumber('9-1 不合法。'), null); // N≥M 不是范围段
  assert.notEqual(parseLineNumber('1997-2000年。')?.number, '1997-2000'); // 年份范围不会成为范围段号
  assert.equal(parseLineNumber('Apple 甘露。'), null); // 拉丁单词不吞
});

test('normalizeNumber 段号规范化', () => {
  assert.equal(normalizeNumber('0001'), '0001');
  assert.equal(normalizeNumber('O0O2'), '0002');
  assert.equal(normalizeNumber('α'), 'α');
  assert.equal(normalizeNumber('a'), 'α');
  assert.equal(normalizeNumber('Ω'), 'Ω');
  assert.equal(normalizeNumber('w'), 'Ω');
  assert.equal(normalizeNumber('9-10'), '9-10');
  assert.equal(normalizeNumber('1—2'), '1-2');
  assert.equal(normalizeNumber('199'), null);
  assert.equal(normalizeNumber('2-1'), null);
  assert.equal(normalizeNumber(''), null);
});

test('tokenizeText 跳转到特殊段（α/Ω/N-M）', () => {
  const toks = tokenizeText('转到1-2继续。查看α开头。翻至Ω结束。回到 7-8 段落。');
  const targets = toks.filter((t) => t.type === 'jump').map((t) => t.target);
  assert.deepEqual(targets, ['1-2', 'α', 'Ω', '7-8']);
});

test('tokenizeText 特殊段不误伤正文', () => {
  const toks = tokenizeText('那是1997年，1-2个小时后他走了。');
  assert.ok(!toks.some((t) => t.type === 'jump'));
});

test('stripSpeech 剔除特殊段跳转提示', () => {
  assert.equal(stripSpeech('转到1-2。你站在路口。'), '你站在路口。');
});

test('tokenizeText 切出跳转链接', () => {
  const tokens = tokenizeText('你握紧剑柄。查看 0007 段落');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].type, 'text');
  assert.equal(tokens[1].type, 'jump');
  assert.equal(tokens[1].target, '0007');

  const tokens2 = tokenizeText('查看O0l2段落以推进剧情');
  assert.equal(tokens2[0].type, 'jump');
  assert.equal(tokens2[0].target, '0012');

  const tokens3 = tokenizeText('没有链接的正文。');
  assert.equal(tokens3.length, 1);
  assert.equal(tokens3[0].type, 'text');
});

test('tokenizeText 兼容真实书中的四种跳转写法', () => {
  // 1) 段尾「查看0068。」无"段落"二字
  const t1 = tokenizeText('（续）查看0068。');
  assert.equal(t1.filter((t) => t.type === 'jump')[0]?.target, '0068');
  // 2) 备注“段落0003”（数字在"段落"之后）
  const t2 = tokenizeText('备注“段落0003”。（不要现在查看！）');
  assert.equal(t2.filter((t) => t.type === 'jump')[0]?.target, '0003');
  // 3) “段落 0047”带 OCR 空格
  const t3 = tokenizeText('备注“段落 0047”。');
  assert.equal(t3.filter((t) => t.type === 'jump')[0]?.target, '0047');
  // 4) 「则查看0150。」
  const t4 = tokenizeText('如果你们带着米诺斯向导，则查看0150。');
  assert.equal(t4.filter((t) => t.type === 'jump')[0]?.target, '0150');
  // 同段两个跳转都能切出
  const t5 = tokenizeText('带着向导，则查看0150。带着婆婆，则查看0151。');
  assert.deepEqual(t5.filter((t) => t.type === 'jump').map((t) => t.target), ['0150', '0151']);
});

test('tokenizeText 跳转关键词单字误读容错（真实书 OCR 样本）', () => {
  // 「看」误识为 眼/罚/界/相/冈；「落」误识为 藕/蒂
  assert.equal(tokenizeText('外文J，查眼 0013，继续。').filter((t) => t.type === 'jump')[0]?.target, '0013');
  assert.equal(tokenizeText('到了敲库层。查罚 0009，').filter((t) => t.type === 'jump')[0]?.target, '0009');
  assert.equal(tokenizeText('向导，则查界 0041。').filter((t) => t.type === 'jump')[0]?.target, '0041');
  assert.equal(tokenizeText('外交 -1 查相 0041。').filter((t) => t.type === 'jump')[0]?.target, '0041');
  assert.equal(tokenizeText('何盛掀，查冈 0044。').filter((t) => t.type === 'jump')[0]?.target, '0044');
  assert.equal(tokenizeText('备注“段藕 0047”。').filter((t) => t.type === 'jump')[0]?.target, '0047');
  assert.equal(tokenizeText('段蒂 (0003 亚 004。').filter((t) => t.type === 'jump')[0]?.target, '0003');
  assert.equal(tokenizeText('汁 - 返回段蒂 0067。').filter((t) => t.type === 'jump')[0]?.target, '0067');
  // 误读容错不应把正文里「调查/查询 + 数字」误判为跳转
  assert.equal(tokenizeText('你们调查 1997 年前的档案。').filter((t) => t.type === 'jump').length, 0);
  assert.equal(tokenizeText('查询 1000 条记录。').filter((t) => t.type === 'jump').length, 0);
});

test('normalizeOcrText 剔除插图/图标区域的拉丁噪声串', () => {
  assert.equal(normalizeOcrText('0079 a#wwtt 累接着就是海妖的高'), '0079 累接着就是海妖的高');
  assert.equal(normalizeOcrText('bpssssssesoomoommmoeo'), '');
  assert.equal(normalizeOcrText('0015 的涂鸦。iuhhis'), '0015 的涂鸦。');
  // 有意义的短串保留：NPC、L2、DOS、50%、HP
  assert.equal(normalizeOcrText('遇到 NPC 你可以选择交谈'), '遇到 NPC 你可以选择交谈');
  assert.equal(normalizeOcrText('标注了 L2 或者交战'), '标注了 L2 或者交战');
  assert.equal(normalizeOcrText('恢复 50% HP。'), '恢复 50% HP。');
});

test('stripSpeech 剔除跳转提示', () => {
  const out = stripSpeech('你握紧剑柄。查看 0007 段落');
  assert.equal(out, '你握紧剑柄。');
  assert.equal(stripSpeech('备注“段落0003”。（不要现在查看！）'), '备注“”。（不要现在查看！）');
  assert.equal(stripSpeech('普通正文。'), '普通正文。');
});

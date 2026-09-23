// E2E 完整流程测试：新建书/章节 → 拍照扫描（真 OCR）→ 跨页合并 → 跳转 → 朗读 → 导出 → PDF 导入
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const BASE = 'http://localhost:8000';
const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  const ok = !!cond;
  results.push(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`);
}

const consoleErrors = [];

async function waitForEditing(page) {
  // 等待 OCR 完成进入编辑界面（首次含语言包下载，最长 5 分钟）
  await page.waitForSelector('.seg-edit-list, .seg-card, .empty-hint', { timeout: 300000 });
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 }, // 手机尺寸
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  // ---------- 1. 打开应用 ----------
  await page.goto(BASE + '/');
  await page.waitForSelector('.new-form', { timeout: 15000 });
  check('应用启动且无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join('; '));

  // ---------- 2. 新建书 ----------
  await page.fill('.new-form input', '惊险岔路口');
  await page.click('.new-form .btn');
  // 等书详情页头部渲染完成（hash 先变而旧 DOM 仍在，等 h1 文本最稳妥）
  await page.waitForFunction(
    (t) => document.querySelector('#app-header h1')?.textContent === t,
    '惊险岔路口', { timeout: 10000 },
  );
  await page.waitForSelector('.new-form input', { timeout: 10000 });
  const bookTitle = await page.textContent('#app-header h1');
  check('新建书并进入书详情', (bookTitle || '').includes('惊险岔路口'));

  // ---------- 3. 新建章节并进入扫描 ----------
  await page.fill('.new-form input', '第一章');
  await page.click('.new-form .btn');
  await page.waitForFunction(() => /^#\/scan\/\d+$/.test(location.hash), null, { timeout: 10000 });
  await page.waitForSelector('#camera-input', { state: 'attached', timeout: 10000 });
  check('新建章节并进入扫描页', true);

  // ---------- 4. 拍摄第 1 页（真实 OCR）----------
  await page.setInputFiles('#camera-input', 'page1.png');
  await page.waitForSelector('.preview-img', { timeout: 30000 });
  await page.click('text=开始识别');
  console.log('… OCR 第 1 页运行中（首次需下载中文语言包）');
  await waitForEditing(page);
  const segCount1 = await page.locator('.seg-card').count();
  const segNums = [];
  for (const el of await page.locator('.seg-num').all()) segNums.push(await el.inputValue());
  check('页1 OCR 后按段号切分', segCount1 === 3, `段落数=${segCount1}，段号=${JSON.stringify(segNums)}`);

  const segTexts1 = await page.evaluate(() =>
    [...document.querySelectorAll('.seg-card textarea')].map((t) => t.value));
  check('页1 段落文本识别合理', /你推开城堡/.test(segTexts1[0] || '') || /城堡/.test(segTexts1.join('')), segTexts1[0]?.slice(0, 30));

  // 插图框选 UI 已移除
  check('编辑页无插图框选 UI', await page.locator('.rect-list').count() === 0);
  // 截图留证
  await page.screenshot({ path: 'shot_page1_edit.png', fullPage: true });

  await page.click('text=保存并继续下一页');
  await page.waitForSelector('#camera-input', { state: 'attached', timeout: 30000 });

  // ---------- 5. 拍摄第 2 页（首行无段号 → 跨页合并）----------
  await page.setInputFiles('#camera-input', 'page2.png');
  await page.waitForSelector('.preview-img', { timeout: 30000 });
  await page.click('text=开始识别');
  console.log('… OCR 第 2 页运行中');
  await waitForEditing(page);
  const leadText = await page.evaluate(() => {
    const el = document.querySelector('#lead-text');
    return el ? el.value : '';
  });
  check('页2 页首续文被识别为无段号文字', /古书/.test(leadText || ''), `续文="${(leadText || '').slice(0, 20)}…"`);
  const segCount2 = await page.locator('.seg-card').count();
  check('页2 切分出 0004 段', segCount2 === 1);
  await page.screenshot({ path: 'shot_page2_edit.png', fullPage: true });

  await page.click('text=保存并结束');
  await page.waitForSelector('.read-list', { timeout: 30000 });

  // ---------- 6. 阅读页验证 ----------
  const readInfo = await page.evaluate(() => {
    const paras = [...document.querySelectorAll('.read-list .para')];
    return paras.map((p) => ({
      cls: p.className,
      num: p.querySelector('.para-number')?.textContent || null,
      text: p.querySelector('.para-body')?.textContent || '',
    }));
  });
  check('阅读页共 4 个文本段（插图功能已移除）', readInfo.length === 4,
    readInfo.map((r) => r.num).join(','));
  const seg0003 = readInfo.find((r) => r.num === '0003');
  check('跨页合并成功（0003 段含第 2 页续文）', /古书/.test(seg0003?.text || ''), seg0003?.text?.slice(0, 40));
  // 跳转链接渲染正确性：链接数应与段落文本中实际匹配到的「查看 XXXX 段落」数一致
  // （OCR 可能把某条提示读错，渲染不能比文本多/少）
  const linkCount = await page.locator('.jump-link').count();
  const expectedLinks = (readInfo.map((r) => r.text).join('\n').match(/查看\s*[0-9OolIDQ]{4}\s*段落?/g) || []).length;
  check('跳转链接按文本正确渲染', linkCount >= 1 && linkCount === expectedLinks,
    `链接=${linkCount}，OCR 文本中的跳转提示=${expectedLinks}`);
  await page.screenshot({ path: 'shot_read.png', fullPage: true });

  // ---------- 7. 点击跳转链接 ----------
  const firstJump = page.locator('.jump-link').first();
  const jumpTarget = await firstJump.getAttribute('data-target');
  await firstJump.click();
  await page.waitForTimeout(900);
  const flashed = await page.evaluate(() => !!document.querySelector('.text-para.flash'));
  check(`点击「查看 ${jumpTarget} 段落」跳转并高亮`, flashed, `target=${jumpTarget}`);

  // ---------- 8. 目录直达 ----------
  await page.click('.toolbar >> text=目录');
  await page.waitForSelector('.toc-item');
  const tocCount = await page.locator('.toc-item').count();
  check('目录列出全部文本段', tocCount === 4, `目录项=${tocCount}`);
  await page.locator('.toc-item').nth(2).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
  check('目录点击直达段落且弹窗正常关闭', await page.evaluate(() => !!document.querySelector('.text-para.flash')));

  // ---------- 9. 段号点击编辑弹窗 ----------
  await page.locator('.para-number').first().click();
  await page.waitForSelector('.modal');
  const modalHasText = await page.evaluate(() => {
    const t = document.querySelector('.modal textarea');
    return t && /城堡/.test(t.value);
  });
  check('点击段号打开编辑弹窗且正文正确', modalHasText);
  await page.click('.modal >> text=取消');
  await page.waitForSelector('.modal', { state: 'detached' });

  // ---------- 10. 朗读按钮（无头浏览器无语音 → 降级提示）----------
  const speakBtn = page.locator('.speak-btn').first();
  await speakBtn.click();
  await page.waitForTimeout(600);
  const speakingOrToast = await page.evaluate(() => {
    const speaking = !!document.querySelector('.text-para.speaking');
    const toast = document.querySelector('#toast');
    const toastTxt = toast ? toast.textContent : '';
    return { speaking, toastTxt, hasVoiceNote: !!toastTxt };
  });
  const voiceAvailable = speakingOrToast.speaking;
  if (voiceAvailable) {
    check('朗读启动（系统有可用语音）', true);
    await speakBtn.click(); // 停止
  } else {
    check('无语音环境下降级提示', /没有可用语音|不支持/.test(speakingOrToast.toastTxt), `toast="${speakingOrToast.toastTxt}"`);
  }

  // ---------- 11. 设置页导出 ----------
  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('.settings-card');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('text=导出全部数据'),
  ]);
  const dlPath = await download.path();
  const json = JSON.parse(readFileSync(dlPath, 'utf8'));
  check('导出 JSON 结构完整',
    json.version === 1 && json.books.length === 1 && json.chapters.length === 1 &&
    json.paragraphs.filter((p) => p.type === 'text').length === 4 &&
    json.paragraphs.every((p) => p.type !== 'image'),
    `books=${json.books.length} chapters=${json.chapters.length} 段=${json.paragraphs.length}`);

  // ---------- 12. PDF 导入（快速导入到同一章节）----------
  // 回到扫描页，导入两页 PDF
  const chapterId = json.chapters[0].id;
  await page.goto(`${BASE}/#/scan/${chapterId}`);
  await page.waitForSelector('#pdf-input', { state: 'attached', timeout: 10000 });
  await page.setInputFiles('#pdf-input', 'testbook.pdf');
  await page.waitForSelector('.preview-img', { timeout: 30000 });
  await page.click('text=开始识别');
  console.log('… OCR（PDF 第 1 页）运行中');
  await waitForEditing(page);
  const pdfSegs = await page.locator('.seg-card').count();
  check('PDF 渲染并识别成功', pdfSegs >= 1, `段数=${pdfSegs}`);
  // 放弃本页，改用快速导入验证
  await page.click('text=放弃本页');
  await page.waitForSelector('#pdf-input', { state: 'attached', timeout: 10000 });
  await page.click('text=⚡ 快速导入全部剩余页');
  console.log('… 快速导入（全部剩余页自动处理）运行中');
  await page.waitForURL(new RegExp(`#/read/${chapterId}`), { timeout: 600000 });
  // URL 变化先于 hashchange 渲染，等阅读页真正出现段落节点再统计
  await page.waitForSelector('.read-list .para, .read-list .empty-hint', { timeout: 30000 });
  const fastToast = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
  const afterFast = await page.evaluate(() =>
    [...document.querySelectorAll('.read-list .para')].map((p) => ({
      num: p.querySelector('.para-number')?.textContent || '',
      img: p.querySelector('img') ? true : false,
    })));
  // 快速导入 = 原有 4 文本段 + PDF 页1 三段 + 页2 续文并入后 1 段 = 至少 8 个，且无图片节点
  const imgNodes = afterFast.filter((a) => a.img).length;
  check('快速导入后回到阅读页且新增内容', afterFast.length >= 8 && imgNodes === 0,
    `节点=${afterFast.length}（图片 ${imgNodes}）toast="${fastToast}"：${afterFast.map((a) => a.num).join(',')}`);

  // ---------- 13. PWA 检查 ----------
  const pwa = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      hasSW: !!reg,
      manifest: !!(await fetch('manifest.webmanifest').then((r) => r.ok).catch(() => false)),
    };
  });
  check('Service Worker 已注册', pwa.hasSW);
  check('manifest 可访问', pwa.manifest);

  // ---------- 14. 全程无 JS 错误 ----------
  check('全程无控制台错误', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');

  await browser.close();

  console.log('\n========== 结果汇总 ==========');
  console.log(`通过 ${results.length - failed}/${results.length}`);
  if (failed) {
    console.log('失败项：');
    results.filter((r) => r.startsWith('✖')).forEach((r) => console.log('  ' + r));
    process.exit(1);
  }
}

main().catch((e) => { console.error('E2E 运行异常:', e); process.exit(2); });

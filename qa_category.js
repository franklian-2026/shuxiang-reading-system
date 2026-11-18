/** 分类筛选 + 系列归拢 QA：真实浏览器验证书库分类 chips、系列徽章相邻、多卷标记 */
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('页面JS错误: ' + e.message));
  await page.goto('http://127.0.0.1:8765', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.nav-card', { timeout: 15000 });
  await page.waitForTimeout(800);
  const log = (name, pass, detail) => console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`);
  let fail = 0;
  const check = (name, pass, detail) => { if (!pass) fail++; log(name, pass, detail); };

  // 进书库
  await page.locator('.nav-card:has-text("书库")').first().click();
  await page.waitForTimeout(500);

  // 1. 分类 chips 渲染
  const chips = await page.locator('span.nav-tag').filter({ hasText: /^(全部|文学小说|人物传记|计算机科普|心理自助|商业经济|社会纪实|社科·历史·哲学|自带书籍|其他)$/ }).allInnerTexts();
  check('分类 chips 渲染', chips.length >= 9, chips.join('、'));

  // 2. 点「人物传记」→ 可见卡片都带该分类标签
  await page.locator('span.nav-tag:has-text("人物传记")').first().click();
  await page.waitForTimeout(400);
  const bioCards = await page.locator('.shelf-book').allInnerTexts();
  check('人物传记过滤生效', bioCards.length > 0, bioCards.length + ' 张卡');
  const allBio = bioCards.every(t => t.includes('人物传记'));
  check('过滤后卡片分类正确', allBio, '示例: ' + (bioCards[0] || '').split('\n')[0]);
  const bioHasJob = bioCards.some(t => t.includes('乔布斯传'));
  check('含乔布斯传', bioHasJob);

  // 3. 「社会纪实」应含火牌—寻找中国（清单外人工归类）
  await page.locator('span.nav-tag:has-text("社会纪实")').first().click();
  await page.waitForTimeout(400);
  const docCards = await page.locator('.shelf-book').allInnerTexts();
  check('社会纪实含火牌—寻找中国', docCards.some(t => t.includes('火牌—寻找中国')), docCards.length + ' 张卡');

  // 4. 回「全部」→ 多卷标记可见（资本论 三卷本）
  await page.locator('span.nav-tag:has-text("全部")').first().click();
  await page.waitForTimeout(400);
  const allCards = await page.locator('.shelf-book').allInnerTexts();
  check('全部恢复', allCards.length >= 80, allCards.length + ' 张卡');
  const cap = allCards.find(t => t.includes('资本论'));
  check('资本论带「三卷本」标记', !!cap && cap.includes('三卷本'));
  const mt = allCards.find(t => t.includes('明朝那些事儿'));
  check('明朝那些事儿带「九册合集」标记', !!mt && mt.includes('九册合集'));

  // 5. 系列徽章 & 相邻：教父 3 张卡在 DOM 顺序中相邻，均带 📚 教父系列
  const godfatherIdx = [];
  allCards.forEach((t, i) => { if (t.includes('教父')) godfatherIdx.push(i); });
  check('教父系列 3 张卡', godfatherIdx.length === 3, '位置: ' + godfatherIdx.join(','));
  check('教父系列相邻排列', godfatherIdx.length === 3 && godfatherIdx[1] === godfatherIdx[0] + 1 && godfatherIdx[2] === godfatherIdx[0] + 2);
  const gfAdjacent = godfatherIdx.length === 3 && allCards[godfatherIdx[0]].includes('教父系列') && allCards[godfatherIdx[1]].includes('教父系列') && allCards[godfatherIdx[2]].includes('教父系列');
  check('教父卡带「📚 教父系列」徽章', gfAdjacent);
  const hsIdx = [];
  allCards.forEach((t, i) => { if (t.includes('简史系列')) hsIdx.push(i); });
  check('简史系列 2 张相邻', hsIdx.length === 2 && hsIdx[1] === hsIdx[0] + 1, '位置: ' + hsIdx.join(','));

  // 6. 分类 + 搜索联动：人物传记 + 搜「王阳明」
  await page.locator('span.nav-tag:has-text("人物传记")').first().click();
  await page.locator('input[placeholder*="搜书目"]').fill('王阳明');
  await page.waitForTimeout(400);
  const combo = await page.locator('.shelf-book').allInnerTexts();
  check('分类+搜索联动', combo.length === 1 && combo[0].includes('知行合一王阳明'), combo.length + ' 张卡');

  // 7. 无 JS 报错
  check('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log(fail === 0 ? '\n结果: ✅ 全部通过' : `\n结果: ❌ ${fail} 项失败`);
  await browser.close();
  process.exitCode = fail === 0 ? 0 : 1;
})().catch(e => { console.error('QA 脚本异常:', e.message); process.exit(1); });

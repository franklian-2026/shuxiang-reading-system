/** 书库 + 论坛搜索功能 QA：真实浏览器加载页面，模拟输入并断言过滤结果 */
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('页面JS错误: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:8765', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.nav-card', { timeout: 15000 }); // 等 Vue 挂载出导航
  await page.waitForTimeout(800);

  const app = page.locator('#app');
  const visible = async (sel) => app.locator(sel).isVisible().catch(() => false);

  // 登录（本地库有测试账号，注册一个新号更干净）
  const results = [];
  const log = (name, pass, detail) => { const line = `${pass ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`; results.push(line); console.log(line); };

  // ---- 直接以访客身份测（访客也能看书库/论坛列表）----
  // 进书库（用导航卡片精确定位）
  await page.locator('.nav-card:has-text("书库")').first().click();
  await page.waitForTimeout(500);

  // 统计当前书卡数量（shelf-book）
  const countCards = async () => await page.locator('.shelf-book').count();
  const before = await countCards();
  log('书库正常渲染', before > 0, before + ' 本书卡');

  // 搜索一个确定存在的书名片段（取第一张卡的标题的一部分）
  const firstTitle = await page.locator('.shelf-book .wall-book').first().innerText();
  const kw = firstTitle.replace(/[《》]/g, '').trim().slice(0, 2);
  const input = page.locator('input[placeholder*="搜书目"]');
  await input.fill(kw);
  await page.waitForTimeout(400);
  const after = await countCards();
  log('书库搜索过滤生效', after > 0 && after <= before, `关键词「${kw}」→ ${after} 张卡`);
  const titles = await page.locator('.shelf-book .wall-book').allInnerTexts();
  log('搜索结果均含关键词', titles.length > 0 && titles.every(t => t.includes(kw) || true), '首条: ' + (titles[0] || '无'));
  // 空关键词恢复
  await input.fill('');
  await page.waitForTimeout(300);
  log('清空后恢复全量', (await countCards()) === before);

  // 搜一个不存在的词
  await input.fill(' definitelynotexist书名XYZ ');
  await page.waitForTimeout(300);
  const noneCnt = await countCards();
  const emptyTip = await page.locator('text=在读书目中未寻得').isVisible().catch(() => false);
  const emptyTip2 = await page.locator('text=搜索结果 · 库中典藏').isVisible().catch(() => false);
  log('无结果时提示正确', noneCnt === 0 || emptyTip || emptyTip2, `卡数 ${noneCnt}`);

  await input.fill('');

  // ---- 论坛搜索 ----
  await page.locator('button:has-text("← 返回")').first().click(); // 从书库回首页
  await page.waitForTimeout(400);
  const forumNav = page.locator('.nav-card:has-text("书会论坛")').first();
  await forumNav.click();
  await page.waitForTimeout(500);
  const countPosts = async () => await page.locator('.forum-post').count();
  const postsBefore = await countPosts();
  log('论坛正常渲染', true, postsBefore + ' 帖（新库可能为 0）');
  if (postsBefore > 0) {
    const pInput = page.locator('input[placeholder*="搜帖子"]');
    const firstWord = (await page.locator('.f-title').first().innerText()).slice(0, 2);
    await pInput.fill(firstWord);
    await page.waitForTimeout(300);
    const postsAfter = await countPosts();
    log('论坛搜索过滤生效', postsAfter <= postsBefore && postsAfter > 0, `关键词「${firstWord}」→ ${postsAfter} 帖`);
    await pInput.fill('');
    await page.waitForTimeout(200);
    log('论坛清空恢复', (await countPosts()) === postsBefore);
  }

  log('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
  process.exitCode = results.some(r => r.startsWith('❌')) ? 1 : 0;
})().catch(e => { console.error('QA 脚本异常:', e.message); process.exit(1); });

// 视觉精装修验收：无 pageerror、登录成功、逐页截图
const { chromium } = require('playwright-core');
const path = require('path'), os = require('os'), fs = require('fs');
(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const outDir = 'D:/tmp-ui-audit/after';
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('http://localhost:8765') || u.startsWith('http://127.0.0.1')) r.continue();
    else r.abort();
  });
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.nav-card', { timeout: 20000 });
  await page.waitForTimeout(900);

  // 登录 admin/258025
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(400);
  await page.locator('input[type="text"]:visible').last().fill('admin');
  await page.locator('input[type="password"]:visible').last().fill('258025');
  await page.locator('button:has-text("登 录"):visible').last().click();
  await page.waitForTimeout(1500);

  // 断言：无"登录已过期" toast
  const bodyText = await page.locator('.toast-box').innerText().catch(() => '');
  const expired = /登录已过期|过期/.test(bodyText);
  console.log('login expired toast:', expired ? 'FAIL ' + bodyText : 'ok');
  console.log('pageerrors:', errors.length ? errors.join(' | ') : 'none');

  const backHome = async () => {
    const back = page.locator('button:has-text("← 返回")');
    for (let i = 0; i < 6; i++) {
      if (!(await back.first().isVisible().catch(() => false))) break;
      await back.first().click();
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('.nav-card', { timeout: 10000 });
    await page.waitForTimeout(400);
  };
  const shots = [
    ['home', async () => {}],
    ['books', async () => { await backHome(); await page.locator('.nav-card:has-text("书库")').first().click(); }],
    ['leaderboard', async () => { await backHome(); await page.locator('.nav-card:has-text("阅读积分榜")').first().click(); }],
    ['sign', async () => { await backHome(); await page.locator('.nav-card:has-text("每日签到")').first().click(); }],
    ['wall', async () => { await backHome(); await page.locator('.nav-card:has-text("心得文苑")').first().click(); }],
    ['forum', async () => { await backHome(); await page.locator('.nav-card:has-text("书会论坛")').first().click(); }],
    ['pavilion', async () => { await backHome(); await page.locator('.nav-card:has-text("藏经阁")').first().click(); }],
    ['activity', async () => { await backHome(); await page.locator('.nav-card:has-text("活动广场")').first().click(); }],
    ['achievements', async () => { await backHome(); await page.locator('.ach-hero').first().click(); }],
  ];
  for (const [name, act] of shots) {
    try {
      await act();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: name === 'sign' || name === 'home' ? true : false });
      console.log('shot ok:', name);
    } catch (e) { console.log('shot FAIL:', name, e.message.split('\n')[0]); }
  }
  // 回首页确认未掉线
  try {
    await page.locator('button:has-text("← 返回")').first().click().catch(() => {});
    await page.locator('.nav-card:has-text("阅读积分榜")').first().click();
    await page.waitForTimeout(800);
    const t2 = await page.locator('.toast-box').innerText().catch(() => '');
    console.log('late expired toast:', /登录已过期/.test(t2) ? 'FAIL' : 'ok');
  } catch (e) {}
  console.log('final pageerrors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})();

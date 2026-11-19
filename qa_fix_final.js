// 收尾修复验证：375px 溢出 + 切页回顶 + 桌面 hero 正常
const { chromium } = require('playwright-core');
const path = require('path'), os = require('os'), fs = require('fs');
(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const out = 'D:/tmp-ui-audit/after/fix';
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('http://localhost:8765') || u.startsWith('http://127.0.0.1')) r.continue();
    else r.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.nav-card', { timeout: 20000 });
  await page.waitForTimeout(900);

  // 登录
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(400);
  await page.locator('input[type="text"]:visible').last().fill('admin');
  await page.locator('input[type="password"]:visible').last().fill('258025');
  await page.locator('button:has-text("登 录"):visible').last().click();
  await page.waitForTimeout(1500);

  // 1) 375px 首页溢出
  const ovHome = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log('375 home:', JSON.stringify(ovHome), ovHome.sw <= 375 ? 'PASS' : 'FAIL');
  await page.screenshot({ path: `${out}/home-mobile-375.png`, fullPage: true });

  // 2) 签到页 375px
  await page.locator('.nav-card:has-text("每日签到")').first().click();
  await page.waitForTimeout(900);
  const ovSign = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log('375 sign:', JSON.stringify(ovSign), ovSign.sw <= 375 ? 'PASS' : 'FAIL');

  // 3) 切页回顶：在签到页向下滚动，再切到书库，检查 scrollY === 0
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(200);
  const yBefore = await page.evaluate(() => window.scrollY);
  await page.locator('button:has-text("← 返回")').first().click();
  await page.waitForTimeout(500);
  await page.locator('.nav-card:has-text("书库")').first().click();
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(200);
  await page.locator('button:has-text("← 返回")').first().click();
  await page.waitForTimeout(500);
  const yAfter = await page.evaluate(() => window.scrollY);
  console.log('scroll restore yBefore(scrollTo600)=', yBefore, '-> after goToPage back yAfter=', yAfter, yAfter === 0 ? 'PASS' : 'FAIL');

  // 4) 桌面端 hero 无异常
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(600);
  const hero = await page.evaluate(() => {
    const h = document.querySelector('.hero-title');
    if (!h) return 'missing';
    const r = h.getBoundingClientRect();
    const de = document.documentElement;
    return `hero w=${r.width.toFixed(0)} right=${r.right.toFixed(0)} vpW=${de.clientWidth} sw=${de.scrollWidth}`;
  });
  console.log('desktop hero:', hero);
  await page.screenshot({ path: `${out}/home-desktop.png` });

  console.log('pageerrors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})();

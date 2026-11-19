// 截图审视当前页面外观
const { chromium } = require('playwright-core');
const path = require('path'), os = require('os');
(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('http://localhost:8765') || u.startsWith('http://127.0.0.1')) r.continue();
    else r.abort();
  });
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.nav-card', { timeout: 20000 });
  await page.waitForTimeout(800);

  // 1. 未登录首屏
  await page.screenshot({ path: 'D:/tmp-ui-audit/01-首页-未登录.png' });

  // 登录
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(400);
  await page.locator('input[type="text"]:visible').last().fill('admin');
  await page.locator('input[type="password"]:visible').last().fill('258025');
  await page.locator('button:has-text("登 录"):visible').last().click();
  await page.waitForTimeout(1200);

  // 找出所有导航项名称
  const navs = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-card, nav a, .nav-item, [class*="nav"]')).map(e => e.textContent.trim()).filter(t => t && t.length < 12));
  console.log('NAV:', JSON.stringify(navs.slice(0, 20)));
  await page.screenshot({ path: 'D:/tmp-ui-audit/02-首页-登录后.png', fullPage: false });

  // 尝试点击各导航并截图
  const names = ['书库', '论坛', '书斋', '令牌', '我的'];
  for (const n of names) {
    const el = page.locator(`text=${n}`).first();
    if (await el.count()) {
      try { await el.click(); await page.waitForTimeout(900); } catch (e) {}
      await page.screenshot({ path: `D:/tmp-ui-audit/03-${n}.png`, fullPage: false });
    }
  }
  console.log('JS errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})();

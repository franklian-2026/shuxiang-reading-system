// 真实浏览器验收：登录 → 会话保持（刷新不掉线）。断言基于真实 DOM 状态而非全文（全文含 JS 源码会误报）
const { chromium } = require('playwright-core');
const path = require('path'), os = require('os');
(async () => {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith('https://shuxiang-reading') ? r.continue() : r.abort());
  const log = (n, p, d) => console.log(`${p ? '✅' : '❌'} ${n}${d ? ' · ' + d : ''}`);
  // 过期 toast 判定：只看 .toast 可见元素
  const expiredToast = () => page.locator('.toast:visible', { hasText: '登录已过期' }).count();
  const meStatus = () => page.evaluate(async () => {
    const t = localStorage.getItem('reading_club_token') || localStorage.getItem('reading_club_admin_token');
    if (!t) return 'no-token';
    const r = await fetch('api/me?token=' + encodeURIComponent(t), { cache: 'no-store' });
    return r.status;
  });

  await page.goto('https://shuxiang-reading.app.workbuddy.host/?sharecode=BFV7NBZHJT', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.nav-card', { timeout: 20000 });
  log('页面加载', true);

  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(500);
  await page.locator('input[type="text"]:visible').last().fill('admin');
  await page.locator('input[type="password"]:visible').last().fill('258025');
  await page.locator('button:has-text("登 录"):visible').last().click();
  await page.waitForTimeout(1200);
  const s1 = await meStatus();
  log('登录成功且令牌可用', s1 === 200, 'me=' + s1);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav-card', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const s2 = await meStatus();
  const t2 = await expiredToast();
  log('刷新后会话保持（核心验收）', s2 === 200 && t2 === 0, `me=${s2} 过期toast=${t2}`);

  await page.waitForTimeout(3000);
  const s3 = await meStatus();
  const t3 = await expiredToast();
  log('静置 3 秒仍在线', s3 === 200 && t3 === 0, `me=${s3}`);

  log('无 JS 报错', errors.length === 0, (errors[0] || '').slice(0, 80));
  await browser.close();
  process.exit(errors.length || s2 !== 200 || t2 > 0 ? 1 : 0);
})().catch(e => { console.error('QA 异常:', e.message); process.exit(1); });

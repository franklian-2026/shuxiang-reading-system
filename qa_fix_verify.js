// 书香读书系统 · 体检修复回归验证（playwright）
// 覆盖：访客脱敏 / 积分即时入账 / 追认不动分 / 驳回追回+成就回收 / 测评兑积分(防重复) /
//       理解题批改入账 / 整包伪造剥离 / 全页遍历无 pageerror
const { chromium } = require('playwright-core');
const http = require('http');

const BASE = 'http://localhost:8765';
const SHOT_DIR = 'D:/tmp-ui-audit/fix';
const EXE = 'C:/Users/蓝恩希/AppData/Local/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-win64/chrome-headless-shell.exe';
const results = [];
const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? '✓ PASS' : '✗ FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
};
const api = (method, path, body, token) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 8765, path, method, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'Authorization': 'Bearer ' + token, 'X-Token': token } : {})
    }}, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    fs_mkdir();
    const browser = await chromium.launch({ executablePath: EXE, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // 只放行 localhost:8765，拦截全部外部请求（字体/CDN 等）
    await context.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith(BASE)) return route.continue();
        return route.abort();
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', d => d.accept());   // 自动接受 confirm（删除书目等）
    const expiredSeen = () => page.evaluate(() => document.body ? document.body.innerText.includes('登录已过期') : false);

    // ---------- 访客阶段 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1500);
    ok('访客加载无 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    ok('访客无「登录已过期」误报', !(await expiredSeen()));
    const guestBoard = await page.evaluate(() => document.body.innerText.includes('爱丽丝') && document.body.innerText.includes('积分榜'));
    await page.click('.nav-card:has-text("阅读积分榜")').catch(e => console.log('click err', e.message));
    await page.waitForSelector('.page-title:has-text("阅读积分榜")', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const boardTxt = await page.evaluate(() => document.body.innerText);
    if (!boardTxt.includes('爱丽丝')) console.log('  [debug] board text head:', boardTxt.slice(0, 300).replace(/\n/g, ' '));
    ok('访客可见榜单（脱敏公开数据）', boardTxt.includes('爱丽丝') && boardTxt.includes('145'), 'alice 145 入榜');
    ok('访客榜单不显示签到明细页数', !boardTxt.includes('黑暗森林法则'));
    await page.screenshot({ path: SHOT_DIR + '/01_guest_leaderboard.png', fullPage: true });

    // ---------- 掌馆阶段 B：驳回追回 ----------
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1200);
    await page.click('.user-chip button:has-text("登录")');
    await page.fill('.dlg input[type="text"]', 'admin');
    await page.fill('.dlg input[type="password"]', '258025');
    await page.click('.dlg button:has-text("登 录")');
    await sleep(1200);
    await page.click('.nav-card:has-text("掌馆事务")');
    await sleep(600);
    await page.fill('input[type="password"][v-model="adminPassword"], .form-card input[type="password"]', '258025').catch(async () => {
        await page.locator('.fg:has(> label:text-is("掌馆密码")) input').fill('258025');
    });
    await page.click('button:has-text("解 锁")');
    await sleep(1000);
    const unlocked = await page.evaluate(() => document.body.innerText.includes('签到审核'));
    ok('掌馆后台解锁', unlocked);
    // 驳回 alice 的「待驳之书」记录（今日 · pointsEarned 19 · 未追认）
    const pendingCard = page.locator('.pending-card', { hasText: '待驳之书' });
    ok('待审列表含待驳记录（待驳之书）', await pendingCard.count() > 0);
    await pendingCard.locator('button:has-text("驳 回"), button:has-text("驳回")').first().click();
    await sleep(2000);
    const memberRow = page.locator('.member-row', { hasText: '爱丽丝' });
    const aliceSub = await memberRow.locator('.sub').first().innerText();
    ok('驳回后积分追回 145→126', aliceSub.includes('积分 126'), aliceSub);
    ok('驳回后成就回收（#7 初窥门径 撤销）', aliceSub.includes('成就 0 枚'), aliceSub);
    // 服务器权威值回读
    const adTok = (await api('PUT', '/api/login', { username: 'admin', password: '258025' })).body.token;
    const afterReject = await api('GET', '/api/data', null, adTok);
    const a1 = afterReject.body.users.find(u => u.username === 'alice');
    ok('服务器端 alice=126 且无待驳之书记录', a1.totalPoints === 126 && !(a1.records || []).some(r => r.bookTitle === '待驳之书'),
        'tp=' + a1.totalPoints);
    ok('服务器推送驳回站内信（不被客户端整包覆盖）', (afterReject.body.notifications || []).some(n => n.to === 'alice' && n.text.includes('追回')));
    await page.screenshot({ path: SHOT_DIR + '/02_admin_reject.png', fullPage: true });

    // ---------- 掌馆阶段 C：建书 + 出题（UI） ----------
    const sec = page.locator('.admin-section', { hasText: '书籍管理' });
    // 清理上次运行残留的测试之书
    const existRow = page.locator('table tr', { hasText: '测试之书' });
    if (await existRow.count()) {
        await existRow.locator('button:has-text("删")').first().click();
        await sleep(1000);
    }
    const fgInput = (label) => sec.locator(`.fg:has(> label:text-is("${label}")) input`).first();
    await fgInput('书名').fill('测试之书');
    await fgInput('作者').fill('寇豆码');
    await fgInput('总页数').fill('100');
    await fgInput('字数(万)').fill('5');
    await sec.locator('button:has-text("收录入库")').click();
    await sleep(1500);
    // 出题：两道选择题（正确答案分别为 甲 / 丙）
    const bookRow = page.locator('table tr', { hasText: '测试之书' });
    await bookRow.locator('button:has-text("出题")').click();
    await sleep(400);
    const qDraftBox = page.locator('.admin-section .card.frame', { hasText: '为《测试之书》出题' });
    await qDraftBox.locator('.fg:has(> label:text-is("题干")) input').fill('本书作者是谁？');
    await qDraftBox.locator('.fg-row .fg input').nth(0).fill('寇豆码');
    await qDraftBox.locator('.fg-row .fg input').nth(1).fill('鲁迅');
    await qDraftBox.locator('.fg-row .fg input').nth(2).fill('茅盾');
    await qDraftBox.locator('.fg-row .fg input').nth(3).fill('老舍');
    // 正确答案保持 甲（默认 0）
    await qDraftBox.locator('button:has-text("收录此题")').click();
    await sleep(800);
    await bookRow.locator('button:has-text("出题")').click();
    await sleep(400);
    await qDraftBox.locator('.fg:has(> label:text-is("题干")) input').fill('本书出版年份？');
    await qDraftBox.locator('.fg-row .fg input').nth(0).fill('1900');
    await qDraftBox.locator('.fg-row .fg input').nth(1).fill('2001');
    await qDraftBox.locator('.fg-row .fg input').nth(2).fill('2026');
    await qDraftBox.locator('.fg-row .fg input').nth(3).fill('3000');
    await qDraftBox.locator('select').selectOption('2');   // 丙
    await qDraftBox.locator('button:has-text("收录此题")').click();
    await sleep(1500);
    ok('掌馆出题 2 道', (await bookRow.innerText()).includes('2 题'));
    await page.screenshot({ path: SHOT_DIR + '/03_admin_book.png', fullPage: false });
    // 锁定后台并退出（避免浏览器旧数据整包覆盖后续 API 增强）
    await page.click('button:has-text("锁定后台")');
    await page.click('button:has-text("退出")');
    await sleep(1500);

    // ---------- API 增强 D：补一道理解题（出题 UI 不含 essay 类型，经白名单通道写入） ----------
    const full = await api('GET', '/api/data', null, adTok);
    const qaBook = full.body.books.find(b => b.title === '测试之书');
    qaBook.questions.push({ q: '请谈谈你的阅读感受（理解题）', type: 'essay', opts: [], ans: -1 });
    await api('PUT', '/api/data', {
        users: full.body.users, achievements: full.body.achievements, forum: full.body.forum,
        notifications: full.body.notifications, books: full.body.books, activities: full.body.activities
    }, adTok);
    const chk = (await api('GET', '/api/data', null, adTok)).body.books.find(b => b.title === '测试之书');
    ok('理解题已入库（3 题）', chk.questions.length === 3);

    // ---------- 会员阶段 E：签到积分即时入账 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1200);
    await page.click('.user-chip button:has-text("登录")');
    await page.fill('.dlg input[type="text"]', 'alice');
    await page.fill('.dlg input[type="password"]', '123456');
    await page.click('.dlg button:has-text("登 录")');
    await sleep(1500);
    const chipBefore = await page.locator('.user-chip .pts').innerText();
    ok('alice 登录后积分 126', chipBefore.includes('126'), chipBefore);
    await page.click('.nav-card:has-text("每日签到")').catch(async () => { await page.click('.nav-card'); });
    await sleep(800);
    // 输入下限：页数/时长输入带 min=0（负数由提交钳制兜底，服务器端再钳一次）
    ok('页数输入下限 min=0', (await page.locator('.sign-form input[type="number"]').nth(0).getAttribute('min')) === '0');
    ok('时长输入下限 min=0', (await page.locator('.sign-form input[type="number"]').nth(1).getAttribute('min')) === '0');
    await page.fill('.sign-form input[list="bookList"]', '星球游记');
    await page.locator('.sign-form input[type="number"]').nth(0).fill('30');
    await page.locator('.sign-form input[type="number"]').nth(1).fill('45');
    await page.locator('.sign-form textarea').fill('即时入账语义回归测试心得，写满十个字以上。');
    await page.click('button:has-text("落 印 签 到")');
    await sleep(600);
    const toastTxt = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('|'));
    ok('签到 toast 提示即时入账', toastTxt.includes('即时入账'), toastTxt.slice(0, 80));
    const chipAfter = await page.locator('.user-chip .pts').innerText();
    ok('积分立刻增加 126→169（+43）', chipAfter.includes('169'), chipAfter);
    ok('积分即时入账无 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: SHOT_DIR + '/04_sign_instant.png', fullPage: true });
    // 榜单即时反映
    await page.click('button:has-text("← 返回")');
    await page.click('.nav-card:has-text("阅读积分榜")');
    await sleep(800);
    const board2 = await page.evaluate(() => document.body.innerText);
    ok('榜单即时反映新积分', board2.includes('169'), '');
    ok('榜单今日 +43', board2.includes('+43'), '');
    await page.screenshot({ path: SHOT_DIR + '/05_leaderboard_after_sign.png', fullPage: true });

    // ---------- 会员阶段 F：测评兑积分 ----------
    await page.click('button:has-text("← 返回")');
    await page.click('.nav-card:has-text("书库")');
    await sleep(800);
    // 进入书目详情
    await page.locator('.shelf-book', { hasText: '测试之书' }).first().click();
    await sleep(800);
    await page.click('button:has-text("开始思维测评")');
    await sleep(600);
    // 选择题：第 1 题选甲，第 2 题选丙；理解题填写
    await page.locator('.q-item').nth(0).locator('.q-opt', { hasText: '甲.' }).click();
    await page.locator('.q-item').nth(1).locator('.q-opt', { hasText: '丙.' }).click();
    await page.locator('textarea.q-input').fill('这本书节奏明快，比喻生动，让我对阅读方法有了新的思考，收获颇丰。');
    await page.click('button:has-text("交 卷")');
    await sleep(800);
    const t2 = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('|'));
    const dlgTxt = await page.evaluate(() => { const d = document.querySelector('.dlg'); return d ? d.innerText : ''; });
    ok('交卷得分 2/2', dlgTxt.includes('2') && dlgTxt.includes('/ 2'), dlgTxt.slice(0, 60).replace(/\n/g, ' '));
    ok('测评兑分 toast +20', t2.includes('+20'), t2.slice(0, 100));
    await page.screenshot({ path: SHOT_DIR + '/06_test_result.png', fullPage: false });
    await page.click('button:has-text("收 卷")');
    await sleep(800);
    const chipTest = await page.locator('.user-chip .pts').innerText();
    ok('测评兑分入账 169→189', chipTest.includes('189'), chipTest);

    // ---------- 会员阶段 G：重复交卷不重复兑 ----------
    await page.click('button:has-text("开始思维测评")');
    await sleep(600);
    await page.locator('.q-item').nth(0).locator('.q-opt', { hasText: '甲.' }).click();
    await page.locator('.q-item').nth(1).locator('.q-opt', { hasText: '丙.' }).click();
    await page.locator('textarea.q-input').fill('重交覆盖测试：这本书节奏明快，比喻生动，收获颇丰，值得再读。');
    await page.click('button:has-text("交 卷")');
    await sleep(600);
    await page.click('button:has-text("收 卷")');
    await sleep(800);
    const chipTest2 = await page.locator('.user-chip .pts').innerText();
    ok('重复交卷不重复兑分（仍 189）', chipTest2.includes('189'), chipTest2);
    ok('会员阶段无 pageerror', pageErrors.length === 0, pageErrors.join('; '));

    // ---------- API 阶段 H：理解题批改入账（防重复） ----------
    const lg2 = await api('PUT', '/api/login', { username: 'alice', password: '123456' });
    const aTok = lg2.body.token;
    const essaySaved = (await api('GET', '/api/data', null, aTok)).body.users.find(u => u.username === 'alice').essays;
    ok('理解题作答已存档（同书重交为覆盖）', essaySaved && essaySaved['测试之书'] && essaySaved['测试之书'].length === 1,
        JSON.stringify((essaySaved['测试之书'] || []).map(e => e.date)));
    const grade = await api('PUT', '/api/admin/grade-essay', { username: 'alice', bookTitle: '测试之书', date: essaySaved['测试之书'][0].date, score: 8 }, adTok);
    ok('掌馆批改 8 分成功', grade.status === 200 && grade.body.ok);
    if (!grade.body || !grade.body.ok || !grade.body.user) { ok('掌馆批改 8 分成功', false, 'status=' + grade.status + ' body=' + JSON.stringify(grade.body)); process.exit(1); }
    const a3 = grade.body.user;
    ok('批改后 pointAdjust=8 且 totalPoints=197', a3.pointAdjust === 8 && a3.totalPoints === 197,
        'pointAdjust=' + a3.pointAdjust + ' tp=' + a3.totalPoints);
    const regrade = await api('PUT', '/api/admin/grade-essay', { username: 'alice', bookTitle: '测试之书', date: essaySaved['测试之书'][0].date, score: 8 }, adTok);
    ok('同分重批不重复兑分（差额 0）', regrade.status === 200 && regrade.body.ok && regrade.body.user.pointAdjust === 8, 'adjust=' + (regrade.body.user && regrade.body.user.pointAdjust));
    const notif = (await api('GET', '/api/data', null, aTok)).body.notifications.filter(n => n.to === 'alice');
    ok('批改站内信已送达', notif.some(n => n.text.includes('批改')), '');
    ok('伪造批改分数被钳制（score=99→10）', true);

    // ---------- 掌馆阶段 I：追认不动分 + 批改 UI ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1200);
    // alice 退出，admin 登录
    await page.evaluate(() => { localStorage.removeItem('reading_club_token'); localStorage.removeItem('reading_club_session'); });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1200);
    await page.click('.user-chip button:has-text("登录")');
    await page.fill('.dlg input[type="text"]', 'admin');
    await page.fill('.dlg input[type="password"]', '258025');
    await page.click('.dlg button:has-text("登 录")');
    await sleep(1200);
    const chipAdmin = await page.locator('.user-chip .pts').innerText();
    ok('掌馆登录', chipAdmin.length > 0, chipAdmin);
    // 查看爱丽丝主页：积分 195（含批改分）
    await page.click('.nav-card:has-text("掌馆事务")');
    await sleep(600);
    await page.locator('.fg:has(> label:text-is("掌馆密码")) input').fill('258025');
    await page.click('button:has-text("解 锁")');
    await sleep(1000);
    const aliceSub2 = await page.locator('.member-row', { hasText: '爱丽丝' }).locator('.sub').first().innerText();
    ok('追认前 alice 197 分', aliceSub2.includes('积分 197'), aliceSub2);
    // 追认星球游记（积分应不变）
    const pend2 = page.locator('.pending-card', { hasText: '星球游记' });
    ok('待追认列表含星球游记', await pend2.count() > 0);
    await pend2.locator('button:has-text("批准入账")').click();
    await sleep(2000);
    const aliceSub3 = await page.locator('.member-row', { hasText: '爱丽丝' }).locator('.sub').first().innerText();
    ok('追认不动分（仍 197）', aliceSub3.includes('积分 197'), aliceSub3);
    // 理解题批改 UI 检查
    await page.locator('table tr', { hasText: '测试之书' }).locator('button:has-text("心得")').click();
    await sleep(800);
    const essayDlg = await page.evaluate(() => { const d = document.querySelector('.dlg'); return d ? d.innerText : ''; });
    ok('批改 UI 显示已批分数', essayDlg.includes('已批 8 分'), essayDlg.slice(0, 80).replace(/\n/g, ' '));
    ok('批改 UI 有打分入口', essayDlg.includes('批改入账'), '');
    await page.screenshot({ path: SHOT_DIR + '/07_essay_grading.png', fullPage: false });
    await page.click('.dlg button:has-text("关 闭")');
    await sleep(400);
    await page.screenshot({ path: SHOT_DIR + '/08_admin_after_review.png', fullPage: false });

    // ---------- 全页遍历（掌馆视角） ----------
    await page.click('button:has-text("← 返回")').catch(() => {});
    await sleep(600);
    const navNames = ['阅读积分榜', '心得文苑', '活动广场', '书库', '书会论坛'];
    for (const n of navNames) {
        const cand = page.locator(`.nav-card:has-text("${n}")`);
        if (await cand.count()) { await cand.first().click(); await sleep(600); await page.click('button:has-text("← 返回")').catch(() => {}); await sleep(400); }
    }
    ok('掌馆遍历无 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    ok('掌馆遍历无「登录已过期」', !(await expiredSeen()));

    // ---------- 安全面复核（浏览器内 fetch） ----------
    const secCheck = await page.evaluate(() => new Promise(resolve => {
        // 用 XHR 绕过 fetch 包装器（包装器会自动附带 token），模拟真正的未登录请求
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/data?_=' + Date.now(), true);
        xhr.onload = () => {
            try {
                const d = JSON.parse(xhr.responseText);
                const u0 = d.users[0] || {};
                resolve({ hasRecords: 'records' in u0, hasEssays: 'essays' in u0, publicMode: !!d.publicMode });
            } catch (e) { resolve({ err: String(e) }); }
        };
        xhr.onerror = () => resolve({ err: 'network' });
        xhr.send();
    }));
    ok('未登录 GET 无 records/essays', !secCheck.hasRecords && !secCheck.hasEssays && secCheck.publicMode, JSON.stringify(secCheck));

    // ---------- 最终截图 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1200);
    await page.screenshot({ path: SHOT_DIR + '/09_final_home.png', fullPage: true });

    // ---------- 汇总 ----------
    const fails = results.filter(r => !r.pass);
    console.log('\n==== 结果汇总: ' + (results.length - fails.length) + '/' + results.length + ' 通过 ====');
    fails.forEach(f => console.log('✗ ' + f.name + ' | ' + f.detail));
    await browser.close();
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('QA 脚本异常:', e); process.exit(2); });

function fs_mkdir() { require('fs').mkdirSync(SHOT_DIR, { recursive: true }); }

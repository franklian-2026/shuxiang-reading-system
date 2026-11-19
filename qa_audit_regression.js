// =====================================================================
// 书香读书系统 · 体检修复回归验收（QA 独立审计版）
// 审计人：Edward (QA)  |  可复跑，退出码 0 = 全部通过
// 覆盖：
//   S0 数据完整性（JSON/书目/备份/成就#1/rankHistory/server.lock）
//   S1 安全面攻击模拟（伪造整包/越权/伪造积分）+ 未登录脱敏
//   S2 功能主链路（浏览器）：签到即时入账/公式复核/驳回追回+成就回收+连签重算/追认不动分
//   S3 测评兑积分（部分答对兑分/重交不重复/bookScores 伪造探针）
//   S4 回归底线（全页遍历零 pageerror/无登录过期误报/刷新保持登录态）
//   S5 数据终态校验
// 注意：本脚本只做断言与数据恢复，不修改任何业务代码。
// =====================================================================
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'http://localhost:8765';
const ROOT = 'D:/书香读书系统';
const SHOT = 'D:/tmp-ui-audit/qa-audit';
const EXE = 'C:/Users/蓝恩希/AppData/Local/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-win64/chrome-headless-shell.exe';
const TODAY = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

fs.mkdirSync(SHOT, { recursive: true });
const results = [];
let pageErrors = [];
const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond });
    console.log((cond ? '✓ PASS' : '✗ FAIL') + ' | ' + name + (detail ? ' | ' + String(detail).slice(0, 200) : ''));
    return !!cond;
};
const api = (method, p, body, token) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: 'localhost', port: 8765, path: p, method, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token, 'X-Token': token } : {})
    }}, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readDb = () => JSON.parse(fs.readFileSync(path.join(ROOT, '书会数据.json'), 'utf8'));

// 服务端积分公式（与 书会服务器.js 声称口径逐字一致，独立复刻用于交叉验证）
const clampInt = (v, lo, hi) => { const n = parseInt(v, 10); return isNaN(n) ? lo : Math.min(hi, Math.max(lo, n)); };
const FORMULA = (pages, minutes, reflLen, difficulty, totalPages) =>
    Math.floor(Math.max(0, pages) * 0.5 + Math.max(0, minutes) * 0.2 + Math.max(0, reflLen) / 10 +
               clampInt(difficulty, 1, 5) * 3 + Math.max(0, totalPages) / 40) + 1;

(async () => {
    // ================= S0 数据完整性 =================
    console.log('\n---------- S0 数据完整性 ----------');
    let db0;
    try { db0 = readDb(); ok('S0-1 书会数据.json 可解析', true); }
    catch (e) { ok('S0-1 书会数据.json 可解析', false, e.message); db0 = {}; }
    ok('S0-2 书目 100 本完整', (db0.books || []).length === 100, '实际 ' + (db0.books || []).length);
    const bk1 = path.join(ROOT, '书会数据.json.体检修复前备份');
    const bk2 = path.join(ROOT, '书会数据.json.错账清洗前备份');
    ok('S0-3 体检修复前备份在位', fs.existsSync(bk1));
    ok('S0-4 错账清洗前备份在位', fs.existsSync(bk2));
    try { JSON.parse(fs.readFileSync(bk1, 'utf8')); JSON.parse(fs.readFileSync(bk2, 'utf8')); ok('S0-5 备份文件均可解析', true); }
    catch (e) { ok('S0-5 备份文件均可解析', false, e.message); }
    const ach1 = (db0.achievements || []).find(a => a.id === 1);
    ok('S0-6 成就#1 字段正确（闻鸡起舞/continuous/7）',
        !!ach1 && ach1.name === '闻鸡起舞' && ach1.type === 'continuous' && ach1.target === 7,
        JSON.stringify(ach1));
    const alice0 = (db0.users || []).find(u => u.username === 'alice');
    ok('S0-7 rankHistory 含当日快照(' + TODAY + ')', (alice0.rankHistory || []).some(r => r.date === TODAY && r.rank >= 1),
        JSON.stringify(alice0.rankHistory || []));
    // 终态基线（用于 S5 比对；alice 的自有数据以声明终态为准，防上次运行残留污染基线）
    const CANON_DECLARED = { alice: { tp: 126, bob: 34, tester1: 48, admin: 0 } };
    const baseline = {};
    (db0.users || []).forEach(u => baseline[u.username] = {
        totalPoints: u.totalPoints, signCount: (u.records || []).length,
        continuousDays: u.continuousDays || 0, lastSignDate: u.lastSignDate || null,
        achievements: (u.achievements || []).slice().sort(),
        bookScores: JSON.parse(JSON.stringify(u.bookScores || {})),
        essays: JSON.parse(JSON.stringify(u.essays || {})),
        records: JSON.parse(JSON.stringify(u.records || [])),
        name: u.name, role: u.role
    });
    baseline.alice.totalPoints = 126; baseline.alice.signCount = 3;
    baseline.alice.continuousDays = 3; baseline.alice.lastSignDate = '2025-03-03';
    baseline.alice.achievements = []; baseline.alice.bookScores = { '三体': { score: 1, total: 1, date: '2026-10-24' } };
    baseline.alice.essays = {};
    // server.lock：二次启动被拒
    const second = spawnSync('node', ['书会服务器.js'], { cwd: ROOT, timeout: 15000, encoding: 'utf8' });
    ok('S0-8 server.lock 单实例：二次启动被拒(exit 1)',
        second.status === 1 && (second.stdout + second.stderr).includes('拒绝启动'),
        'exit=' + second.status + ' out=' + (second.stdout + second.stderr).replace(/\n/g, ' ').slice(0, 120));

    // ================= S1 安全面攻击模拟（API） =================
    console.log('\n---------- S1 攻击模拟（alice 令牌整包伪造） ----------');
    const aliceTok = (await api('PUT', '/api/login', { username: 'alice', password: '123456' })).body.token;
    ok('S1-0 alice 登录成功(密码已重置可用)', !!aliceTok);
    const adminTok = (await api('PUT', '/api/login', { username: 'admin', password: '258025' })).body.token;
    ok('S1-0b admin 登录成功', !!adminTok);

    // ---- 幂等自愈：上次运行若中途崩溃，alice 可能残留测评分/签到记录，先恢复到声明终态 ----
    const CANON_ALICE_RECORDS = [
        { date: '2025-03-01', bookTitle: '三体', pages: 40, minutes: 70, reflection: '黑暗森林法则令人震撼，宇宙社会学视角独特。', difficulty: 4, totalPages: 400, pointsEarned: 42, reviewed: true },
        { date: '2025-03-02', bookTitle: '三体', pages: 35, minutes: 60, reflection: '面壁者的智慧博弈精彩绝伦。', difficulty: 4, totalPages: 400, pointsEarned: 40, reviewed: true },
        { date: '2025-03-03', bookTitle: '小王子', pages: 120, minutes: 45, reflection: '驯养与告别，温柔而忧伤。', difficulty: 1, totalPages: 120, pointsEarned: 24, reviewed: true, finished: true }
    ];
    const CANON_ALICE_SCORES = { '三体': { score: 1, total: 1, date: '2026-10-24' } };
    {
        const fullPre = await api('GET', '/api/data', null, aliceTok);
        const p0 = {
            users: JSON.parse(JSON.stringify(fullPre.body.users)),
            achievements: fullPre.body.achievements, forum: fullPre.body.forum,
            notifications: fullPre.body.notifications || [], books: fullPre.body.books.map(({ content, ...b }) => b),
            activities: fullPre.body.activities
        };
        const me = p0.users.find(u => u.username === 'alice');
        me.records = JSON.parse(JSON.stringify(CANON_ALICE_RECORDS));
        me.bookScores = JSON.parse(JSON.stringify(CANON_ALICE_SCORES));
        me.essays = {};
        await api('PUT', '/api/data', p0, aliceTok);
        const a0 = (await api('GET', '/api/data', null, adminTok)).body.users.find(u => u.username === 'alice');
        ok('S0-9 自愈：alice 已恢复到终态基线(126)', a0.totalPoints === 126 && (a0.records || []).length === 3,
            'tp=' + a0.totalPoints + ' records=' + (a0.records || []).length);
    }

    const full0 = await api('GET', '/api/data', null, aliceTok);
    const mkPayload = () => ({
        users: JSON.parse(JSON.stringify(full0.body.users)),
        achievements: JSON.parse(JSON.stringify(full0.body.achievements)),
        forum: JSON.parse(JSON.stringify(full0.body.forum)),
        notifications: JSON.parse(JSON.stringify(full0.body.notifications || [])),
        books: JSON.parse(JSON.stringify(full0.body.books.map(({ content, ...b }) => b))),
        activities: JSON.parse(JSON.stringify(full0.body.activities))
    });
    const aliceSrv = () => api('GET', '/api/data', null, adminTok).then(r => r.body.users.find(u => u.username === 'alice'));
    const bobSrv = () => api('GET', '/api/data', null, adminTok).then(r => r.body.users.find(u => u.username === 'bob'));

    // 攻击1：伪造 role:'admin' + totalPoints:99999 + 成就全开 + 凭据字段
    {
        const p = mkPayload();
        const me = p.users.find(u => u.username === 'alice');
        me.role = 'admin'; me.totalPoints = 99999;
        me.achievements = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        me.achievementDates = { 1: TODAY, 7: TODAY };
        me.passHash = 'deadbeef'; me.salt = 'caffee'; me.password = 'hacked';
        await api('PUT', '/api/data', p, aliceTok);
        const a = await aliceSrv();
        ok('S1-1 伪造 role:"admin" 被剥离', a.role === 'member', 'role=' + a.role);
        ok('S1-2 伪造 totalPoints:99999 不生效', a.totalPoints === 126, 'tp=' + a.totalPoints);
        ok('S1-3 伪造成就全开被剥离', JSON.stringify((a.achievements || []).slice().sort()) === '[]', JSON.stringify(a.achievements));
        ok('S1-4 passHash/salt/password 未被写入', !a.passHash && !a.salt && !a.password);
    }
    // 攻击2：篡改 admin 与 bob 的数据（普通会员越权写他人）
    {
        const p = mkPayload();
        const adm = p.users.find(u => u.username === 'admin');
        if (adm) { adm.name = '被黑了的掌馆'; adm.totalPoints = 88888; }
        const bob = p.users.find(u => u.username === 'bob');
        if (bob) { bob.totalPoints = 77777; bob.records = bob.records || []; bob.records.push({ date: TODAY, bookTitle: '伪造之书', pointsEarned: 100 }); }
        await api('PUT', '/api/data', p, aliceTok);
        const dbNow = await api('GET', '/api/data', null, adminTok);
        const adm2 = dbNow.body.users.find(u => u.username === 'admin');
        const bob2 = dbNow.body.users.find(u => u.username === 'bob');
        ok('S1-5 无法篡改 admin 数据', adm2.name === baseline.admin.name && adm2.totalPoints === 0, 'name=' + adm2.name + ' tp=' + adm2.totalPoints);
        ok('S1-6 无法篡改 bob 数据/无伪造记录', bob2.totalPoints === 34 && !(bob2.records || []).some(r => r.bookTitle === '伪造之书'), 'tp=' + bob2.totalPoints);
    }
    // 攻击3：整包创建新用户（应被拒绝，注册必须走 /api/register）
    {
        const p = mkPayload();
        p.users.push({ username: 'hacker1', name: '黑客', role: 'admin', totalPoints: 500, records: [] });
        await api('PUT', '/api/data', p, aliceTok);
        const dbNow = await api('GET', '/api/data', null, adminTok);
        ok('S1-7 整包不能创建新用户 hacker1', !dbNow.body.users.some(u => u.username === 'hacker1'));
    }
    // 攻击4：会员篡改成就表（非掌馆整包应保留服务器现值）
    {
        const p = mkPayload();
        p.achievements = [{ id: 1, icon: '💀', name: '被黑成就', desc: 'x', type: 'continuous', target: 1 }];
        await api('PUT', '/api/data', p, aliceTok);
        const dbNow = await api('GET', '/api/data', null, adminTok);
        const a1 = (dbNow.body.achievements || []).find(x => x.id === 1);
        ok('S1-8 会员无法改成就表', a1 && a1.name === '闻鸡起舞', JSON.stringify(a1));
    }
    // 攻击5：伪造新记录 pointsEarned（带 needsServerScore 标记）→ 必须被公式重算
    {
        const p = mkPayload();
        const me = p.users.find(u => u.username === 'alice');
        me.records.push({ date: TODAY, bookTitle: '伪造积分之书', pages: 10, minutes: 20, reflection: '五十字心得'.padEnd(50, '字'), difficulty: 3, totalPages: 400, pointsEarned: 99999, reviewed: false, needsServerScore: true });
        await api('PUT', '/api/data', p, aliceTok);
        const a = await aliceSrv();
        const forged = (a.records || []).find(r => r.bookTitle === '伪造积分之书');
        const expect = FORMULA(10, 20, 50, 3, 400);   // = 34
        ok('S1-9 伪造 pointsEarned=99999 被服务器按公式重算为 ' + expect,
            forged && forged.pointsEarned === expect, '实际=' + (forged || {}).pointsEarned + ' 独立复算=' + expect);
        // 清理：移除该记录（自有数据合法写回）
        const p2 = mkPayload();
        p2.users.find(u => u.username === 'alice').records =
            p2.users.find(u => u.username === 'alice').records.filter(r => r.bookTitle !== '伪造积分之书');
        await api('PUT', '/api/data', p2, aliceTok);
    }
    // 攻击6【探针】：篡改历史记录 pointsEarned（不带 needsServerScore 标记）
    {
        const p = mkPayload();
        const me = p.users.find(u => u.username === 'alice');
        me.records[0].pointsEarned = 99999;   // 2025-03-01 三体 42 → 99999
        await api('PUT', '/api/data', p, aliceTok);
        const a = await aliceSrv();
        const r0 = (a.records || []).find(r => r.date === '2025-03-01');
        ok('S1-10【探针】篡改历史记录分(无 needsServerScore)也被重算/剥离',
            r0.pointsEarned === 42 && a.totalPoints === 126,
            '实际 record=' + r0.pointsEarned + ' tp=' + a.totalPoints + (r0.pointsEarned === 99999 ? ' ⚠ 历史分伪造生效！' : ''));
        // 无论结果如何恢复原状
        const p2 = mkPayload();
        p2.users.find(u => u.username === 'alice').records[0].pointsEarned = 42;
        await api('PUT', '/api/data', p2, aliceTok);
    }
    // 攻击7【探针】：篡改 bookScores 刷测评兑分
    {
        const p = mkPayload();
        const me = p.users.find(u => u.username === 'alice');
        me.bookScores = Object.assign({}, me.bookScores, { '伪造测评之书': { score: 100, total: 1, date: TODAY, awardedPoints: 2000 } });
        await api('PUT', '/api/data', p, aliceTok);
        const a = await aliceSrv();
        ok('S1-11【探针】伪造 bookScores(score100/total1) 无法刷分',
            a.totalPoints === 126, 'tp=' + a.totalPoints + (a.totalPoints > 126 ? ' ⚠ 测评兑分可伪造刷分！' : ''));
        // 恢复
        const p2 = mkPayload();
        p2.users.find(u => u.username === 'alice').bookScores = JSON.parse(JSON.stringify(baseline.alice.bookScores));
        await api('PUT', '/api/data', p2, aliceTok);
    }
    // 攻击8：未登录 GET 脱敏
    {
        const r = await api('GET', '/api/data');
        const u0 = (r.body.users || [])[0] || {};
        ok('S1-12 未登录 GET 返回 publicMode', r.body.publicMode === true);
        ok('S1-13 未登录 GET 无 records/essays/bookScores', !('records' in u0) && !('essays' in u0) && !('bookScores' in u0));
        ok('S1-14 未登录 GET 无站内信/批改登记表', (r.body.notifications || []).length === 0 && !('essayAwards' in r.body));
        ok('S1-15 未登录 GET 仍可见书目(公开数据)', (r.body.books || []).length === 100);
    }
    // 攻击9：无令牌写操作被拒
    {
        const r = await api('PUT', '/api/data', mkPayload());
        ok('S1-16 未登录 PUT /api/data 被拒(401)', r.status === 401, 'status=' + r.status);
    }

    // ================= S2 功能主链路（浏览器） =================
    console.log('\n---------- S2 浏览器主链路 ----------');
    const browser = await chromium.launch({ executablePath: EXE, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => {
        const u = route.request().url();
        return u.startsWith(BASE) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', d => d.accept());
    const expiredSeen = () => page.evaluate(() => document.body.innerText.includes('登录已过期'));

    // 访客阶段
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sleep(1500);
    ok('S2-0 访客加载无 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    ok('S2-0b 访客无「登录已过期」误报', !(await expiredSeen()));

    // alice 登录
    const loginAs = async (username, password) => {
        await page.evaluate(() => localStorage.clear());
        await page.goto(BASE + '/', { waitUntil: 'networkidle' });
        await sleep(1200);
        await page.click('.user-chip button:has-text("登录")');
        await page.fill('.dlg input[type="text"]', username);
        await page.fill('.dlg input[type="password"]', password);
        await page.click('.dlg button:has-text("登 录")');
        await sleep(1500);
    };
    await loginAs('alice', '123456');
    const chipA = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S2-1 alice 登录成功且积分 126', String(chipA).includes('126'), chipA);
    const aliceToken = await page.evaluate(() => localStorage.getItem('reading_club_token'));
    ok('S2-1b 登录令牌已存于 localStorage(reading_club_token)', !!aliceToken);

    // 签到（已知输入：10页/20分钟/50字心得/难度3/全书400页 → 期望 34 分）
    const REFL = ('回归验收专用心得，用于核对积分公式各项系数与服务端口径。'.repeat(3)).slice(0, 50);
    ok('S2-2 前置：心得恰为50字', REFL.length === 50, 'len=' + REFL.length);
    await page.click('.nav-card:has-text("每日签到")');
    await sleep(800);
    await page.fill('.sign-form input[list="bookList"]', '三体');
    await page.locator('.sign-form input[type="number"]').nth(0).fill('10');
    await page.locator('.sign-form input[type="number"]').nth(1).fill('20');
    await page.locator('.sign-form textarea').fill(REFL);
    await page.locator('.sign-form select').selectOption('3');
    await page.locator('.sign-form input[type="number"]').nth(2).fill('400');
    await page.screenshot({ path: SHOT + '/01-sign-form.png', fullPage: true });
    await page.click('button:has-text("落 印 签 到")');
    await sleep(1500);
    const toast1 = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('|'));
    ok('S2-3 签到 toast 提示即时入账(+34)', toast1.includes('+34') && toast1.includes('即时入账'), toast1.slice(0, 120));
    const chipB = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S2-4 UI 积分即时入账 126→160', String(chipB).includes('160'), chipB);
    // 榜单即时反映
    await page.click('button:has-text("← 返回")');
    await page.click('.nav-card:has-text("阅读积分榜")');
    await sleep(1000);
    const boardTxt = await page.evaluate(() => document.body.innerText);
    ok('S2-5 榜单即时反映新积分 160 / 今日+34', boardTxt.includes('160') && boardTxt.includes('+34'));
    await page.screenshot({ path: SHOT + '/02-leaderboard-instant.png', fullPage: true });
    // 服务器权威值双重断言
    let a1 = await aliceSrv();
    const recToday = (a1.records || []).find(r => r.date === TODAY);
    ok('S2-6 服务器记录 pointsEarned=34（=独立复算公式值）',
        recToday && recToday.pointsEarned === 34 && FORMULA(10, 20, 50, 3, 400) === 34,
        'srv=' + (recToday || {}).pointsEarned);
    ok('S2-7 签到后连签重算为 1（2025-03 与今日断档）', a1.continuousDays === 1 && a1.lastSignDate === TODAY,
        'cd=' + a1.continuousDays + ' last=' + a1.lastSignDate);
    ok('S2-8 签到后未误发成就#1（连签1<7）', (a1.achievements || []).length === 0, JSON.stringify(a1.achievements));

    // 掌馆驳回（UI）+ 成就回收
    await loginAs('admin', '258025');
    ok('S2-9 掌馆登录无 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    // 掌馆先给 alice 追加一枚成就（韦编三绝 #3，alice 仅 3 条记录不满足条件 → 用于验证「驳回可回收」）
    await api('PUT', '/api/admin/update-user', { username: 'alice', addAchievements: [3] }, adminTok);
    a1 = await aliceSrv();
    ok('S2-10 掌馆追加成就#3 成功', (a1.achievements || []).includes(3), JSON.stringify(a1.achievements));
    await page.click('.nav-card:has-text("掌馆事务")');
    await sleep(600);
    await page.locator('.fg:has(> label:text-is("掌馆密码")) input').fill('258025');
    await page.click('button:has-text("解 锁")');
    await sleep(1200);
    ok('S2-11 掌馆后台解锁（可见签到审核）', await page.evaluate(() => document.body.innerText.includes('签到审核')));
    const pendCard = page.locator('.pending-card', { hasText: TODAY }).filter({ hasText: '爱丽丝' });
    ok('S2-12 待审列表含 alice 今日记录(34分)', await pendCard.count() > 0 &&
        (await pendCard.first().innerText()).includes('34'), await pendCard.count() + ' 张待审卡');
    await page.screenshot({ path: SHOT + '/03-admin-pending.png', fullPage: true });
    await pendCard.first().locator('button:has-text("驳 回"), button:has-text("驳回")').first().click();
    await sleep(2000);
    const aliceRow = await page.locator('.member-row', { hasText: '爱丽丝' }).locator('.sub').first().innerText();
    ok('S2-13 驳回后 UI 积分追回 160→126', aliceRow.includes('积分 126'), aliceRow);
    ok('S2-14 驳回后 UI 成就回收（0 枚）', aliceRow.includes('成就 0 枚'), aliceRow);
    a1 = await aliceSrv();
    ok('S2-15 服务器：积分追回 126 且记录已删', a1.totalPoints === 126 && !(a1.records || []).some(r => r.date === TODAY && r.bookTitle === '三体'),
        'tp=' + a1.totalPoints + ' records=' + (a1.records || []).length);
    ok('S2-16 服务器：连签/lastSignDate 重算回 3 天 / 2025-03-03', a1.continuousDays === 3 && a1.lastSignDate === '2025-03-03',
        'cd=' + a1.continuousDays + ' last=' + a1.lastSignDate);
    ok('S2-17 服务器：成就#3 已回收', !(a1.achievements || []).includes(3), JSON.stringify(a1.achievements));
    const notifAdmin = await api('GET', '/api/data', null, adminTok);
    const an = (notifAdmin.body.notifications || []).filter(n => n.to === 'alice');
    ok('S2-18 驳回站内信（追回）已推送', an.some(n => n.text.includes('追回')), an.map(n => n.text).slice(0, 2).join(' / '));
    await page.screenshot({ path: SHOT + '/04-admin-rejected.png', fullPage: true });

    // 追认不动分：alice 再签一次（5页/10分钟/无心得/难度1/全书200页 → 期望 13 分）
    await loginAs('alice', '123456');
    await page.click('.nav-card:has-text("每日签到")');
    await sleep(800);
    await page.fill('.sign-form input[list="bookList"]', '三体');
    await page.locator('.sign-form input[type="number"]').nth(0).fill('5');
    await page.locator('.sign-form input[type="number"]').nth(1).fill('10');
    await page.locator('.sign-form select').selectOption('1');
    await page.locator('.sign-form input[type="number"]').nth(2).fill('200');
    await page.click('button:has-text("落 印 签 到")');
    await sleep(1500);
    const chipC = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S2-19 二次签到即时入账 126→139(+13)', String(chipC).includes('139'), chipC);
    await loginAs('admin', '258025');
    await page.click('.nav-card:has-text("掌馆事务")');
    await sleep(600);
    await page.locator('.fg:has(> label:text-is("掌馆密码")) input').fill('258025');
    await page.click('button:has-text("解 锁")');
    await sleep(1200);
    const pend2 = page.locator('.pending-card', { hasText: TODAY }).filter({ hasText: '爱丽丝' });
    ok('S2-20 待审列表含 alice 二次签到(13分)', await pend2.count() > 0 && (await pend2.first().innerText()).includes('13'));
    await pend2.first().locator('button:has-text("批准入账")').click();
    await sleep(2000);
    a1 = await aliceSrv();
    const recAppr = (a1.records || []).find(r => r.date === TODAY);
    ok('S2-21 追认不动分（仍 139）且 reviewed=true', a1.totalPoints === 139 && recAppr && recAppr.reviewed === true,
        'tp=' + a1.totalPoints + ' reviewed=' + (recAppr || {}).reviewed);
    const notif2 = await api('GET', '/api/data', null, adminTok);
    ok('S2-22 追认站内信已推送（保持入账措辞）', (notif2.body.notifications || []).filter(n => n.to === 'alice').some(n => n.text.includes('保持入账')));
    await page.screenshot({ path: SHOT + '/05-admin-approved.png', fullPage: true });

    // 清理：驳回追认记录，恢复基线（服务器 API 对已追认记录同样可驳回）
    const rej2 = await api('PUT', '/api/admin/record-review', { username: 'alice', date: TODAY, bookTitle: '三体', action: 'reject' }, adminTok);
    a1 = await aliceSrv();
    ok('S2-23 清理：已追认记录驳回后积分恢复 126', rej2.body.ok && a1.totalPoints === 126, 'tp=' + a1.totalPoints);

    // ================= S3 测评兑积分 =================
    console.log('\n---------- S3 测评兑积分 ----------');
    const dbBooks = (await api('GET', '/api/data', null, aliceTok)).body.books;
    // 选一本选择题≥8道的书（填空按错答处理、理解题不判分），答对前 8 道选择题 → 期望分可精确推算
    const testBook = dbBooks.find(b => {
        const qs = b.questions || [];
        return qs.length >= 10 && qs.filter(q => !q.type || q.type === 'choice').length >= 8;
    });
    ok('S3-0 找到含≥8道选择题的测评书《' + (testBook || {}).title + '》', !!testBook);
    const qs = testBook.questions || [];
    const choiceIdx = qs.map((q, i) => (!q.type || q.type === 'choice') ? i : -1).filter(i => i >= 0);
    const N_CORRECT = 8;
    const gradedTotal = qs.filter(q => q.type !== 'essay').length;   // 理解题不判分
    const EXP_SCORE = N_CORRECT;                                     // 前8道选择全对，填空/其余按错答
    const EXP_PTS = Math.floor((EXP_SCORE / gradedTotal) * 20);
    console.log('  [S3] 书=' + testBook.title + ' 题=' + qs.length + ' 判分题=' + gradedTotal + ' 期望得分=' + EXP_SCORE + ' 期望兑分=' + EXP_PTS);
    const answerItem = async (i, correct) => {
        const q = qs[i];
        const item = qItems.nth(i);
        if (q.type === 'essay') {
            await item.locator('textarea.q-input, textarea').first().fill('这是一条用于回归验收的理解题作答内容，长度超过十字。').catch(() => {});
            return;
        }
        if (q.type === 'blank') {
            await item.locator('input.q-input, textarea.q-input, input[type="text"]').first().fill('错答占位').catch(() => {});
            return;
        }
        const ans = q.ans;
        const pick = correct ? ans : (ans === 0 ? 1 : 0);
        await item.locator('.q-opt').nth(pick).click().catch(async () => {
            await item.locator('.q-opt').nth(0).click();
        });
    };
    const answerAll = async (correctFirst8Choices) => {
        let done = 0;
        for (let i = 0; i < (await qItems.count()); i++) {
            const isChoice = !qs[i].type || qs[i].type === 'choice';
            const correct = correctFirst8Choices && isChoice && choiceIdx.indexOf(i) < N_CORRECT;
            await answerItem(i, correct);
            if (correct) done++;
        }
        return done;
    };
    await loginAs('alice', '123456');
    await page.click('.nav-card:has-text("书库")');
    await sleep(1000);
    await page.locator('.shelf-book', { hasText: testBook.title }).first().click();
    await sleep(800);
    await page.click('button:has-text("开始思维测评")');
    await sleep(800);
    const qItems = page.locator('.q-item');
    const qCount = await qItems.count();
    ok('S3-1 测评卷题数一致', qCount === qs.length, qCount + ' vs ' + qs.length);
    await answerAll(true);
    await page.screenshot({ path: SHOT + '/06-test-answers.png', fullPage: true });
    await page.click('button:has-text("交 卷")');
    await sleep(1000);
    const dlgTxt = await page.evaluate(() => { const d = document.querySelector('.dlg'); return d ? d.innerText : ''; });
    ok('S3-2 交卷得分 ' + EXP_SCORE + '/' + gradedTotal, dlgTxt.includes(EXP_SCORE + '') && dlgTxt.includes('/ ' + gradedTotal), dlgTxt.slice(0, 80).replace(/\n/g, ' '));
    const toastT = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('|'));
    ok('S3-3 兑分 toast +' + EXP_PTS + '（floor(' + EXP_SCORE + '/' + gradedTotal + '×20)）', toastT.includes('+' + EXP_PTS), toastT.slice(0, 120));
    await page.click('button:has-text("收 卷")').catch(() => {});
    await sleep(1000);
    const chipT = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S3-4 UI 兑分入账 126→' + (126 + EXP_PTS), String(chipT).includes(String(126 + EXP_PTS)), chipT);
    a1 = await aliceSrv();
    ok('S3-5 服务器 bookScores 已入档且 totalPoints=' + (126 + EXP_PTS),
        a1.bookScores && a1.bookScores[testBook.title] && a1.bookScores[testBook.title].score === EXP_SCORE &&
        a1.totalPoints === 126 + EXP_PTS, JSON.stringify(a1.bookScores));
    // 重交不重复兑（交卷后停留在书目详情页，直接再次开始测评）
    await page.click('button:has-text("开始思维测评")');
    await sleep(800);
    await answerAll(true);
    await page.click('button:has-text("交 卷")');
    await sleep(1000);
    const chipT2 = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S3-6 同分重交不重复兑分（仍 ' + (126 + EXP_PTS) + '）', String(chipT2).includes(String(126 + EXP_PTS)), chipT2);
    await page.click('button:has-text("收 卷")').catch(() => {});
    await sleep(600);

    // ================= S4 回归底线：全页遍历 + 刷新保持登录态 =================
    console.log('\n---------- S4 回归底线 ----------');
    pageErrors = [];
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });   // S3 结束时在书目详情页，先回首页再遍历
    await sleep(1500);
    const navNames = ['阅读积分榜', '每日签到', '心得文苑', '藏经阁', '活动广场', '书库', '书会论坛', '成就勋章'];
    let navOk = 0;
    for (const n of navNames) {
        const cand = page.locator(`.nav-card:has-text("${n}")`);
        if (await cand.count()) {
            await cand.first().click();
            await sleep(700);
            await page.click('button:has-text("← 返回")').catch(() => {});
            await sleep(400);
            navOk++;
        }
    }
    ok('S4-1 会员全页遍历 ' + navOk + '/' + navNames.length + ' 页可进入', navOk >= navNames.length - 1);
    ok('S4-2 会员遍历零 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    ok('S4-3 遍历全程无「登录已过期」误报', !(await expiredSeen()));
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1500);
    const chipR = await page.locator('.user-chip .pts').innerText().catch(() => '');
    ok('S4-4 刷新后登录态保持（积分章仍在）', String(chipR).includes(String(126 + EXP_PTS)), chipR);
    ok('S4-5 刷新后无「登录已过期」', !(await expiredSeen()));
    await page.screenshot({ path: SHOT + '/07-member-after-reload.png', fullPage: false });

    // 掌馆视角遍历
    await loginAs('admin', '258025');
    await page.click('.nav-card:has-text("掌馆事务")');
    await sleep(600);
    await page.locator('.fg:has(> label:text-is("掌馆密码")) input').fill('258025');
    await page.click('button:has-text("解 锁")');
    await sleep(1000);
    await page.click('button:has-text("← 返回")').catch(() => {});
    for (const n of ['阅读积分榜', '心得文苑', '书库', '书会论坛', '活动广场']) {
        const cand = page.locator(`.nav-card:has-text("${n}")`);
        if (await cand.count()) { await cand.first().click(); await sleep(600); await page.click('button:has-text("← 返回")').catch(() => {}); await sleep(300); }
    }
    ok('S4-6 掌馆遍历零 pageerror', pageErrors.length === 0, pageErrors.join('; '));
    ok('S4-7 掌馆遍历无「登录已过期」', !(await expiredSeen()));

    // ================= S5 清理 + 数据终态校验 =================
    console.log('\n---------- S5 数据终态 ----------');
    // 清理 S3 遗留：alice 自有数据写回基线（bookScores/essays 恢复）
    {
        const p = mkPayload();
        const me = p.users.find(u => u.username === 'alice');
        me.bookScores = JSON.parse(JSON.stringify(baseline.alice.bookScores));
        me.essays = JSON.parse(JSON.stringify(baseline.alice.essays));
        await api('PUT', '/api/data', p, aliceTok);
    }
    const dbFinal = (await api('GET', '/api/data', null, adminTok)).body;
    for (const un of ['alice', 'bob', 'tester1', 'admin']) {
        const u = dbFinal.users.find(x => x.username === un);
        const b = baseline[un];
        const same = u.totalPoints === b.totalPoints && (u.records || []).length === b.signCount &&
            (u.continuousDays || 0) === b.continuousDays && (u.lastSignDate || null) === b.lastSignDate &&
            JSON.stringify((u.achievements || []).slice().sort()) === JSON.stringify(b.achievements) &&
            u.name === b.name && u.role === b.role;
        ok('S5-' + un + ' 终态还原（tp/记录/连签/成就/身份 与基线一致）', same,
            'tp=' + u.totalPoints + '/' + b.totalPoints + ' cd=' + u.continuousDays + '/' + b.continuousDays);
    }
    ok('S5-2 书目仍为 100 本', (dbFinal.books || []).length === 100);
    ok('S5-3 数据文件可解析且启动备份链在位', !!readDb() && fs.existsSync(path.join(ROOT, '数据备份')));

    await browser.close();

    // ================= 汇总 =================
    const fails = results.filter(r => !r.pass);
    console.log('\n==== 验收汇总: ' + (results.length - fails.length) + '/' + results.length + ' 通过 ====');
    fails.forEach(f => console.log('✗ FAIL | ' + f.name));
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('QA 审计脚本异常:', e); process.exit(2); });

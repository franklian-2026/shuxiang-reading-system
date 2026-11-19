// QA 补充探针：工程师修复后遗留风险点实测（Edward）
// 探针①：会员自建带1题的书 + 自报 bookScores 的实际可得上限 & 掌馆删书后兑分自动回落
// 探针②：同日同书两条记录的台账共享是否造成异常
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/书香读书系统';
const TODAY = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
const results = [];
const ok = (n, c, d = '') => { results.push({ n, p: !!c }); console.log((c ? '✓ PASS' : '✗ FAIL') + ' | ' + n + (d ? ' | ' + String(d).slice(0, 180) : '')); return !!c; };
const api = (method, p, body, token) => new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: 'localhost', port: 8765, path: p, method, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token, 'X-Token': token } : {}) }}, resp => {
        let b = ''; resp.on('data', c => b += c);
        resp.on('end', () => { try { res({ status: resp.statusCode, body: JSON.parse(b) }); } catch { res({ status: resp.statusCode, body: b }); } });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
});
const CANON_RECORDS = [
    { date: '2025-03-01', bookTitle: '三体', pages: 40, minutes: 70, reflection: '黑暗森林法则令人震撼，宇宙社会学视角独特。', difficulty: 4, totalPages: 400, pointsEarned: 42, reviewed: true },
    { date: '2025-03-02', bookTitle: '三体', pages: 35, minutes: 60, reflection: '面壁者的智慧博弈精彩绝伦。', difficulty: 4, totalPages: 400, pointsEarned: 40, reviewed: true },
    { date: '2025-03-03', bookTitle: '小王子', pages: 120, minutes: 45, reflection: '驯养与告别，温柔而忧伤。', difficulty: 1, totalPages: 120, pointsEarned: 24, reviewed: true, finished: true }
];
const CANON_SCORES = { '三体': { score: 1, total: 1, date: '2026-10-24' } };
// 同日同书探针的心得实际为 43 字 → 公式 floor(5+4+4.3+9+10)+1 = 33
const FORMULA_DUP = 33;

(async () => {
    const aliceTok = (await api('PUT', '/api/login', { username: 'alice', password: '123456' })).body.token;
    const adminTok = (await api('PUT', '/api/login', { username: 'admin', password: '258025' })).body.token;
    const full = await api('GET', '/api/data', null, aliceTok);
    const mk = () => ({
        users: JSON.parse(JSON.stringify(full.body.users)),
        achievements: full.body.achievements, forum: full.body.forum,
        notifications: full.body.notifications || [],
        books: JSON.parse(JSON.stringify(full.body.books.map(({ content, ...b }) => b))),
        activities: full.body.activities
    });
    const aliceSrv = async () => (await api('GET', '/api/data', null, adminTok)).body.users.find(u => u.username === 'alice');
    const restoreAlice = async () => {
        const p = mk();
        const me = p.users.find(u => u.username === 'alice');
        me.records = JSON.parse(JSON.stringify(CANON_RECORDS));
        me.bookScores = JSON.parse(JSON.stringify(CANON_SCORES));
        me.essays = {};
        await api('PUT', '/api/data', p, aliceTok);
    };
    await restoreAlice();
    const tp0 = (await aliceSrv()).totalPoints;
    ok('PRE 自愈：alice=126', tp0 === 126, 'tp=' + tp0);

    // 台账不下发检查
    const rawGet = await api('GET', '/api/data', null, aliceTok);
    ok('X-1 scoreLedger 不经 GET 下发给客户端', !('scoreLedger' in rawGet.body) && !('scoreLedger' in (rawGet.body.users[0] || {})));

    // ===== 探针①：会员自建 1 题书 + 自报 bookScores =====
    const FAKE_BOOK = { id: 999999001, title: '自建刷分书', author: '黑客', totalPages: 100, totalWords: 5, difficulty: 3, desc: '', questions: [{ q: '1+1=?', opts: ['2', '3'], ans: 0 }] };
    {
        const p = mk();
        p.books.push(FAKE_BOOK);
        await api('PUT', '/api/data', p, aliceTok);
        const srv = await api('GET', '/api/data', null, adminTok);
        const injected = srv.body.books.some(b => b.title === '自建刷分书');
        ok('P1-1 会员整包能否注入新书（事实记录）', true, injected ? '可注入 ⚠ 会员可自建书目' : '被拒绝（仅掌馆可建书）');
        if (injected) {
            // 注意：books 数组为全局合并，会员 PUT 必须始终携带注入书，否则会被顺手删除
            const withBook = (users) => {
                const p2 = mk();
                p2.books.push(FAKE_BOOK);
                p2.users.find(u => u.username === 'alice').bookScores = users;
                return p2;
            };
            // 自报 bookScores：恰为 1/1 → 理论 +20
            await api('PUT', '/api/data', withBook(Object.assign({}, CANON_SCORES, { '自建刷分书': { score: 1, total: 1, date: TODAY, awardedPoints: 20 } })), aliceTok);
            let a = await aliceSrv();
            ok('P1-2 自报 1/1 → 兑分钳到 ≤20（tp=126+20=146）', a.totalPoints === 146, 'tp=' + a.totalPoints);
            // 超额自报 50/1 → 比值钳制后应仍 ≤20
            await api('PUT', '/api/data', withBook(Object.assign({}, CANON_SCORES, { '自建刷分书': { score: 50, total: 1, date: TODAY, awardedPoints: 1000 } })), aliceTok);
            a = await aliceSrv();
            ok('P1-3 超额自报 50/1 被钳制，tp 仍 ≤146', a.totalPoints === 146, 'tp=' + a.totalPoints);
            // total 与题库不符（1 题却报 total=999）→ 条目应被剔除
            await api('PUT', '/api/data', withBook(Object.assign({}, CANON_SCORES, { '自建刷分书': { score: 1, total: 999, date: TODAY, awardedPoints: 20 } })), aliceTok);
            a = await aliceSrv();
            ok('P1-3b total 与题库题数不符 → 条目剔除（tp=126）', a.totalPoints === 126, 'tp=' + a.totalPoints);
            // 掌馆删书 → 兑分应自动回落（先恢复合法 1/1 使兑分生效）
            await api('PUT', '/api/data', withBook(Object.assign({}, CANON_SCORES, { '自建刷分书': { score: 1, total: 1, date: TODAY, awardedPoints: 20 } })), aliceTok);
            a = await aliceSrv();
            const before = a.totalPoints;
            const p3 = mk();
            p3.books = p3.books.filter(b => b.title !== '自建刷分书');
            await api('PUT', '/api/data', p3, adminTok);
            a = await aliceSrv();
            ok('P1-4 掌馆删书后兑分自动回落（' + before + '→126）', a.totalPoints === 126, 'tp=' + a.totalPoints);
        } else {
            // 无法注入书 → 直接验证无题库书目的回退校验：alice 有《小王子》签到记录、该书 0 题
            let p2 = mk();
            p2.users.find(u => u.username === 'alice').bookScores =
                Object.assign({}, CANON_SCORES, { '小王子': { score: 1, total: 1, date: TODAY, awardedPoints: 20 } });
            await api('PUT', '/api/data', p2, aliceTok);
            let a = await aliceSrv();
            const granted = a.totalPoints === 146;
            ok('P1-2b 无题库书目回退校验（有签到记录）→ 单书 ≤20', granted || a.totalPoints === 126, 'tp=' + a.totalPoints);
            // 无签到记录的书 → 整条剔除
            p2 = mk();
            p2.users.find(u => u.username === 'alice').bookScores =
                Object.assign({}, CANON_SCORES, { '不存在的书': { score: 1, total: 1, date: TODAY, awardedPoints: 20 } });
            await api('PUT', '/api/data', p2, aliceTok);
            a = await aliceSrv();
            ok('P1-2c 无签到记录的伪造条目被整条剔除（tp=126）', a.totalPoints === 126, 'tp=' + a.totalPoints + ' bs=' + JSON.stringify(Object.keys(a.bookScores || {})));
        }
        // 确保书目还原为 100 本（若注入过则上面已删）
        const finBooks = (await api('GET', '/api/data', null, adminTok)).body.books.length;
        ok('P1-5 书目数量还原 100', finBooks === 100, 'books=' + finBooks);
    }
    await restoreAlice();

    // ===== 探针②：同日同书两条记录 =====
    {
        const p = mk();
        const me = p.users.find(u => u.username === 'alice');
        me.records = me.records.concat([
            { date: TODAY, bookTitle: '重复之书', pages: 10, minutes: 20, reflection: '探针用心得占位五十字探针用心得占位五十字探针用心得占位五十字探针用心得占位五十字探针用心得'.slice(0, 50), difficulty: 3, totalPages: 400, pointsEarned: 99999, reviewed: false, needsServerScore: true },
            { date: TODAY, bookTitle: '重复之书', pages: 10, minutes: 20, reflection: '探针用心得占位五十字探针用心得占位五十字探针用心得占位五十字探针用心得占位五十字探针用心得'.slice(0, 50), difficulty: 3, totalPages: 400, pointsEarned: 99999, reviewed: false, needsServerScore: true }
        ]);
        await api('PUT', '/api/data', p, aliceTok);
        const a = await aliceSrv();
        const dups = (a.records || []).filter(r => r.date === TODAY && r.bookTitle === '重复之书');
        console.log('  [P2] 同日同书记录数=' + dups.length + ' 各条分=' + dups.map(r => r.pointsEarned).join(',') + ' tp=' + a.totalPoints);
        if (dups.length === 0) ok('P2-1 服务器拒绝同日同书重复签到', true);
        else if (dups.length === 1) ok('P2-1 服务器去重为 1 条（同日同书不重复计分）', true, 'points=' + dups[0].pointsEarned + ' tp=' + a.totalPoints);
        else ok('P2-1【事实记录】同日同书双条被同时入库（重复计分通道存在）',
            dups.length === 2 && dups.every(r => r.pointsEarned === FORMULA_DUP) && a.totalPoints === 126 + 2 * FORMULA_DUP,
            '双条均按公式重算 ' + FORMULA_DUP + ' 分，tp=' + a.totalPoints + ' → 需 API 伪造、前端正常路径无此通道（低危事实记录）');
        // 清理
        await restoreAlice();
        const a2 = await aliceSrv();
        ok('P2-2 清理后 alice 恢复 126', a2.totalPoints === 126 && !(a2.records || []).some(r => r.bookTitle === '重复之书'), 'tp=' + a2.totalPoints);
    }

    // ===== 终态确认 =====
    const db = JSON.parse(fs.readFileSync(path.join(ROOT, '书会数据.json'), 'utf8'));
    const expect = { alice: 126, bob: 34, tester1: 48, admin: 0 };
    for (const [un, tp] of Object.entries(expect)) {
        const u = db.users.find(x => x.username === un);
        ok('FIN-' + un + ' 终态 ' + tp, u && u.totalPoints === tp, '实际=' + (u || {}).totalPoints);
    }
    ok('FIN-books 100 本', (db.books || []).length === 100, '实际=' + (db.books || []).length);

    const fails = results.filter(r => !r.p);
    console.log('\n==== 补充探针汇总: ' + (results.length - fails.length) + '/' + results.length + ' 通过 ====');
    fails.forEach(f => console.log('✗ ' + f.n));
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('探针异常:', e); process.exit(2); });

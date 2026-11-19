// 书香读书会 · 错账清洗脚本（一次性）
// 依据统一口径重算所有用户的 totalPoints / continuousDays / signCount / lastSignDate，
// 修复损坏成就（#1 缺 type），清理 rankHistory 脏日期，并打印前后对照表。
//
// 统一口径（与 书会服务器.js / 前端 recomputeUser 完全一致）：
//   totalPoints = Σ记录分(pointsEarned，历史记录保留原值) + pointAdjust(掌馆调整) + 测评兑分(每书 floor(最佳分/总分)×20)
//   signCount = 记录数；lastSignDate = 最后记录日；continuousDays = 以最后签到日为终点的连续打卡链长
//
// pointAdjust 语义：若原 totalPoints 与重算差值为正且无来源说明，归零（不折算入 pointAdjust）并在报告中列出。
//
// 用法：node 清洗错账.js   （先自动备份 书会数据.json.错账清洗前备份，再写回）
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, '书会数据.json');

// ---------- 成就默认表（与前端/服务器一致） ----------
const ACH_TYPES = ['continuous', 'total', 'pages', 'minutes', 'reflections', 'rankFirst', 'topThree', 'achievements'];
const DEFAULT_ACHIEVEMENTS = [
    { id: 1,  icon: '🌅', name: '闻鸡起舞', desc: '连续打卡7天',   target: 7,    type: 'continuous' },
    { id: 2,  icon: '🌙', name: '雷打不动', desc: '连续打卡30天',  target: 30,   type: 'continuous' },
    { id: 3,  icon: '📚', name: '韦编三绝', desc: '累计打卡100天', target: 100,  type: 'total' },
    { id: 4,  icon: '🏆', name: '独占鳌头', desc: '积分榜第一保持7天', target: 7,  type: 'rankFirst' },
    { id: 5,  icon: '👑', name: '月度魁首', desc: '积分榜第一保持30天', target: 30, type: 'rankFirst' },
    { id: 6,  icon: '💪', name: '十年磨剑', desc: '连续打卡365天', target: 365,  type: 'continuous' },
    { id: 7,  icon: '📖', name: '初窥门径', desc: '累计阅读1000页', target: 1000, type: 'pages' },
    { id: 8,  icon: '🎓', name: '书山有路', desc: '累计阅读5000页', target: 5000, type: 'pages' },
    { id: 9,  icon: '⏳', name: '惜时如金', desc: '累计阅读100小时', target: 6000, type: 'minutes' },
    { id: 10, icon: '✒️', name: '妙笔生花', desc: '写下50条心得',  target: 50,   type: 'reflections' },
    { id: 11, icon: '🔥', name: '三甲常客', desc: '连续7天排名前三', target: 7,   type: 'topThree' },
    { id: 12, icon: '💎', name: '十全十美', desc: '同时拥有10枚成就', target: 10,  type: 'achievements' }
];

// ---------- 日期工具 ----------
const dateStr = (d = new Date()) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const parseYMD = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const shiftDate = (s, days) => {
    const d = parseYMD(s);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return dateStr(d);
};

// ---------- 重算逻辑 ----------
// 测评兑分钳制（与服务器 testPointsOf 同口径）：比值 ≤1；有题库的书 total 须匹配可计分题数；
// 无题库的书须有该会员的签到记录兜底
const testEntryValid = (user, title, s, books) => {
    if (!s || typeof s !== 'object') return false;
    const score = Number(s.score), total = Number(s.total);
    if (!isFinite(score) || !isFinite(total) || total <= 0 || score < 0) return false;
    const book = (books || []).find(b => b.title === title);
    if (book) {
        const scoredQ = (book.questions || []).filter(q => q && q.type !== 'essay').length;
        if (scoredQ > 0) return total === scoredQ;
    }
    return (user.records || []).some(r => r && r.bookTitle === title);
};
const testPointsOf = (user, books) => {
    let p = 0;
    const bs = user.bookScores || {};
    for (const t of Object.keys(bs)) {
        if (!testEntryValid(user, t, bs[t], books)) continue;
        const s = bs[t];
        p += Math.floor(Math.min(1, Number(s.score) / Number(s.total)) * 20);
    }
    return p;
};
const recomputeUserStats = (user) => {
    const recs = (user.records || []).filter(r => r && r.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    user.signCount = recs.length;
    user.lastSignDate = recs.length ? recs[recs.length - 1].date : null;
    let streak = 0;
    if (recs.length) {
        const set = new Set(recs.map(r => r.date));
        let cur = user.lastSignDate;
        while (cur && set.has(cur)) { streak++; cur = shiftDate(cur, -1); }
    }
    user.continuousDays = streak;
};
const recomputePoints = (user) => {
    const base = (user.records || []).reduce((s, r) => s + (r && r.pointsEarned ? r.pointsEarned : 0), 0);
    user.totalPoints = base + (typeof user.pointAdjust === 'number' ? user.pointAdjust : 0) + testPointsOf(user);
};
const eligibilityOf = (user, ach) => {
    const recs = user.records || [];
    switch (ach.type) {
        case 'total':       return recs.length >= ach.target;
        case 'pages':       return recs.reduce((s, r) => s + (r && r.pages || 0), 0) >= ach.target;
        case 'minutes':     return recs.reduce((s, r) => s + (r && r.minutes || 0), 0) >= ach.target;
        case 'reflections': return recs.filter(r => r && r.reflection && String(r.reflection).trim()).length >= ach.target;
        case 'continuous':  return (user.continuousDays || 0) >= ach.target;
        case 'rankFirst':
        case 'topThree': {
            const hist = [...(user.rankHistory || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
            const recent = hist.slice(-ach.target);
            const limit = ach.type === 'rankFirst' ? 1 : 3;
            return recent.length >= ach.target && recent.every(r => r.rank <= limit);
        }
        case 'achievements': return (user.achievements || []).length >= ach.target;
        default: return false;
    }
};
const recomputeAchievementsFull = (user, achievements) => {
    const prevAch = [...(user.achievements || [])];
    const prevDates = { ...(user.achievementDates || {}) };
    const kept = [];
    for (const ach of achievements) {
        if (!ach || !ACH_TYPES.includes(ach.type) || !(parseInt(ach.target, 10) > 0)) continue;
        if (ach.type === 'achievements') continue;
        if (eligibilityOf(user, ach)) kept.push(ach);
    }
    for (const ach of achievements) {
        if (ach && ach.type === 'achievements' && parseInt(ach.target, 10) > 0 && kept.length >= ach.target) kept.push(ach);
    }
    user.achievements = kept.map(a => a.id);
    user.achievementDates = {};
    kept.forEach(a => { user.achievementDates[a.id] = prevDates[a.id] || dateStr(); });
    return { lost: prevAch.filter(id => !user.achievements.includes(id)) };
};

// ---------- 主流程 ----------
const main = () => {
    // 0. 备份
    const BACKUP = DATA_FILE + '.错账清洗前备份';
    if (!fs.existsSync(BACKUP)) fs.copyFileSync(DATA_FILE, BACKUP);
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const report = [];

    // 1. 修复成就表：损坏条目（缺 type/非法 type/非法 target）以默认表恢复
    const fixedAch = [];
    const seen = new Set();
    const byId = {};
    DEFAULT_ACHIEVEMENTS.forEach(a => byId[a.id] = a);
    const cleanAch = [];
    for (const a of (d.achievements || [])) {
        if (!a || typeof a.id !== 'number' || seen.has(a.id)) { fixedAch.push('丢弃无效/重复条目 ' + JSON.stringify(a)); continue; }
        seen.add(a.id);
        const def = byId[a.id];
        if (!ACH_TYPES.includes(a.type) || !(parseInt(a.target, 10) > 0)) {
            if (def) {
                cleanAch.push({ ...def });
                fixedAch.push(`成就 #${a.id}「${a.name}」损坏（缺 type 或 target 非法）→ 已恢复为默认表「${def.name} · ${def.desc}」`);
            } else {
                cleanAch.push(a);
                fixedAch.push(`成就 #${a.id} 缺合法 type 且不在默认表中 → 保留原条目，请掌馆在成就编辑器中修正`);
            }
        } else {
            cleanAch.push(a);
        }
    }
    d.achievements = cleanAch;

    // 2. 清理 rankHistory 脏日期：非法格式 / 未来日期 / 同日重复
    const today = dateStr();
    const rankReport = [];
    (d.users || []).forEach(u => {
        if (!Array.isArray(u.rankHistory)) { u.rankHistory = []; return; }
        const byDate = {};
        const kept = [];
        for (const r of u.rankHistory) {
            if (!r || !parseYMD(r.date)) { rankReport.push(`${u.username}: 丢弃非法日期 ${JSON.stringify(r)}`); continue; }
            const dt = parseYMD(r.date);
            if (dt > parseYMD(today)) { rankReport.push(`${u.username}: 丢弃未来日期 ${r.date}`); continue; }
            if (byDate[r.date]) { rankReport.push(`${u.username}: 同日重复快照 ${r.date}（保留 rank ${r.rank}）`); }
            byDate[r.date] = { date: r.date, rank: parseInt(r.rank, 10) || 99 };
        }
        u.rankHistory = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    });

    // 3. 逐用户重算统计与积分（前后对照）
    const rows = [];
    (d.users || []).forEach(u => {
        const before = {
            totalPoints: u.totalPoints, signCount: u.signCount,
            continuousDays: u.continuousDays, lastSignDate: u.lastSignDate,
            achievements: [...(u.achievements || [])]
        };
        // 统计口径
        recomputeUserStats(u);
        // 积分口径：pointAdjust 语义保留；原值与重算差值为正且无来源说明 → 归零并列出
        const base = (u.records || []).reduce((s, r) => s + (r && r.pointsEarned ? r.pointsEarned : 0), 0);
        const tp = testPointsOf(u, d.books || []);
        const residual = (before.totalPoints || 0) - base - tp - (typeof u.pointAdjust === 'number' ? u.pointAdjust : 0);
        if (residual > 0 && (u.pointAdjust === undefined || u.pointAdjust === 0)) {
            report.push(`${u.username}: 原积分 ${before.totalPoints} 比应得值（记录 ${base} + 测评兑分 ${tp}）多出 ${residual} 分，无来源说明 → 已归零清除`);
        } else if (residual > 0) {
            report.push(`${u.username}: 原积分比重算值多出 ${residual} 分（pointAdjust=${u.pointAdjust} 已保留，请掌馆核对）`);
        } else if (residual < 0) {
            report.push(`${u.username}: 原积分比重算值少 ${-residual} 分 → 已按统一口径补正`);
        }
        recomputePoints(u);
        // 成就全量重推导（可回收）
        const { lost } = recomputeAchievementsFull(u, d.achievements);
        const achNames = (ids) => ids.map(id => {
            const a = d.achievements.find(x => x.id === id);
            return a ? `#${id}「${a.name}」` : '#' + id;
        }).join('、') || '无';
        if (lost.length) report.push(`${u.username}: 成就回收 → ${achNames(lost)}`);
        rows.push({
            username: u.username, role: u.role || 'member',
            before, after: {
                totalPoints: u.totalPoints, signCount: u.signCount,
                continuousDays: u.continuousDays, lastSignDate: u.lastSignDate,
                achievements: [...(u.achievements || [])]
            }
        });
    });

    // 4. 写回
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));

    // 5. 打印前后对照表
    const pad = (s, n) => String(s).padEnd(n, ' ');
    console.log('==== 错账清洗报告 ====');
    console.log('备份: ' + BACKUP);
    console.log('');
    if (fixedAch.length) {
        console.log('-- 成就表修复 --');
        fixedAch.forEach(x => console.log('  ' + x));
        console.log('');
    }
    if (rankReport.length) {
        console.log('-- rankHistory 清理 --');
        rankReport.forEach(x => console.log('  ' + x));
        console.log('');
    } else {
        console.log('-- rankHistory 清理 --');
        console.log('  未发现脏日期');
        console.log('');
    }
    console.log('-- 用户前后对照 --');
    console.log(pad('用户', 10) + pad('积分 前→后', 18) + pad('签到 前→后', 14) + pad('连签 前→后', 14) + pad('成就 前→后', 20));
    rows.forEach(r => {
        console.log(
            pad(r.username, 10) +
            pad(`${r.before.totalPoints ?? '∅'}→${r.after.totalPoints}`, 18) +
            pad(`${r.before.signCount ?? '∅'}→${r.after.signCount}`, 14) +
            pad(`${r.before.continuousDays ?? '∅'}→${r.after.continuousDays}`, 14) +
            pad(`[${r.before.achievements.join(',')}]→[${r.after.achievements.join(',')}]`, 20)
        );
    });
    console.log('');
    if (report.length) {
        console.log('-- 明细说明 --');
        report.forEach(x => console.log('  ' + x));
    } else {
        console.log('-- 明细说明 -- 无需修正项');
    }
    console.log('');
    console.log('清洗完成 ✓');
};

try { main(); } catch (e) { console.error('清洗失败: ' + e.message); process.exit(1); }

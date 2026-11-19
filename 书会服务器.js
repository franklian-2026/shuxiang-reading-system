// 书香读书会 · 局域网服务器 v3（积分权威重构版）
// 静态页面 + 数据同步 API + 用户认证
//   - 密码使用 scrypt 加盐哈希存储，永不明文落盘/下发
//   - 登录签发 HMAC 签名令牌（30 天有效），写操作需携带令牌
//   - 启动时自动迁移旧版明文密码，并自动备份 数据备份/ 目录
//   - 积分唯一权威：记录分按 POINTS_FORMULA 服务端重算；totalPoints = Σ记录分 + pointAdjust + 测评兑分
//   - 整包同步字段级白名单：role/totalPoints/pointAdjust/achievements/凭据一律服务端裁决
// 数据存放于同目录 书会数据.json，全会设备共享
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, '书会数据.json');
const SECRET_FILE = path.join(ROOT, '.会话密钥');
const BACKUP_DIR = path.join(ROOT, '数据备份');
const LOCK_FILE = path.join(ROOT, 'server.lock');
const PORT = 8765;
const TOKEN_TTL = 30 * 24 * 3600 * 1000;   // 令牌有效期 30 天
const EMPTY = { users: [], achievements: [], forum: [], notifications: [], books: [], activities: [] };

// ---------- 单实例守卫：server.lock 写入 pid，异常退出残留时检测进程存活 ----------
const acquireLock = () => {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
            let alive = false;
            try { process.kill(pid, 0); alive = pid !== process.pid; }
            catch (e) { alive = e.code === 'EPERM' && pid !== process.pid; }
            if (alive) {
                console.error('检测到书香服务器已在运行 (pid ' + pid + ')，本实例拒绝启动。');
                console.error('如确认无实例运行，请删除 ' + LOCK_FILE + ' 后重试。');
                return false;
            }
            console.log('发现残留锁文件 (pid ' + pid + ' 已退出)，本实例接管。');
        }
    } catch {}
    try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) {
        console.error('无法写入锁文件：' + e.message);
        return false;
    }
    return true;
};
const removeLock = () => {
    try {
        if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
    } catch {}
};
if (!acquireLock()) process.exit(1);
process.on('exit', removeLock);
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => { removeLock(); process.exit(0); }));

// ---------- 数据读写（原子写） ----------
const readData = () => {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return JSON.parse(JSON.stringify(EMPTY)); }
};
const writeData = (d) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, DATA_FILE);
};
let db = readData();

// ---------- 积分公式（全系统唯一权威定义，前端 calcPoints 仅作预览展示） ----------
const clampInt = (v, lo, hi) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? lo : Math.min(hi, Math.max(lo, n));
};
const POINTS_FORMULA = (pages, minutes, reflLen, difficulty, totalPages) =>
    Math.floor(Math.max(0, pages) * 0.5 + Math.max(0, minutes) * 0.2 + Math.max(0, reflLen) / 10 +
               clampInt(difficulty, 1, 5) * 3 + Math.max(0, totalPages) / 40) + 1;
// 测评兑积分：每本书按最佳分兑换，上限 20 分。
// 防伪造钳制：
//   1) score/total 必须为有限非负数且 total > 0，比值钳到 ≤1（单本书上限 20 不变）；
//   2) 书库中该书有题库时，total 必须等于可计分题数（choice/blank），否则整条剔除；
//   3) 无题库的书目（历史数据）回退校验：该会员必须确有此书的签到记录（读过才有测评资格）。
const TEST_POINTS_MAX = 20;
const testPointsOf = (user) => {
    let p = 0;
    const bs = user.bookScores || {};
    for (const t of Object.keys(bs)) {
        if (!testEntryValid(user, t, bs[t])) continue;
        const s = bs[t];
        const score = Number(s.score), total = Number(s.total);
        p += Math.floor(Math.min(1, score / total) * TEST_POINTS_MAX);
    }
    return p;
};
const testEntryValid = (user, title, s) => {
    if (!s || typeof s !== 'object') return false;
    const score = Number(s.score), total = Number(s.total);
    if (!isFinite(score) || !isFinite(total) || total <= 0 || score < 0) return false;
    const book = (db.books || []).find(b => b.title === title);
    if (book) {
        const scoredQ = (book.questions || []).filter(q => q && q.type !== 'essay').length;
        if (scoredQ > 0) return total === scoredQ;   // 有题库：总数必须精确匹配
    }
    // 无题库（或书已被删）：须有该书的签到记录兜底证明测评资格
    return (user.records || []).some(r => r && r.bookTitle === title);
};
// 非法形状/来源不明的 bookScores 条目整条剔除（不计分也不留存）
const sanitizeBookScores = (user) => {
    if (!user.bookScores || typeof user.bookScores !== 'object') return;
    const bs = user.bookScores;
    Object.keys(bs).forEach(t => {
        if (!testEntryValid(user, t, bs[t])) delete bs[t];
    });
};

// ---------- 记录分台账（服务器独占保管，客户端不可写） ----------
// 防伪造：pointsEarned 一律不信任客户端传值——
//   · 启动时为数据文件中的全部历史记录登记台账（初值 = 现有 pointsEarned，已由清洗错账.js 对齐）；
//   · 之后每次整包同步，pointsEarned 从台账权威回填（客户端改成多少都无效）；
//   · 台账未登记的首见记录（新签到）无条件按 POINTS_FORMULA 从原始字段重算并登记；
//   · 掌馆驳回删除记录时同步注销台账，重签按新数据重算。
const scoreLedgerKey = (username, r) => username + '|' + String(r && r.date || '') + '|' + String(r && r.bookTitle || '');
if (!db.scoreLedger || typeof db.scoreLedger !== 'object') db.scoreLedger = {};
(() => {
    let seeded = 0;
    (db.users || []).forEach(u => {
        (u.records || []).forEach(r => {
            if (!r || typeof r !== 'object') return;
            const key = scoreLedgerKey(u.username, r);
            if (db.scoreLedger[key] === undefined) {
                db.scoreLedger[key] = (typeof r.pointsEarned === 'number' && r.pointsEarned >= 0) ? r.pointsEarned : 0;
                seeded++;
            }
        });
    });
    if (seeded) {
        writeData(db);
        console.log('记录分台账初始化: ' + seeded + ' 条历史记录已登记（此后 pointsEarned 以台账为准，客户端伪造无效）');
    }
})();
// 首见记录的原始字段钳制边界（防伪造极端原始值刷分；超出部分由掌馆审核治理）
const applyScoreLedger = (user) => {
    (user.records || []).forEach(r => {
        if (!r || typeof r !== 'object') return;
        const key = scoreLedgerKey(user.username, r);
        if (db.scoreLedger[key] !== undefined) {
            r.pointsEarned = db.scoreLedger[key];   // 台账权威回填
        } else {
            // 首见记录：不信任客户端 pointsEarned，一律按公式从原始字段重算
            r.pages = clampInt(r.pages, 0, 1000);
            r.minutes = clampInt(r.minutes, 0, 1440);
            r.totalPages = clampInt(r.totalPages, 0, 10000);
            r.difficulty = clampInt(r.difficulty, 1, 5);
            r.reflection = String(r.reflection || '').slice(0, 500);
            const pts = POINTS_FORMULA(r.pages, r.minutes, r.reflection.length, r.difficulty, r.totalPages);
            r.pointsEarned = pts;
            db.scoreLedger[key] = pts;
        }
        delete r.needsServerScore;
    });
};
// 统计口径重算：signCount / lastSignDate / continuousDays（以最后签到日为终点的连续链）
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
// 总积分 = Σ记录分 + 掌馆手工调整分(pointAdjust) + 测评兑分
const recomputePoints = (user) => {
    const base = (user.records || []).reduce((s, r) => s + (r && r.pointsEarned ? r.pointsEarned : 0), 0);
    user.totalPoints = base + (typeof user.pointAdjust === 'number' ? user.pointAdjust : 0) + testPointsOf(user);
};

// ---------- 成就体系 ----------
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
// 启动自愈：修复损坏的成就条目（如缺 type 的 {id:1,...}），以默认表为准
(() => {
    let fixed = 0;
    const byId = {};
    DEFAULT_ACHIEVEMENTS.forEach(a => byId[a.id] = a);
    const seen = new Set();
    const clean = [];
    for (const a of (db.achievements || [])) {
        if (!a || typeof a.id !== 'number' || seen.has(a.id)) { fixed++; continue; }
        seen.add(a.id);
        const def = byId[a.id];
        if (def && (!ACH_TYPES.includes(a.type) || !(parseInt(a.target, 10) > 0))) {
            clean.push({ ...def });
            fixed++;
        } else {
            clean.push(a);
        }
    }
    if (fixed) {
        db.achievements = clean;
        writeData(db);
        console.log('成就表已修复 ' + fixed + ' 处损坏/重复条目');
    }
})();
// 单个成就是否达成
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
// 站内信（服务器侧推送）
const timeNowStr = () => {
    const d = new Date();
    return dateStr() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const pushNotification = (user, text, link = 'sign') => {
    if (!user || !user.username) return;
    db.notifications = db.notifications || [];
    db.notifications.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        to: user.username, text, time: timeNowStr(), read: false, link
    });
};
// 只授予不回收的成就判定（会员日常签到/同步时触发；回收仅在掌馆驳回等全量重推导时发生）
const grantAchievements = (user) => {
    const granted = [];
    for (const ach of (db.achievements || [])) {
        if (!ach || !ACH_TYPES.includes(ach.type) || !(parseInt(ach.target, 10) > 0)) continue;
        if ((user.achievements || []).includes(ach.id)) continue;
        if (eligibilityOf(user, ach)) {
            user.achievements = user.achievements || [];
            user.achievementDates = user.achievementDates || {};
            user.achievements.push(ach.id);
            user.achievementDates[ach.id] = dateStr();
            granted.push(ach);
        }
    }
    granted.forEach(ach => pushNotification(user, `🎉 恭喜解锁成就「<b>${ach.name}</b>」`, 'achievements'));
    return granted;
};
// 全量重推导：按当前全部有效记录从头判定（可回收），驳回签到时调用
const recomputeAchievementsFull = (user) => {
    const prevAch = [...(user.achievements || [])];
    const prevDates = { ...(user.achievementDates || {}) };
    const kept = [];
    for (const ach of (db.achievements || [])) {
        if (!ach || !ACH_TYPES.includes(ach.type) || !(parseInt(ach.target, 10) > 0)) continue;
        if (ach.type === 'achievements') continue;   // 二阶段判定
        if (eligibilityOf(user, ach)) kept.push(ach);
    }
    for (const ach of (db.achievements || [])) {
        if (ach && ach.type === 'achievements' && parseInt(ach.target, 10) > 0 && kept.length >= ach.target) kept.push(ach);
    }
    user.achievements = kept.map(a => a.id);
    user.achievementDates = {};
    kept.forEach(a => { user.achievementDates[a.id] = prevDates[a.id] || dateStr(); });
    const lost = prevAch.filter(id => !user.achievements.includes(id));
    const gained = user.achievements.filter(id => !prevAch.includes(id));
    return { lost, gained };
};

// ---------- 启动备份（保留最近 10 份） ----------
try {
    if (fs.existsSync(DATA_FILE)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const name = '书会数据-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
        const olds = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
        while (olds.length > 10) fs.unlinkSync(path.join(BACKUP_DIR, olds.shift()));
    }
} catch (e) { console.log('启动备份失败: ' + e.message); }

// ---------- 旧数据迁移：明文 password → scrypt 哈希 ----------
let migrated = 0;
(db.users || []).forEach(u => {
    if (u && typeof u.password === 'string' && u.password && !u.passHash) {
        const salt = crypto.randomBytes(16).toString('hex');
        u.salt = salt;
        u.passHash = crypto.scryptSync(u.password, salt, 64).toString('hex');
        delete u.password;
        migrated++;
    }
});
if (migrated) { writeData(db); console.log('已迁移 ' + migrated + ' 个账户的明文密码为加密哈希'); }

// ---------- 会话密钥（多密钥兼容，跨实例一致） ----------
// 根因：发布环境多进程实例并存且代际不一——旧实例用密钥文件的密钥，新实例用派生密钥，
// 登录与验证随机落在不同实例上就会「刚登录就过期」。
// 方案：签名固定用「密钥文件」值（会话密钥.key 随包分发，新旧实例都认它）；
//       验证时依次尝试 [签名密钥, 派生密钥]，任一匹配即通过。
// 副作用（预期行为）：更换密钥文件或修改掌馆人密码会使旧令牌逐步失效。
const DERIVED_SECRET = (() => {
    const adminSeed = (db.users || []).find(u => u.username === 'admin' && u.passHash && u.salt);
    return adminSeed
        ? crypto.createHmac('sha256', '书香读书系统-会话密钥种子').update(adminSeed.passHash + '.' + adminSeed.salt).digest()
        : null;
})();
let FILE_SECRET = null;
try { FILE_SECRET = fs.readFileSync(path.join(ROOT, '会话密钥.key')); } catch {}
try { FILE_SECRET = FILE_SECRET || fs.readFileSync(SECRET_FILE); } catch {}
let SECRET;
if (FILE_SECRET && FILE_SECRET.length >= 32) {
    SECRET = FILE_SECRET;
    console.log('会话密钥：使用密钥文件（跨实例一致）');
} else if (DERIVED_SECRET) {
    SECRET = DERIVED_SECRET;
    console.log('会话密钥：从掌馆人凭据派生（未找到密钥文件）');
} else {
    SECRET = crypto.randomBytes(48);
    try { fs.writeFileSync(SECRET_FILE, SECRET); } catch {}
    console.log('会话密钥：随机生成（无密钥文件且无掌馆人凭据）');
}
const VERIFY_SECRETS = [...new Set([SECRET, DERIVED_SECRET].filter(Boolean))];

// ---------- 令牌：payload.hmac（无状态，重启后仍有效） ----------
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (user) => {
    const payload = b64url(JSON.stringify({ u: user.username, r: user.role || 'member', e: Date.now() + TOKEN_TTL }));
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
};
const verifyToken = (token) => {
    if (!token || typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const payload = token.slice(0, i), sig = token.slice(i + 1);
    // 多密钥验证：任一密钥匹配即通过（兼容多代实例签发的令牌）
    let matched = null;
    for (const sk of VERIFY_SECRETS) {
        const expect = crypto.createHmac('sha256', sk).update(payload).digest('base64url');
        const a = Buffer.from(sig), b = Buffer.from(expect);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) { matched = sk; break; }
    }
    if (!matched) return null;
    let d;
    try { d = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch { return null; }
    if (!d.u || !d.e || Date.now() > d.e) return null;
    const user = (db.users || []).find(x => x.username === d.u);
    if (!user) return null;
    return { username: d.u, role: user.role || 'member', user };
};
const getAuth = (req) => {
    // 三通道鉴权：标准 Authorization 头 / X-Token 头 / URL 参数 token
    // 依次尝试所有通道，任一验签通过即可（某通道值损坏不应否定其余通道）
    const cands = [];
    const m = String(req.headers['authorization'] || '').match(/^Bearer (.+)$/);
    if (m) cands.push(m[1]);
    const xt = String(req.headers['x-token'] || '').trim();
    if (xt) cands.push(xt);
    try {
        const q = new URL(req.url, 'http://local').searchParams.get('token');
        if (q) cands.push(q);
    } catch {}
    for (const t of cands) {
        const a = verifyToken(t);
        if (a) return a;
    }
    return null;
};

// ---------- 密码工具 ----------
const verifyPassword = (user, pw) => {
    if (!user || !user.passHash || !user.salt) return false;
    const h = crypto.scryptSync(String(pw), user.salt, 64);
    const stored = Buffer.from(user.passHash, 'hex');
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
};
const setHashedPassword = (user, pw) => {
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passHash = crypto.scryptSync(String(pw), user.salt, 64).toString('hex');
    delete user.password;
};
const sanitizeUser = (u) => {
    const { password, passHash, salt, ...rest } = u;
    return rest;
};

// ---------- 整包同步：字段级白名单 ----------
// 服务端裁决字段（任何客户端整包都改不动）：role / totalPoints / pointAdjust / achievements /
// achievementDates / passHash / salt / password —— 权限与积分一律由服务器计算与专属掌馆端点裁决。
// 客户端可写业务字段：仅限「本人」的数据（掌馆可写全部成员的业务字段）。
const SELF_FIELDS = ['name', 'records', 'essays', 'bookScores', 'readProgress', 'rankHistory'];
const mergeUsers = (incoming, auth) => {
    const isAdmin = !!(auth && auth.role === 'admin');
    const self = auth ? auth.username : null;
    const prevList = db.users || [];
    const list = [];
    for (const u of incoming) {
        if (!u || typeof u !== 'object' || typeof u.username !== 'string' || !u.username.trim()) continue;
        const prev = prevList.find(x => x.username === u.username);
        if (!prev) continue;                       // 新用户一律走 /api/register，不接受整包创建
        const isSelf = prev.username === self;
        if (!isSelf && !isAdmin) continue;         // 非掌馆不能动其他用户的数据
        const merged = { ...prev };
        for (const f of SELF_FIELDS) {
            if (u[f] !== undefined && u[f] !== null) merged[f] = u[f];
        }
        list.push(merged);
    }
    // 保留服务器上存在而客户端未提交的用户
    for (const prev of prevList) {
        if (!list.some(x => x.username === prev.username)) list.push(prev);
    }
    return list;
};
// 成就表：仅掌馆可经整包写入，逐条校验合法性
const sanitizeAchievements = (list) => {
    const out = [];
    const seen = new Set();
    for (const a of list) {
        if (!a || typeof a !== 'object' || typeof a.id !== 'number' || seen.has(a.id)) continue;
        const type = String(a.type || '');
        const target = parseInt(a.target, 10);
        if (!ACH_TYPES.includes(type) || !(target > 0)) continue;
        seen.add(a.id);
        out.push({
            id: a.id,
            icon: String(a.icon || '🏅').slice(0, 8),
            name: String(a.name || '').slice(0, 20),
            desc: String(a.desc || '').slice(0, 60),
            type, target
        });
    }
    return out;
};
// 站内信按 id 并集合并：服务器推送的通知（驳回/成就授予/批改）不被客户端整包覆盖，
// 客户端新增的通知（点赞/回帖/升段）照常并入；上限 500 条防膨胀
const mergeNotifications = (incoming) => {
    const map = new Map();
    (db.notifications || []).forEach(n => { if (n && n.id != null) map.set(n.id, n); });
    (Array.isArray(incoming) ? incoming : []).forEach(n => {
        if (!n || n.id == null) return;
        if (!map.has(n.id)) map.set(n.id, n);
    });
    return [...map.values()].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-500);
};
const dateStr = (d = new Date()) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// ---------- 登录失败限速：同 IP 5 分钟内最多 15 次失败 ----------
const fails = new Map();
const tooManyFails = (ip) => {
    const f = fails.get(ip);
    return !!(f && f.n >= 15 && Date.now() - f.t < 5 * 60 * 1000);
};
const recordFail = (ip) => {
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t >= 5 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
    f.n++;
    fails.set(ip, f);
};

// ---------- HTTP 工具 ----------
const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
});
// 原始字节流读取（书籍文件上传用，上限 200MB）
const BOOK_MAX = 210e6;
const readRawBody = (req, cap = BOOK_MAX) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
        size += c.length;
        if (size > cap) { req.destroy(); reject(new Error('文件过大（上限 200MB）')); return; }
        chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});
const clientIp = (req) => req.socket.remoteAddress || '?';

// ---------- 书籍内容（在线阅读器书源） ----------
// 正文文件存于 books_content/ 目录，元数据存于 db.bookContent（以书名为键，由服务器独占保管，
// 客户端整包同步时不接收也不覆盖，防止旧数据把书源冲掉）
const BOOKS_DIR = path.join(ROOT, 'books_content');
try { fs.mkdirSync(BOOKS_DIR, { recursive: true }); } catch {}
if (!db.bookContent || typeof db.bookContent !== 'object') db.bookContent = {};
const sanitizeBookMeta = (m) => {
    const { file, ...rest } = m || {};
    return rest;
};
const injectContent = (books) => (books || []).map(b =>
    db.bookContent[b.title] ? { ...b, content: sanitizeBookMeta(db.bookContent[b.title]) } : b
);
const stripContent = (books) => (books || []).map(({ content, ...b }) => b);
const safeFileName = (title) => title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'book';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2'
};

http.createServer(async (req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
    catch { res.writeHead(400); res.end('bad request'); return; }

    // ================= 认证 API =================
    // 注册：服务端创建账户并哈希密码，直接返回令牌
    if (urlPath === '/api/register' && (req.method === 'POST' || req.method === 'PUT')) {
        try {
            const b = JSON.parse(await readBody(req));
            const un = String(b.username || '').trim();
            const nm = String(b.name || '').trim();
            if (!/^[A-Za-z0-9_]{2,20}$/.test(un)) return json(res, 400, { ok: false, error: '用户名需为 2-20 位字母、数字或下划线' });
            if (typeof b.password !== 'string' || b.password.length < 4 || b.password.length > 64) return json(res, 400, { ok: false, error: '密码长度需为 4-64 位' });
            if (!nm || nm.length > 20) return json(res, 400, { ok: false, error: '请填写姓名（20 字以内）' });
            if ((db.users || []).some(u => u.username === un)) return json(res, 400, { ok: false, error: '用户名已存在' });
            const user = {
                username: un, name: nm, role: 'member',
                totalPoints: 0, signCount: 0, continuousDays: 0, lastSignDate: null,
                rankHistory: [], achievements: [], achievementDates: {}, records: []
            };
            // 首次签到：积分公式服务端重算；难度/总页数优先取库内书目真实值
            const r = b.firstRecord;
            if (r && typeof r === 'object' && String(r.bookTitle || '').trim()) {
                const title = String(r.bookTitle).trim().slice(0, 50);
                const bookDef = (db.books || []).find(bk => bk.title === title);
                const pages = clampInt(r.pages, 0, 1e6);
                const minutes = clampInt(r.minutes, 0, 1e6);
                const refl = String(r.reflection || '').slice(0, 500);
                const diff = clampInt(bookDef && bookDef.difficulty ? bookDef.difficulty : r.difficulty, 1, 5);
                const tp = clampInt(bookDef && bookDef.totalPages ? bookDef.totalPages : r.totalPages, 0, 1e6) || 300;
                const points = POINTS_FORMULA(pages, minutes, refl.length, diff, tp);
                user.records.push({
                    date: dateStr(), bookTitle: title,
                    pages, minutes, reflection: refl, difficulty: diff, totalPages: tp,
                    pointsEarned: points, reviewed: false
                });
            }
            recomputeUserStats(user);
            recomputePoints(user);
            setHashedPassword(user, b.password);
            (db.users = db.users || []).push(user);
            grantAchievements(user);   // 首签后成就判定
            recomputePoints(user);     // 成就授予不影响积分，重算一次保持口径
            // 首签记录登记积分台账（防伪造权威源）
            if (user.records.length) {
                db.scoreLedger[scoreLedgerKey(un, user.records[0])] = user.records[0].pointsEarned;
            }
            writeData(db);
            console.log('新会员注册: ' + un);
            return json(res, 200, { ok: true, token: makeToken(user), user: sanitizeUser(user) });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 登录：校验哈希，签发令牌
    if (urlPath === '/api/login' && (req.method === 'POST' || req.method === 'PUT')) {
        const ip = clientIp(req);
        if (tooManyFails(ip)) return json(res, 429, { ok: false, error: '尝试次数过多，请 5 分钟后再试' });
        try {
            const b = JSON.parse(await readBody(req));
            const user = (db.users || []).find(u => u.username === String(b.username || '').trim());
            if (!user || !verifyPassword(user, b.password)) {
                recordFail(ip);
                return json(res, 401, { ok: false, error: '用户名或密码有误' });
            }
            return json(res, 200, { ok: true, token: makeToken(user), user: sanitizeUser(user) });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 会话恢复：令牌 → 当前用户
    if (urlPath === '/api/me' && req.method === 'GET') {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { ok: false, error: '未登录或登录已过期' });
        return json(res, 200, { ok: true, user: sanitizeUser(auth.user) });
    }

    // 修改密码：需登录，验证旧密码
    if (urlPath === '/api/password' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { ok: false, error: '请先登录' });
        try {
            const b = JSON.parse(await readBody(req));
            if (!verifyPassword(auth.user, b.oldPassword)) return json(res, 401, { ok: false, error: '旧密码有误' });
            if (typeof b.newPassword !== 'string' || b.newPassword.length < 4 || b.newPassword.length > 64) return json(res, 400, { ok: false, error: '新密码长度需为 4-64 位' });
            setHashedPassword(auth.user, b.newPassword);
            writeData(db);
            return json(res, 200, { ok: true });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 管理后台解锁：校验掌馆人（admin）密码，返回管理员令牌
    if (urlPath === '/api/admin/unlock' && (req.method === 'POST' || req.method === 'PUT')) {
        const ip = clientIp(req);
        if (tooManyFails(ip)) return json(res, 429, { ok: false, error: '尝试次数过多，请 5 分钟后再试' });
        try {
            const b = JSON.parse(await readBody(req));
            const admin = (db.users || []).find(u => u.role === 'admin');
            if (!admin || !verifyPassword(admin, b.password)) {
                recordFail(ip);
                return json(res, 401, { ok: false, error: '密码有误' });
            }
            return json(res, 200, { ok: true, token: makeToken(admin), name: admin.name });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 管理员重置会员密码
    if (urlPath === '/api/admin/reset-password' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'admin') return json(res, 403, { ok: false, error: '需要掌馆人权限' });
        try {
            const b = JSON.parse(await readBody(req));
            const target = (db.users || []).find(u => u.username === String(b.username || '').trim());
            if (!target) return json(res, 404, { ok: false, error: '会员不存在' });
            let np = b.newPassword ? String(b.newPassword) : '123456';
            if (np.length < 4 || np.length > 64) return json(res, 400, { ok: false, error: '密码长度需为 4-64 位' });
            setHashedPassword(target, np);
            writeData(db);
            console.log('掌馆人重置了 ' + target.username + ' 的密码');
            return json(res, 200, { ok: true, newPassword: np });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 掌馆人编辑会员资料：姓名 / 身份 / 手工调整总分 / 增删成就（role 与积分的唯一合法改动通道）
    if (urlPath === '/api/admin/update-user' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'admin') return json(res, 403, { ok: false, error: '需要掌馆人权限' });
        try {
            const b = JSON.parse(await readBody(req));
            const target = (db.users || []).find(u => u.username === String(b.username || '').trim());
            if (!target) return json(res, 404, { ok: false, error: '会员不存在' });
            if (b.name !== undefined) {
                const nm = String(b.name).trim();
                if (!nm || nm.length > 20) return json(res, 400, { ok: false, error: '姓名需为 1-20 字' });
                target.name = nm;
            }
            if (b.role !== undefined) {
                if (b.role !== 'member' && b.role !== 'admin') return json(res, 400, { ok: false, error: '身份不合法' });
                if (target.username === 'admin' && b.role !== 'admin') return json(res, 400, { ok: false, error: '不能降级主掌馆账号' });
                target.role = b.role;
            }
            if (b.setTotalPoints !== undefined) {
                const setTotal = clampInt(b.setTotalPoints, 0, 1e9);
                // 手工调整存入 pointAdjust（服务端持久），重算不会被冲掉：
                // 调整分 = 目标总分 - Σ记录分 - 测评兑分
                const base = (target.records || []).reduce((s, r) => s + (r && r.pointsEarned ? r.pointsEarned : 0), 0);
                target.pointAdjust = setTotal - base - testPointsOf(target);
            }
            if (Array.isArray(b.addAchievements)) {
                target.achievements = target.achievements || [];
                target.achievementDates = target.achievementDates || {};
                b.addAchievements.forEach(id => {
                    if ((db.achievements || []).some(a => a.id === id) && !target.achievements.includes(id)) {
                        target.achievements.push(id);
                        target.achievementDates[id] = dateStr();
                    }
                });
            }
            if (Array.isArray(b.removeAchievements)) {
                const rm = new Set(b.removeAchievements.map(x => parseInt(x, 10)).filter(x => !isNaN(x)));
                target.achievements = (target.achievements || []).filter(id => !rm.has(id));
                rm.forEach(id => { delete target.achievementDates[id]; });
            }
            recomputeUserStats(target);
            recomputePoints(target);
            writeData(db);
            console.log('掌馆人更新了 ' + target.username + ' 的资料');
            return json(res, 200, { ok: true, user: sanitizeUser(target) });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 掌馆人批改理解题：打 0-10 分，入账并通知（登记表防重复兑分）
    if (urlPath === '/api/admin/grade-essay' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'admin') return json(res, 403, { ok: false, error: '需要掌馆人权限' });
        try {
            const b = JSON.parse(await readBody(req));
            const target = (db.users || []).find(u => u.username === String(b.username || '').trim());
            const bookTitle = String(b.bookTitle || '').trim();
            const date = String(b.date || '').trim();
            const score = clampInt(b.score, 0, 10);
            if (!target) return json(res, 404, { ok: false, error: '会员不存在' });
            const list = (target.essays || {})[bookTitle] || [];
            const entry = list.find(e => e && String(e.date) === date);
            if (!entry) return json(res, 404, { ok: false, error: '未找到该篇作答' });
            db.essayAwards = db.essayAwards || {};
            const key = target.username + '|' + bookTitle + '|' + date;
            const prevAward = db.essayAwards[key];
            // 差额批改：同一篇重批时按 (新分 - 已入账分) 调整 pointAdjust（可为负），
            // 累计入账恒等于最新评分，既支持合法重批，又杜绝重复兑分刷分
            const delta = score - (typeof prevAward === 'number' ? prevAward : 0);
            if (typeof prevAward === 'number' && delta === 0 && entry.score === score) {
                return json(res, 200, { ok: true, user: sanitizeUser(target), unchanged: true });
            }
            target.pointAdjust = (typeof target.pointAdjust === 'number' ? target.pointAdjust : 0) + delta;
            entry.score = score;
            entry.gradedAt = dateStr();
            db.essayAwards[key] = score;
            recomputePoints(target);
            if (delta > 0) {
                pushNotification(target, `✒️ 你在《${bookTitle}》的理解题获掌馆批改 <b>${score}</b> 分，已入账`, 'books');
            } else if (delta < 0) {
                pushNotification(target, `✒️ 你在《${bookTitle}》的理解题批改调整为 <b>${score}</b> 分（已追回 ${-delta} 分）`, 'books');
            }
            writeData(db);
            console.log('理解题批改: ' + target.username + ' 《' + bookTitle + '> ' + score + ' 分 (差额 ' + delta + ')');
            return json(res, 200, { ok: true, user: sanitizeUser(target), delta });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 掌馆人签到追认/驳回：通过=事后追认（不再计分）；驳回=删记录+追回积分+重算统计+成就重推导
    if (urlPath === '/api/admin/record-review' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'admin') return json(res, 403, { ok: false, error: '需要掌馆人权限' });
        try {
            const b = JSON.parse(await readBody(req));
            const target = (db.users || []).find(u => u.username === String(b.username || '').trim());
            const date = String(b.date || '').trim();
            const bookTitle = String(b.bookTitle || '').trim();
            const action = String(b.action || '');
            if (!target) return json(res, 404, { ok: false, error: '会员不存在' });
            const idx = (target.records || []).findIndex(r => r && r.date === date && r.bookTitle === bookTitle);
            if (idx < 0) return json(res, 404, { ok: false, error: '未找到该签到记录' });
            const rec = target.records[idx];
            if (action === 'approve') {
                // 新语义：提交时积分已即时入账，审核通过仅为事后追认，不再动分
                rec.reviewed = true;
                pushNotification(target, `✅ 你 <b>${date}</b> 关于《${bookTitle}》的签到已被掌馆追认，积分 <b>${rec.pointsEarned}</b> 保持入账`, 'sign');
                console.log('签到追认: ' + target.username + ' ' + date);
            } else if (action === 'reject') {
                const pts = rec.pointsEarned || 0;
                target.records.splice(idx, 1);
                delete db.scoreLedger[scoreLedgerKey(target.username, rec)];   // 注销台账，重签按新数据重算
                recomputeUserStats(target);          // 重算 totalPoints/连签/签到数（积分追回）
                recomputePoints(target);
                const { lost } = recomputeAchievementsFull(target);   // 成就全量重推导（可回收）
                lost.forEach(id => {
                    const ach = (db.achievements || []).find(a => a.id === id);
                    if (ach) pushNotification(target, `⚠ 因签到驳回，成就「<b>${ach.name}</b>」已被回收`, 'achievements');
                });
                pushNotification(target, `⚠ 你 <b>${date}</b> 关于《${bookTitle}》的签到被驳回，积分 <b>${pts}</b> 已追回`, 'sign');
                console.log('签到驳回: ' + target.username + ' ' + date + ' 追回 ' + pts + ' 分, 回收成就 ' + lost.length + ' 枚');
            } else {
                return json(res, 400, { ok: false, error: '未知操作' });
            }
            writeData(db);
            return json(res, 200, { ok: true, user: sanitizeUser(target) });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // ================= 数据同步 API =================
    if (urlPath === '/api/data') {
        // 读取：未登录仅返回脱敏公开数据（书目/论坛帖/活动/榜单所需最小字段，
        // 不含 essays/bookScores/签到明细/站内信）；登录后按角色返回全量
        if (req.method === 'GET') {
            const auth = getAuth(req);
            if (!auth) {
                return json(res, 200, {
                    publicMode: true,
                    users: (db.users || []).map(u => ({
                        username: u.username, name: u.name, role: u.role || 'member',
                        totalPoints: u.totalPoints || 0, continuousDays: u.continuousDays || 0,
                        achievements: u.achievements || []
                    })),
                    achievements: db.achievements || [],
                    forum: db.forum || [],
                    notifications: [],
                    books: injectContent(db.books),
                    activities: db.activities || []
                });
            }
            const safe = {
                ...db,
                users: (db.users || []).map(u => {
                    const s = sanitizeUser(u);
                    // 会员只能看到自己的理解题作答；他人 essays 不下发（掌馆可见全部）
                    if (auth.role !== 'admin' && u.username !== auth.username) delete s.essays;
                    return s;
                }),
                books: injectContent(db.books)
            };
            delete safe.essayAwards;   // 服务器私有批改登记表，不下发
            delete safe.scoreLedger;   // 服务器私有记录分台账，不下发
            return json(res, 200, safe);
        }
        // 写入：必须携带有效令牌；字段级白名单 + 权威重算
        if (req.method === 'POST' || req.method === 'PUT') {
            const auth = getAuth(req);
            if (!auth) return json(res, 401, { ok: false, error: '写入数据需要登录' });
            try {
                const d = JSON.parse(await readBody(req));
                if (!Array.isArray(d.users) || !Array.isArray(d.achievements) || !Array.isArray(d.forum)) throw new Error('bad payload');
                db = {
                    users: mergeUsers(d.users, auth),
                    // 成就表为掌馆专属数据：非掌馆请求一律保留服务器现值
                    achievements: auth.role === 'admin' ? sanitizeAchievements(d.achievements) : db.achievements,
                    forum: Array.isArray(d.forum) ? d.forum : db.forum,
                    notifications: mergeNotifications(d.notifications),
                    books: Array.isArray(d.books) ? stripContent(d.books) : db.books,
                    activities: Array.isArray(d.activities) ? d.activities : db.activities,
                    bookContent: db.bookContent || {},
                    essayAwards: db.essayAwards || {},
                    scoreLedger: db.scoreLedger || {}
                };
                // 权威重算：记录分（台账回填/首见重算）、bookScores 剔除、统计口径、总积分、成就（只授予不回收）
                db.users.forEach(u => {
                    applyScoreLedger(u);
                    sanitizeBookScores(u);
                    recomputeUserStats(u);
                    recomputePoints(u);
                    grantAchievements(u);
                });
                writeData(db);
                return json(res, 200, { ok: true });
            } catch { return json(res, 400, { ok: false, error: '数据格式有误' }); }
        }
    }

    // ================= 在线阅读器 API =================
    // 上传书籍文件（TXT）：登录会员均可上传，进入待审核；掌馆人上传直接过审
    if (urlPath === '/api/upload-book' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { ok: false, error: '上传书籍需要先登录' });
        try {
            const q = new URL(req.url, 'http://x').searchParams;
            const title = String(q.get('title') || '').trim().slice(0, 50);
            const author = String(q.get('author') || '').trim().slice(0, 30) || '佚名';
            if (!title) return json(res, 400, { ok: false, error: '缺少书名' });
            const buf = await readRawBody(req);
            if (!buf.length) return json(res, 400, { ok: false, error: '文件内容为空' });
            // 粗校验：应为文本（含大量 NUL 视为二进制文件）
            let nul = 0;
            for (let i = 0; i < Math.min(buf.length, 4096); i++) if (buf[i] === 0) nul++;
            if (nul > 64) return json(res, 400, { ok: false, error: '仅支持 TXT 文本文件' });
            const fileName = Date.now() + '-' + safeFileName(title) + '.txt';
            fs.writeFileSync(path.join(BOOKS_DIR, fileName), buf);
            let book = (db.books || []).find(b => b.title === title);
            if (!book) {
                book = { id: Date.now(), title, author, totalPages: 0, totalWords: 0, difficulty: 3, desc: '', questions: [] };
                (db.books = db.books || []).push(book);
            }
            db.bookContent[title] = {
                status: auth.role === 'admin' ? 'approved' : 'pending',
                file: fileName, size: buf.length, format: 'txt',
                uploadedBy: auth.username, uploadedAt: Date.now()
            };
            writeData(db);
            console.log('书籍上传: 《' + title + '》 ' + (buf.length / 1e6).toFixed(1) + 'MB by ' + auth.username + ' (' + db.bookContent[title].status + ')');
            return json(res, 200, { ok: true, status: db.bookContent[title].status });
        } catch (e) { return json(res, 400, { ok: false, error: e.message || '上传失败' }); }
    }

    // 读取书籍正文：需登录；学生仅可读已过审书源，掌馆人可预览待审书源
    if (/^\/api\/book-content\/\d+$/.test(urlPath) && req.method === 'GET') {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { ok: false, error: '阅读需要先登录' });
        const id = parseInt(urlPath.split('/').pop(), 10);
        const book = (db.books || []).find(b => b.id === id);
        const meta = book && db.bookContent[book.title];
        if (!book || !meta || !meta.file) return json(res, 404, { ok: false, error: '该书暂无书源' });
        if (meta.status !== 'approved' && auth.role !== 'admin') return json(res, 403, { ok: false, error: '书源审核中，请稍候' });
        try {
            // 流式下发正文，避免大文件整读进内存
            const fp = path.join(BOOKS_DIR, meta.file);
            const stat = fs.statSync(fp);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
            return fs.createReadStream(fp).pipe(res);
        } catch { return json(res, 404, { ok: false, error: '书源文件丢失' }); }
    }

    // 掌馆人审核书源：通过 / 驳回 / 删除
    if (urlPath === '/api/admin/review-content' && (req.method === 'POST' || req.method === 'PUT')) {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'admin') return json(res, 403, { ok: false, error: '需要掌馆人权限' });
        try {
            const b = JSON.parse(await readBody(req));
            const title = String(b.title || '').trim();
            const action = String(b.action || '');
            const meta = db.bookContent[title];
            if (!meta) return json(res, 404, { ok: false, error: '该书没有待审书源' });
            if (action === 'approve') {
                meta.status = 'approved';
                console.log('书源过审: 《' + title + '》');
            } else if (action === 'reject' || action === 'delete') {
                try { fs.unlinkSync(path.join(BOOKS_DIR, meta.file)); } catch {}
                delete db.bookContent[title];
            } else return json(res, 400, { ok: false, error: '未知操作' });
            writeData(db);
            return json(res, 200, { ok: true });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // ================= 静态文件 =================
    // 守卫：密钥、数据、备份、书源正文、锁文件等服务器私有文件一律不对外提供
    if (/(密钥|书会数据|books_content|数据备份|server\.lock|\.tmp)/.test(urlPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
    }
    let p = urlPath === '/' ? '/书香读书系统.html' : urlPath.replace(/\.\./g, '');
    fs.readFile(path.join(ROOT, p), (e, d) => {
        if (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(d);
    });
}).listen(PORT, '0.0.0.0', () => {
    console.log('服务器运行中 · 共享数据文件: ' + DATA_FILE);
    console.log('认证已启用: 密码加密存储 · 写操作需登录 · 启动备份于 数据备份/');
    console.log('积分权威口径: totalPoints = Σ记录分 + pointAdjust(掌馆调整) + 测评兑分(每书≤' + TEST_POINTS_MAX + ')');
});

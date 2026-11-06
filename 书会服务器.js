// 书香读书会 · 局域网服务器 v2（用户认证增强版）
// 静态页面 + 数据同步 API + 用户认证
//   - 密码使用 scrypt 加盐哈希存储，永不明文落盘/下发
//   - 登录签发 HMAC 签名令牌（30 天有效），写操作需携带令牌
//   - 启动时自动迁移旧版明文密码，并自动备份 数据备份/ 目录
// 数据存放于同目录 书会数据.json，全会设备共享
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, '书会数据.json');
const SECRET_FILE = path.join(ROOT, '.会话密钥');
const BACKUP_DIR = path.join(ROOT, '数据备份');
const PORT = 8765;
const TOKEN_TTL = 30 * 24 * 3600 * 1000;   // 令牌有效期 30 天
const EMPTY = { users: [], achievements: [], forum: [], notifications: [], books: [], activities: [] };

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

// ---------- 会话密钥（持久化，重启不掉线） ----------
let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE); } catch { SECRET = null; }
if (!SECRET || SECRET.length < 32) {
    SECRET = crypto.randomBytes(48);
    fs.writeFileSync(SECRET_FILE, SECRET);
}

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
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let d;
    try { d = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch { return null; }
    if (!d.u || !d.e || Date.now() > d.e) return null;
    const user = (db.users || []).find(x => x.username === d.u);
    if (!user) return null;
    return { username: d.u, role: user.role || 'member', user };
};
const getAuth = (req) => {
    const m = String(req.headers['authorization'] || '').match(/^Bearer (.+)$/);
    return m ? verifyToken(m[1]) : null;
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
// 客户端整包同步时，凭据字段一律以服务器为准，绝不接受客户端传入
const mergeUsers = (incoming) => {
    const list = [];
    for (const u of incoming) {
        if (!u || typeof u !== 'object' || typeof u.username !== 'string' || !u.username.trim()) continue;
        const prev = (db.users || []).find(x => x.username === u.username);
        const clean = { ...u };
        delete clean.password; delete clean.passHash; delete clean.salt;
        if (prev) {
            if (prev.passHash) clean.passHash = prev.passHash;
            if (prev.salt) clean.salt = prev.salt;
        }
        list.push(clean);
    }
    return list;
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
const clientIp = (req) => req.socket.remoteAddress || '?';

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
    if (urlPath === '/api/register' && req.method === 'POST') {
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
            // 首次签到（与前端旧逻辑同公式）
            const r = b.firstRecord;
            if (r && typeof r === 'object' && String(r.bookTitle || '').trim()) {
                const pages = Math.max(0, parseInt(r.pages) || 0);
                const minutes = Math.max(0, parseInt(r.minutes) || 0);
                const refl = String(r.reflection || '').slice(0, 500);
                const diff = Math.min(5, Math.max(1, parseInt(r.difficulty) || 3));
                const tp = Math.max(0, parseInt(r.totalPages) || 300);
                const points = Math.floor(pages * 0.5 + minutes * 0.2 + refl.length / 10 + diff * 3 + tp / 40) + 1;
                user.records.push({
                    date: dateStr(), bookTitle: String(r.bookTitle).trim().slice(0, 50),
                    pages, minutes, reflection: refl, difficulty: diff, totalPages: tp,
                    pointsEarned: points, reviewed: false
                });
                user.signCount = 1; user.continuousDays = 1; user.lastSignDate = dateStr();
            }
            setHashedPassword(user, b.password);
            (db.users = db.users || []).push(user);
            writeData(db);
            console.log('新会员注册: ' + un);
            return json(res, 200, { ok: true, token: makeToken(user), user: sanitizeUser(user) });
        } catch { return json(res, 400, { ok: false, error: '请求格式有误' }); }
    }

    // 登录：校验哈希，签发令牌
    if (urlPath === '/api/login' && req.method === 'POST') {
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
    if (urlPath === '/api/password' && req.method === 'POST') {
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
    if (urlPath === '/api/admin/unlock' && req.method === 'POST') {
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
    if (urlPath === '/api/admin/reset-password' && req.method === 'POST') {
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

    // ================= 数据同步 API =================
    if (urlPath === '/api/data') {
        // 读取：公开（仅用于页面展示），凭据字段已脱敏
        if (req.method === 'GET') {
            const safe = {
                ...db,
                users: (db.users || []).map(sanitizeUser)
            };
            return json(res, 200, safe);
        }
        // 写入：必须携带有效令牌（任何已登录会员均可同步）
        if (req.method === 'POST') {
            const auth = getAuth(req);
            if (!auth) return json(res, 401, { ok: false, error: '写入数据需要登录' });
            try {
                const d = JSON.parse(await readBody(req));
                if (!Array.isArray(d.users) || !Array.isArray(d.achievements) || !Array.isArray(d.forum)) throw new Error('bad payload');
                db = {
                    users: mergeUsers(d.users),
                    achievements: d.achievements,
                    forum: d.forum,
                    notifications: Array.isArray(d.notifications) ? d.notifications : [],
                    books: Array.isArray(d.books) ? d.books : [],
                    activities: Array.isArray(d.activities) ? d.activities : []
                };
                writeData(db);
                return json(res, 200, { ok: true });
            } catch { return json(res, 400, { ok: false, error: '数据格式有误' }); }
        }
    }

    // ================= 静态文件 =================
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
});

/**
 * qa_final_verify.js — QA 回归验证书香古风段位改造（Edward, task #2）
 * 用法: node qa_final_verify.js
 * 覆盖: 语法 / TITLES 规格 / 令牌行为 / 残留 / 模板接线 / 哈希一致性 / 冒烟
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const LOCAL = path.join(__dirname, '书香读书系统.html');
const ONLINE_DIR = 'D:\\书香读书系统-线上';
const ONLINE = path.join(ONLINE_DIR, '书香读书系统.html');
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
};

const TITLES_SPEC = [
  { min: 0, name: '萌新书虫', icon: '萌', color: '#8d8570' },
  { min: 100, name: '小书迷', icon: '迷', color: '#5f7d54' },
  { min: 300, name: '阅读新秀', icon: '秀', color: '#46748f' },
  { min: 600, name: '阅读达人', icon: '达', color: '#3e699b' },
  { min: 1000, name: '书虫学霸', icon: '学', color: '#6a5fa0' },
  { min: 1500, name: '阅读之星', icon: '星', color: '#b08d2f' },
  { min: 2100, name: '书香才子', icon: '才', color: '#4a8a7b' },
  { min: 2800, name: '书香学者', icon: '者', color: '#9e2b25' },
  { min: 3600, name: '书香大师', icon: '师', color: '#a0632b' },
  { min: 4500, name: '传奇书神', icon: '神', color: '#6b3fa0' }
];
const TOKEN_NAMES_SPEC = ['启蒙书签', '青竹竹简', '案头卷轴', '文房毛笔', '墨玉砚台', '书灯夜读', '君子玉佩', '朱砂印章', '丹青古卷', '镇馆全书'];
const RESIDUAL_TERMS = ['青铜', '白银', '黄金', '铂金', '钻石', '星耀', '最强王者', '无双', '荣耀王者', '传奇王者', '宝石段位', '科举', '童生',
  '青铜坚盾', '白银之翼', '黄金之章', '铂金之书', '钻石之冠', '星耀之典', '最强王者印', '无双书魂', '荣耀书圣', '传奇书豪'];
// 10 枚令牌的独有造型标识子串（书签/竹简/卷轴/毛笔/砚台/灯/玉佩/印章/挂轴/线装书）
const SHAPE_MARKERS = [
  'V45 L32 37 L24 45 Z',                    // 0 书签斜插造型（缺口三角）
  'x="16.5" y="9" width="5.5"',             // 1 竹片竖排
  'x="8.5" y="15" width="6.5" height="35"', // 2 左侧轴头
  'M29.2 37 C29.2 43.5',                    // 3 笔锋
  'rx="10" ry="4.8" fill="#211d1a"',        // 4 砚池墨汁
  'fill="#f2c26b"',                         // 5 灯芯暖光
  'stroke-width="6.5"',                     // 6 环形玉（粗环）
  'x="21.5" y="18" width="21" height="29"', // 7 印身
  'M20 35 L26 24 L31 33.5 L36.5 21 L44 35 Z', // 8 山水画心
  'M19.5 18.5 H26.5 M19.5 27 H26.5'         // 9 书脊线
];

const files = { 本地版: LOCAL, 线上版: ONLINE };
const read = p => fs.readFileSync(p, 'utf8');

// ---------- 1. 语法检查 ----------
function syntaxCheck(label, html) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  let inline = 0, fails = 0, failMsg = '';
  for (const m of scripts) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    inline++;
    try { new Function(m[2]); } catch (e) { fails++; failMsg += `[script#${inline}] ${e.message}; `; }
  }
  ok(`${label} <script> 块 new Function 编译`, fails === 0 && inline >= 1,
    `共 ${inline} 个内联块` + (fails ? `，失败 ${fails}：${failMsg}` : '，全部通过'));
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  let sFails = 0, sMsg = '';
  styles.forEach((m, i) => {
    const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
    const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
    if (open !== close) { sFails++; sMsg += `[style#${i + 1}] {=${open} }=${close}; `; }
  });
  ok(`${label} <style> 花括号配对`, sFails === 0, sFails ? sMsg : `${styles.length} 个 style 块平衡`);
}

// ---------- 2. TITLES 规格比对 ----------
function extractTitles(html) {
  const m = html.match(/const TITLES = \[([\s\S]*?)\n\s*\];/);
  if (!m) return null;
  const items = [];
  for (const it of m[1].matchAll(/\{\s*min:\s*(\d+)\s*,\s*name:\s*'([^']*)'\s*,\s*icon:\s*'([^']*)'\s*,\s*color:\s*'([^']*)'\s*\}/g)) {
    items.push({ min: +it[1], name: it[2], icon: it[3], color: it[4] });
  }
  return items;
}

// ---------- 3. 令牌行为 ----------
function evalTokens(html) {
  const t0 = html.indexOf('const TOKEN_NAMES');
  const t1 = html.indexOf('// 升段检测');
  const m = html.match(/const TITLES = \[[\s\S]*?\n\s*\];/);
  if (t0 < 0 || t1 <= t0 || !m) throw new Error('无法定位令牌代码段');
  const code = m[0] + '\n' + html.slice(t0, t1);
  const fn = new Function(`${code}; return { TITLES, TOKEN_NAMES, tokenName, tokenSvg, tint, PAPER, INK, sparkPath };`);
  return fn();
}

function tokenChecks(label, html) {
  let api;
  try { api = evalTokens(html); ok(`${label} 令牌代码段可执行`, true); }
  catch (e) { ok(`${label} 令牌代码段可执行`, false, e.message); return; }
  const { TOKEN_NAMES, tokenName, tokenSvg, PAPER, INK } = api;
  ok(`${label} TOKEN_NAMES 与规格一致`, JSON.stringify(TOKEN_NAMES) === JSON.stringify(TOKEN_NAMES_SPEC));
  ok(`${label} PAPER/INK 常量`, PAPER === '#f5efe0' && INK === '#3a3530', `${PAPER} / ${INK}`);

  const svgs = [];
  let svgOk = true, msgs = [];
  for (let i = 0; i < 10; i++) {
    const s = tokenSvg(i);
    svgs.push(s);
    if (!/^<svg viewBox="0 0 64 64"/.test(s)) { svgOk = false; msgs.push(`#${i} viewBox异常`); }
    if (/undefined|NaN/.test(s)) { svgOk = false; msgs.push(`#${i} 含 undefined/NaN`); }
  }
  ok(`${label} tokenSvg(0..9) 合法 SVG (viewBox 0 0 64 64, 无 undefined/NaN)`, svgOk, msgs.join(' '));

  // 渐变 id：30 个定义、无重复、全部被引用
  const defined = [], refs = [];
  for (const s of svgs) {
    for (const m of s.matchAll(/id="(tg\d+[abc])"/g)) defined.push(m[1]);
    for (const m of s.matchAll(/url\(#(tg\d+[abc])\)/g)) refs.push(m[1]);
  }
  const uniq = new Set(defined);
  const unreferenced = defined.filter(id => !refs.includes(id));
  ok(`${label} 30 个渐变 id 定义且无重复`, defined.length === 30 && uniq.size === 30, `定义 ${defined.length} 个, 去重 ${uniq.size}`);
  ok(`${label} 渐变 id 全部被引用`, unreferenced.length === 0, unreferenced.join(',') || '全部引用');

  ok(`${label} tokenName(0..9) 与规格一致`,
    [...Array(10).keys()].every(i => tokenName(i) === TOKEN_NAMES_SPEC[i]));

  // 越界安全回退
  let safe = true, sm = [];
  try {
    if (tokenName(10) !== '神秘令牌' || tokenName(-1) !== '神秘令牌' || tokenName(99) !== '神秘令牌') sm.push('tokenName 越界未回退');
    const s99 = tokenSvg(99), sm9 = tokenSvg(9), sneg = tokenSvg(-13);
    if (s99 !== sm9) sm.push('tokenSvg(99) 与 tokenSvg(9) 不一致');
    if (!/^<svg viewBox="0 0 64 64"/.test(sneg) || /undefined|NaN/.test(sneg)) sm.push('tokenSvg(-13) 异常');
  } catch (e) { safe = false; sm.push('抛异常: ' + e.message); }
  ok(`${label} 越界输入安全回退`, safe, sm.join(' ') || 'tokenSvg(±越界)/tokenName(±越界) 均安全');

  // 造型标识
  const missed = [];
  SHAPE_MARKERS.forEach((mk, i) => { if (!svgs[i].includes(mk)) missed.push(`#${i}(${TOKEN_NAMES[i]})`); });
  ok(`${label} 10 枚造型标识元素逐一命中`, missed.length === 0, missed.join(',') || '全部命中');

  // 45 组两两对比
  let dup = 0, dupPair = '';
  for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++) {
    if (svgs[a] === svgs[b]) { dup++; dupPair += `${a}-${b} `; }
  }
  ok(`${label} 45 组两两对比无实质相同`, dup === 0, dup ? dupPair : '全部互异');
}

// ---------- 4. 残留检查 ----------
function residualCheck(label, html) {
  const found = RESIDUAL_TERMS.filter(t => html.includes(t));
  ok(`${label} 旧段位/科举/旧令牌名残留为 0`, found.length === 0, found.join(',') || '无残留');
}

// ---------- 5. 模板接线 ----------
function wiringCheck(label, html) {
  const checks = [
    ['段位之路 v-for TITLES', /段位之路[\s\S]{0,400}v-for="\(t, i\) in TITLES"/],
    ['段位之路 tok-ic + tokenSvg', /tok-ic" v-html="tokenSvg\(i, 30\)"/],
    ['收藏架 v-for TITLES', /收藏架[\s\S]{0,400}v-for="\(t, i\) in TITLES"/],
    ['收藏架 tokenSvg 绑定', /token-coin" v-html="tokenSvg\(i, 60\)"/],
    ['收藏架 tokenName 绑定', /token-nm">\{\{ tokenName\(i\) \}\}/],
    ['解锁条件 totalPoints >= t.min', /totalPoints >= t\.min/],
    ['锁定态 🔒', /token-lock" v-if="profileUser\.totalPoints < t\.min">🔒/],
    ['锁定态 grayscale 样式', /\.token-cell\.locked[\s\S]{0,200}grayscale/],
    ['升段通知含「专属令牌」', /获得专属令牌/],
    ['setup 导出 tokenSvg/tokenName/TITLES/getTitle/nextTitle/tierStyle/uTotal',
      /TITLES, getTitle, nextTitle, tierStyle, uTotal, tokenSvg, tokenName,/],
    ['积分榜模板完整(leaderboard)',
      /currentPage === 'leaderboard'[\s\S]{0,2500}v-for="\(u,idx\) in leaderboardData"[\s\S]{0,2500}<\/table>/],
  ];
  const missed = checks.filter(([n, re]) => !re.test(html)).map(([n]) => n);
  ok(`${label} 模板接线与回归`, missed.length === 0, missed.join('; ') || '11 项全部接线正常');
  ok(`${label} 无「科举」`, !html.includes('科举'));
}

// ---------- 6. 哈希一致性 ----------
function hashCheck() {
  const h1 = crypto.createHash('md5').update(fs.readFileSync(LOCAL)).digest('hex');
  const h2 = crypto.createHash('md5').update(fs.readFileSync(ONLINE)).digest('hex');
  ok('本地版与线上版 hash 一致', h1 === h2, `md5 ${h1.slice(0, 12)}… vs ${h2.slice(0, 12)}…`);
}

// ---------- 7. 冒烟测试 ----------
function smoke(port) {
  return new Promise(resolve => {
    const child = spawn('node', ['书会服务器.js'], {
      cwd: ONLINE_DIR, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    let settled = false;
    const done = (pass, detail) => {
      if (settled) return; settled = true;
      try { child.kill(); } catch (e) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 500);
      resolve({ pass, detail, stderr });
    };
    const tryFetch = (n) => {
      if (settled) return;
      const req = http.get(`http://127.0.0.1:${port}/`, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          const need = ['传奇书神', '镇馆全书', '书香段位'];
          const miss = need.filter(s => !body.includes(s));
          done(res.statusCode === 200 && miss.length === 0,
            `HTTP ${res.statusCode}, ${body.length} bytes` + (miss.length ? `，缺失: ${miss.join(',')}` : '，含「传奇书神」「镇馆全书」「书香段位」'));
        });
      });
      req.on('error', () => {
        if (n < 15) setTimeout(() => tryFetch(n + 1), 500);
        else done(false, '服务器未响应 ' + stderr.slice(-200));
      });
    };
    setTimeout(() => tryFetch(0), 700);
    setTimeout(() => done(false, '冒烟超时 ' + stderr.slice(-200)), 12000);
    child.on('exit', c => { if (!settled) done(false, `服务器提前退出 code=${c} ${stderr.slice(-200)}`); });
  });
}

// ---------- 主流程 ----------
(async () => {
  console.log('=== 1. 语法 ===');
  for (const [label, p] of Object.entries(files)) syntaxCheck(label, read(p));

  console.log('=== 2. TITLES 规格 ===');
  for (const [label, p] of Object.entries(files)) {
    const items = extractTitles(read(p));
    const match = JSON.stringify(items) === JSON.stringify(TITLES_SPEC);
    ok(`${label} TITLES 10 项与规格完全一致(含阈值)`, match, items ? (match ? '10/10' : '不一致: ' + JSON.stringify(items)) : '未提取到 TITLES');
  }

  console.log('=== 3. 令牌行为 ===');
  for (const [label, p] of Object.entries(files)) tokenChecks(label, read(p));

  console.log('=== 4. 残留 ===');
  for (const [label, p] of Object.entries(files)) residualCheck(label, read(p));

  console.log('=== 5. 模板接线与回归 ===');
  for (const [label, p] of Object.entries(files)) wiringCheck(label, read(p));

  console.log('=== 6. 一致性 ===');
  hashCheck();

  console.log('=== 7. 冒烟 (PORT=9977) ===');
  const sm = await smoke(9977);
  ok('线上版冒烟启动 + 首页关键内容', sm.pass, sm.detail);

  const total = results.length, failed = results.filter(r => !r.pass);
  console.log(`\n===== 汇总: ${total - failed.length}/${total} 通过 =====`);
  if (failed.length) failed.forEach(r => console.log(`FAIL: ${r.name} | ${r.detail}`));
  process.exit(0);
})();

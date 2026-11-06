// QA 回归验证脚本 - 任务 #2 宝石风段位
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const FILES = [
  'D:\\书香读书系统\\书香读书系统.html',
  'D:\\书香读书系统-线上\\书香读书系统.html'
];
let failures = 0;

function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (!ok) failures++;
}

// ---------- 1. 语法检查：script 块 new Function + style 花括号配对 ----------
function syntaxCheck(file) {
  const html = fs.readFileSync(file, 'utf8');
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0, scriptFail = 0, scriptCount = 0;
  while ((m = scriptRe.exec(html)) !== null) {
    i++;
    const code = m[1];
    if (!code.trim()) continue;
    scriptCount++;
    // 跳过外部 src 引用（内联才检查）
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (/\bsrc\s*=/.test(tag)) continue;
    try {
      new Function(code);
    } catch (e) {
      scriptFail++;
      check(`语法 script块#${i} (${file})`, false, e.message);
    }
  }
  check(`script 块语法 (${file}) 共${scriptCount}个内联块`, scriptFail === 0);

  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm, styleCount = 0, braceFail = 0;
  while ((sm = styleRe.exec(html)) !== null) {
    styleCount++;
    const css = sm[1];
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    if (open !== close) {
      braceFail++;
      check(`style 花括号配对 (${file}) style#${styleCount}`, false, `{=${open} }=${close}`);
    }
  }
  check(`style 花括号配对 (${file}) 共${styleCount}个块`, braceFail === 0);
  return html;
}

// ---------- 2/3. TITLES 提取 + 边界逻辑 ----------
const EXPECTED = [
  { min: 0, name: '坚韧青铜', icon: '铜' },
  { min: 100, name: '秩序白银', icon: '银' },
  { min: 300, name: '荣耀黄金', icon: '金' },
  { min: 600, name: '尊贵铂金', icon: '铂' },
  { min: 1000, name: '永恒钻石', icon: '钻' },
  { min: 1500, name: '至尊星耀', icon: '耀' },
  { min: 2100, name: '最强王者', icon: '王' },
  { min: 2800, name: '无双王者', icon: '双' },
  { min: 3600, name: '荣耀王者', icon: '巅' },
  { min: 4500, name: '传奇王者', icon: '神' }
];

function extractTITLES(html) {
  const m = html.match(/const\s+TITLES\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return null;
  try { return new Function('return ' + m[1])(); } catch (e) { throw new Error('TITLES 解析失败: ' + e.message); }
}

function getTitle(TITLES, points) {
  let t = TITLES[0];
  for (const x of TITLES) if (points >= x.min) t = x;
  return t;
}

function dataCheck(html, file) {
  let TITLES;
  try {
    TITLES = extractTITLES(html);
  } catch (e) {
    check(`TITLES 提取 (${file})`, false, e.message);
    return;
  }
  check(`TITLES 提取 (${file})`, true, `${TITLES.length} 项`);

  // 2a. 长度
  check(`TITLES 数量=10 (${file})`, TITLES.length === 10, `实际 ${TITLES.length}`);
  // 2b. 阈值/名称/图标/顺序 + color 非空
  let structOk = true, detail = [];
  for (let i = 0; i < 10; i++) {
    const t = TITLES[i], e = EXPECTED[i];
    if (!t || t.min !== e.min || t.name !== e.name || t.icon !== e.icon
      || typeof t.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(t.color)) {
      structOk = false;
      detail.push(`#${i} 期望 ${e.min}/${e.name}/${e.icon}，实际 ${JSON.stringify(t)}`);
    }
  }
  check(`TITLES 阈值/名称/图标/顺序/颜色 (${file})`, structOk, detail.join('; '));
  // 2c. 阈值严格递增
  let inc = true;
  for (let i = 1; i < TITLES.length; i++) if (!(TITLES[i].min > TITLES[i - 1].min)) inc = false;
  check(`TITLES 阈值严格递增 (${file})`, inc);

  // 3. 边界用例
  const CASES = [
    [0, '坚韧青铜'], [99, '坚韧青铜'], [100, '秩序白银'], [299, '秩序白银'],
    [300, '荣耀黄金'], [599, '荣耀黄金'], [600, '尊贵铂金'],     [999, '尊贵铂金'], [1000, '永恒钻石'], [1499, '永恒钻石'],
    [1500, '至尊星耀'], [2099, '至尊星耀'], [2100, '最强王者'], [2799, '最强王者'],
    [2800, '无双王者'], [3599, '无双王者'], [3600, '荣耀王者'], [4499, '荣耀王者'],
    [4500, '传奇王者'], [99999, '传奇王者']
  ];
  let bad = [];
  for (const [pts, expectName] of CASES) {
    const got = getTitle(TITLES, pts).name;
    if (got !== expectName) bad.push(`${pts}→${got}（期望 ${expectName}）`);
  }
  check(`边界逻辑 ${CASES.length} 用例 (${file})`, bad.length === 0, bad.join('; '));

  // nextTitle 抽查
  const nextTitle = (p) => TITLES.find(x => x.min > p) || null;
  check('nextTitle 抽查', nextTitle(99) && nextTitle(99).name === '秩序白银'
    && nextTitle(4499) && nextTitle(4499).name === '传奇王者'
    && nextTitle(4500) === null && nextTitle(0) && nextTitle(0).name === '秩序白银');
}

// ---------- 6. 一致性 hash ----------
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 主流程 ----------
const [localHtml, onlineHtml] = FILES.map(f => { syntaxCheck(f); return fs.readFileSync(f, 'utf8'); });
dataCheck(localHtml, '本地版');
dataCheck(onlineHtml, '线上版');
const h1 = hash(FILES[0]), h2 = hash(FILES[1]);
check('本地版/线上版 SHA-256 一致', h1 === h2, h1.slice(0, 16) + ' vs ' + h2.slice(0, 16));

// 4. 残留检查（脚本内再做一遍全文扫描，含注释）
const RESIDUE = /科举|童生|秀才|举人|贡士|进士|探花|榜眼|状元|大学士|文曲星/;
[localHtml, onlineHtml].forEach((html, i) => {
  const lines = html.split('\n');
  const hits = [];
  lines.forEach((l, idx) => { if (RESIDUE.test(l)) hits.push(`L${idx + 1}: ${l.trim().slice(0, 80)}`); });
  check(`科举残留=0 (${FILES[i]})`, hits.length === 0, hits.join(' || '));
});

// 5. 导出检查
[localHtml, onlineHtml].forEach((html, i) => {
  check(`setup 导出 TITLES/getTitle/nextTitle/tierStyle (${FILES[i]})`,
    /TITLES,\s*getTitle,\s*nextTitle,\s*tierStyle,\s*uTotal/.test(html));
  // 模板悬空引用粗检：模板区（<div id="app" 之前 body 区域）不应有未定义的 tier*
  const appStart = html.indexOf('id="app"');
  const scriptStart = html.indexOf('<script>');
  const templateZone = html.slice(appStart, scriptStart);
  const dangling = templateZone.match(/tier[A-Za-z]*|getTitle|nextTitle/g) || [];
  const allowed = new Set(['tier-badge', 'tierStyle', 'getTitle', 'nextTitle', 'tier-ladder', 'tier']);
  const unknown = [...new Set(dangling)].filter(x => !allowed.has(x));
  check(`模板无悬空段位引用 (${FILES[i]})`, unknown.length === 0, unknown.join(', '));
});

console.log('\n===== 结果: ' + (failures === 0 ? 'ALL PASS' : failures + ' 项失败') + ' =====');
process.exit(failures === 0 ? 0 : 1);

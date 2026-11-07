/**
 * QA 独立验证脚本（Edward）— 验证 79 本书导入结果
 * 独立实现，不复用 导入书库.js 的任何代码。
 * 用法: node qa_import_verify.js
 */
const fs = require('fs');
const path = require('path');

const DIR_LOCAL = 'D:/书香读书系统';
const DIR_ONLINE = 'D:/书香读书系统-线上';

let pass = 0, fail = 0;
const issues = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else {
    fail++; issues.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function loadJSON(p) {
  // 独立解析：读原始文本 + JSON.parse，同时检测 BOM
  const buf = fs.readFileSync(p);
  const hasBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8');
  return { data: JSON.parse(text), hasBOM, bytes: buf.length };
}
function isInt(v) { return Number.isInteger(v); }

// ---------- 乱码/截断检查 ----------
function looksGarbled(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  // 出现常见乱码特征字符
  if (/[\uFFFD]/.test(s)) return true; // replacement char
  // 连续的私有区/罕见控制字符
  if (/[\u0000-\u0008\u000E-\u001F]/.test(s)) return true;
  return false;
}

// ============================================================
console.log('===== 1. JSON 可解析 & books.length = 79 =====');
const localRes = loadJSON(path.join(DIR_LOCAL, '书会数据.json'));
const onlineRes = loadJSON(path.join(DIR_ONLINE, '书会数据.json'));
const srcRes = loadJSON(path.join(DIR_LOCAL, '书单导入源.json'));
check('本地 书会数据.json 可解析', !!localRes.data);
check('线上 书会数据.json 可解析', !!onlineRes.data);
check('书单导入源.json 可解析', !!srcRes.data);
const srcBooks = srcRes.data.books;
check('源书单 books 为数组', Array.isArray(srcBooks), `实际类型 ${typeof srcBooks}`);
check('源书单 79 本', srcBooks.length === 79, `实际 ${srcBooks.length}`);
check('本地 books.length=79', localRes.data.books.length === 79, `实际 ${localRes.data.books.length}`);
check('线上 books.length=79', onlineRes.data.books.length === 79, `实际 ${onlineRes.data.books.length}`);
check('无 BOM 问题（本地）', !localRes.hasBOM);

// ============================================================
console.log('\n===== 2. 与源书单逐本比对 =====');
for (const [tag, data] of [['本地', localRes.data], ['线上', onlineRes.data]]) {
  const books = data.books;
  // id 唯一
  const idSet = new Set(books.map(b => b.id));
  check(`[${tag}] id 无重复`, idSet.size === books.length, `${books.length} 本但仅 ${idSet.size} 个唯一 id`);
  const dupIds = books.map(b => b.id).filter((v, i, a) => a.indexOf(v) !== i);
  if (dupIds.length) console.log(`    重复 id: ${[...new Set(dupIds)].join(', ')}`);
  // id 数字
  const nonNumId = books.filter(b => !isInt(b.id));
  check(`[${tag}] id 均为数字`, nonNumId.length === 0, nonNumId.slice(0, 3).map(b => b.title).join('/'));
  // difficulty 1-5 整数
  const badDiff = books.filter(b => !isInt(b.difficulty) || b.difficulty < 1 || b.difficulty > 5);
  check(`[${tag}] difficulty 均为 1-5 整数`, badDiff.length === 0,
    badDiff.slice(0, 3).map(b => `${b.title}:${b.difficulty}`).join('/'));
  // questions 数组
  const badQ = books.filter(b => !Array.isArray(b.questions));
  check(`[${tag}] questions 均为数组`, badQ.length === 0, badQ.slice(0, 3).map(b => b.title).join('/'));
  // title 存在且非空
  const badTitle = books.filter(b => typeof b.title !== 'string' || !b.title.trim());
  check(`[${tag}] title 均非空`, badTitle.length === 0);

  // 与源逐本比对（按 title 匹配）
  const srcByTitle = new Map();
  for (const sb of srcBooks) srcByTitle.set(sb.title, sb);
  const missing = books.filter(b => !srcByTitle.has(b.title));
  check(`[${tag}] 79 本 title 全部存在于源`, missing.length === 0, missing.slice(0, 3).map(b => b.title).join('/'));
  const extra = srcBooks.filter(sb => !books.some(b => b.title === sb.title));
  check(`[${tag}] 源 79 本全部导入（无遗漏）`, extra.length === 0, extra.slice(0, 3).map(b => b.title).join('/'));

  // author/difficulty/desc 与源一致
  const mismatch = [];
  for (const b of books) {
    const sb = srcByTitle.get(b.title);
    if (!sb) continue;
    if (b.author !== sb.author) mismatch.push(`${b.title}.author: 文件="${b.author}" 源="${sb.author}"`);
    if (b.difficulty !== sb.difficulty) mismatch.push(`${b.title}.difficulty: 文件=${b.difficulty} 源=${sb.difficulty}`);
    if ((b.desc || '') !== (sb.desc || '')) mismatch.push(`${b.title}.desc 不一致`);
  }
  check(`[${tag}] author/difficulty/desc 与源一致`, mismatch.length === 0, mismatch.slice(0, 5).join('; '));

  // totalPages/totalWords 类型
  const badTP = books.filter(b => !isInt(b.totalPages) || b.totalPages <= 0);
  check(`[${tag}] totalPages 为正整数`, badTP.length === 0, badTP.slice(0, 3).map(b => b.title).join('/'));
  const badTW = books.filter(b => !isInt(b.totalWords) || b.totalWords < 0);
  check(`[${tag}] totalWords 为非负整数`, badTW.length === 0, badTW.slice(0, 3).map(b => b.title).join('/'));
}

// ============================================================
console.log('\n===== 3. 抽查三体 =====');
for (const [tag, data] of [['本地', localRes.data], ['线上', onlineRes.data]]) {
  const st = data.books.find(b => b.title === '三体');
  check(`[${tag}] 存在三体`, !!st);
  if (!st) continue;
  check(`[${tag}] 三体 id=1792830975748`, st.id === 1792830975748, `实际 ${st.id}`);
  check(`[${tag}] 三体 totalPages=400`, st.totalPages === 400, `实际 ${st.totalPages}`);
  check(`[${tag}] 三体 questions 数组且含 1 题`, Array.isArray(st.questions) && st.questions.length === 1,
    `实际 ${JSON.stringify(st.questions).slice(0, 80)}`);
  check(`[${tag}] 三体 author=刘慈欣`, st.author === '刘慈欣', `实际 "${st.author}"`);
  check(`[${tag}] 三体 difficulty=4`, st.difficulty === 4, `实际 ${st.difficulty}`);
  check(`[${tag}] 三体 desc 非空`, typeof st.desc === 'string' && st.desc.trim().length > 0,
    `实际 "${st.desc}"`);
}

// ============================================================
console.log('\n===== 4. 数据完整性（users/achievements/forum/notifications/activities） =====');
const expect = {
  本地: { users: 4, achievements: 12, forum: 1, notifications: 4, activities: 1 },
  线上: { users: 1, achievements: 12, forum: 0, notifications: 0, activities: 0 },
};
for (const [tag, data] of [['本地', localRes.data], ['线上', onlineRes.data]]) {
  for (const key of ['users', 'achievements', 'forum', 'notifications', 'activities']) {
    const actual = Array.isArray(data[key]) ? data[key].length : (data[key] === undefined ? 'undefined' : typeof data[key]);
    check(`[${tag}] ${key}=${expect[tag][key]}`, actual === expect[tag][key], `实际 ${actual}`);
  }
  if (tag === '本地') {
    check('[本地] 首用户 username=alice', data.users[0] && data.users[0].username === 'alice',
      `实际 "${data.users[0] && data.users[0].username}"`);
    const noHash = data.users.filter(u => typeof u.passHash !== 'string' || !u.passHash || typeof u.salt !== 'string' || !u.salt);
    check('[本地] 每用户含 passHash/salt', noHash.length === 0, noHash.map(u => u.username).join('/'));
    check('[本地] users 明细: ' + data.users.map(u => u.username).join(', '), true);
  } else {
    check('[线上] admin 用户存在', data.users[0] && data.users[0].username === 'admin',
      `实际 "${data.users[0] && data.users[0].username}"`);
    const noHash = data.users.filter(u => typeof u.passHash !== 'string' || !u.passHash || typeof u.salt !== 'string' || !u.salt);
    check('[线上] admin 含 passHash/salt', noHash.length === 0);
  }
}

// ============================================================
console.log('\n===== 5. 备份文件 =====');
for (const [tag, dir] of [['本地', DIR_LOCAL], ['线上', DIR_ONLINE]]) {
  const bp = path.join(dir, '书会数据.json.导入前备份');
  check(`[${tag}] 备份文件存在`, fs.existsSync(bp));
  if (!fs.existsSync(bp)) continue;
  try {
    const bak = JSON.parse(fs.readFileSync(bp, 'utf8'));
    check(`[${tag}] 备份可解析`, true);
    check(`[${tag}] 备份 books.length=3`, bak.books.length === 3, `实际 ${bak.books.length}`);
    const titles = bak.books.map(b => b.title).join('/');
    check(`[${tag}] 备份 books 为原有 3 本（三体/小王子/朝花夕拾）`,
      ['三体', '小王子', '朝花夕拾'].every(t => bak.books.some(b => b.title === t)), `实际: ${titles}`);
    check(`[${tag}] 备份 users 完整（数组且每用户含 username/passHash/salt）`,
      Array.isArray(bak.users) && bak.users.length > 0 &&
      bak.users.every(u => u.username && u.passHash && u.salt),
      `实际 users.length=${bak.users && bak.users.length}`);
  } catch (e) {
    check(`[${tag}] 备份可解析`, false, e.message.slice(0, 100));
  }
}

// ============================================================
console.log('\n===== 7. desc 乱码/截断抽查 =====');
// 全量扫描乱码特征 + 随机/首尾/中位抽查若干本打印 desc 供人工复核
for (const [tag, data] of [['本地', localRes.data], ['线上', onlineRes.data]]) {
  const garbled = data.books.filter(b => looksGarbled(b.desc));
  check(`[${tag}] 无乱码特征字符`, garbled.length === 0,
    garbled.slice(0, 3).map(b => b.title).join('/'));
  const emptyDesc = data.books.filter(b => !b.desc || !String(b.desc).trim());
  check(`[${tag}] desc 无空值`, emptyDesc.length === 0, emptyDesc.map(b => b.title).slice(0, 3).join('/'));
  // desc 长度分布（检测疑似截断：过短）
  const lens = data.books.map(b => ({ t: b.title, l: (b.desc || '').length })).sort((a, b) => a.l - b.l);
  console.log(`    [${tag}] desc 最短 3 本: ${lens.slice(0, 3).map(x => `${x.t}(${x.l}字)`).join(', ')}`);
  console.log(`    [${tag}] desc 最长 1 本: ${lens[lens.length - 1].t}(${lens[lens.length - 1].l}字)`);
  // 抽样打印：第一本、中间一本、最后一本
  const sampleIdx = [0, Math.floor(data.books.length / 2), data.books.length - 1];
  for (const i of sampleIdx) {
    const b = data.books[i];
    console.log(`    [${tag}] 抽样[${i}]《${b.title}》难度${b.difficulty} desc(${b.desc.length}字): ${b.desc}`);
  }
}

// ============================================================
console.log(`\n===== 汇总: PASS ${pass} / FAIL ${fail} =====`);
if (issues.length) {
  console.log('失败项:');
  issues.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  process.exit(1);
}

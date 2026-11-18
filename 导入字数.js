/**
 * 导入字数脚本 —— 书香读书系统
 *
 * 功能：
 *   1. 解析 书单字数清单.md 的「约字数」列（万为单位，兼容「10万左右」等写法）
 *   2. 按书名匹配两份 书会数据.json 的 books，更新 totalWords（单位：万）
 *   3. totalPages 缺失/为 0 时按既有约定推导：约 700 字/页 → 每万字约 14.3 页
 *      （与《三体》28万→400页 的存量数据一致）
 *      已有 totalPages 的书保留原页数；《三体》按清单改为三部合计 90 万，页数同步重算
 *   4. 幂等：重复运行结果一致；users 及其他顶层键绝不改动
 *
 * 运行：node 导入字数.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '书单字数清单.md');
const DATA_FILES = [
  path.join(__dirname, '书会数据.json'),
  path.join('D:', path.sep, '书香读书系统-线上', '书会数据.json'),
];
const WORDS_PER_PAGE = 700; // 既有约定：约 700 字/页

/** 「26万」/「10万左右」/「约 140万」→ 26/10/140（万）；无法解析返回 null */
function parseWords(cell) {
  const m = String(cell).match(/([\d.]+)\s*万/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 从 markdown 提取书名与字数。只解析「## 字数统计」之前的主表格，
 *  避免误吃文末 Top10 排名表/分段表（那里列顺序不同）。 */
function parseList(md) {
  const cut = md.indexOf('## 字数统计');
  if (cut > 0) md = md.slice(0, cut);
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((s) => s.trim());
    // cells[0] 为空（行首竖线产生），实际列：cells[1]=书名 cells[2]=作者 cells[4]=约字数
    const title = (cells[1] || '').replace(/\*\*/g, '').trim();
    const words = parseWords(cells[4] || '');
    if (!title || title === '书名' || !words) continue;
    out.push({ title, words });
  }
  return out;
}

function main() {
  console.log('=== 书香读书系统 · 字数导入脚本 ===');
  const list = parseList(fs.readFileSync(SOURCE_FILE, 'utf8'));
  console.log(`清单解析: ${list.length} 本书有字数`);

  // 清单内重名自检
  const seen = new Set();
  for (const it of list) {
    if (seen.has(it.title)) throw new Error(`清单内重名书：${it.title}`);
    seen.add(it.title);
  }

  const report = [];
  let totalErrs = 0;

  for (const file of DATA_FILES) {
    const label = file.includes('线上') ? '线上版' : '本地版';
    console.log(`\n----------------------------------------\n处理: ${file}`);
    if (!fs.existsSync(file)) throw new Error(`数据文件不存在: ${file}`);

    // 备份（幂等：首次运行才建）
    const backup = file + '.字数导入前备份';
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
      console.log(`  已备份 → ${backup}`);
    } else {
      console.log(`  备份已存在，跳过: ${backup}`);
    }

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = {
      usersCount: data.users.length,
      bookCount: data.books.length,
      byTitle: new Map(data.books.map((b) => [b.title, { totalWords: b.totalWords, totalPages: b.totalPages }])),
    };

    let updated = 0;
    const missing = [];
    for (const { title, words } of list) {
      const b = data.books.find((x) => x.title === title);
      if (!b) { missing.push(title); continue; }
      b.totalWords = words;
      // 页数：缺失/为 0 时推导；已有页数但与字数明显不符（>30% 偏差）也重算
      const derived = Math.round((words * 10000) / WORDS_PER_PAGE);
      const cur = Number(b.totalPages) || 0;
      if (cur === 0 || Math.abs(cur - derived) / derived > 0.3) {
        b.totalPages = derived;
        if (cur > 0) console.log(`  页数重算: 《${title}》 ${cur} → ${derived} 页（字数 ${words} 万）`);
      }
      updated++;
    }
    // 清单里有、库里没有 → 明确报告，不静默
    for (const t of missing) console.log(`  ⚠ 清单中书《${t}》不在库中，跳过`);
    // 库里有、清单没有字数的书 → 保留原值并报告
    const untouched = data.books.filter((b) => !seen.has(b.title)).map((b) => b.title);
    if (untouched.length) console.log(`  未在清单中的库内书（保留原值 ${untouched.length} 本）: ${untouched.join('、')}`);

    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');

    // 校验：重新读回，比对落盘内容
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errs = [];
    if (after.users.length !== before.usersCount) errs.push('users 数量变化！');
    if (after.books.length !== before.bookCount) errs.push('books 数量变化！');
    let wordOk = 0;
    for (const { title, words } of list) {
      const b = after.books.find((x) => x.title === title);
      if (!b) continue;
      if (b.totalWords === words) wordOk++; else errs.push(`《${title}》totalWords=${b.totalWords} 应为 ${words}`);
      const cur = Number(b.totalPages) || 0;
      if (cur === 0) errs.push(`《${title}》totalPages 仍为 0`);
    }
    // 顶层其他键数量不变
    for (const k of ['achievements', 'forum', 'notifications', 'activities']) {
      if (!Array.isArray(after[k])) errs.push(`${k} 丢失`);
    }
    // 抽查《三体》
    const st = after.books.find((b) => b.title === '三体');
    if (!st || st.totalWords !== 90) errs.push(`抽查《三体》: totalWords=${st && st.totalWords} 应为 90`);

    console.log(`  更新字数: ${updated}/${list.length} 本，落盘校验字数正确 ${wordOk} 本`);
    console.log(`  校验: ${errs.length === 0 ? '✅ 全部通过' : '❌ ' + errs.join('; ')}`);
    report.push({ label, errs });
    totalErrs += errs.length;
  }

  console.log('\n========================================');
  if (totalErrs > 0) {
    console.log(`结果: ❌ 共 ${totalErrs} 个校验错误，请检查！`);
    process.exitCode = 1;
  } else {
    console.log('结果: ✅ 两份数据文件字数导入完成，全部校验通过。');
  }
}

main();

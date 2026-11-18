/**
 * 多卷书拆分脚本 —— 书香读书系统
 *
 * 用户决策（2026-11-18）：多卷书必须拆成独立条目才好登记——读完上册即算完整一本。
 * 拆分规则：
 *   - 每卷条目：书名=原名（册号后缀），字数/页数按卷数均摊（长除余数摊给前面的册）
 *   - 作者/简介/分类/难度 沿用原书；测评题挂在第一册（题目针对全书，其余册 desc 注明）
 *   - 所有分册挂 series（同系列相邻显示成组）；原单条目删除
 * 幂等：按「原始书名存在」判断，拆过就跳过；users 及其他顶层键绝不改动
 *
 * 运行：node 拆分多卷.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILES = [
  path.join(__dirname, '书会数据.json'),
  path.join('D:', path.sep, '书香读书系统-线上', '书会数据.json'),
];

/** 拆分定义：base=原书名；parts=分册后缀数组 */
const SPLIT_DEFS = [
  { base: '白夜行', parts: ['上册', '下册'], series: '白夜行系列' },
  { base: '基督山伯爵', parts: ['上册', '下册'], series: '基督山伯爵系列' },
  { base: '国富论', parts: ['上册', '下册'], series: '国富论系列' },
  { base: '三体', parts: ['第一部', '第二部', '第三部'], series: '三体系列' },
  { base: '资本论', parts: ['第一卷', '第二卷', '第三卷'], series: '资本论系列' },
  { base: '平凡的世界', parts: ['第一部', '第二部', '第三部'], series: '平凡的世界系列' },
  { base: '明朝那些事儿', parts: ['第一册', '第二册', '第三册', '第四册', '第五册', '第六册', '第七册', '第八册', '第九册'], series: '明朝那些事儿系列' },
];

/** 均摊：把 total 分成 n 份，余数从左到右每份 +1（字数允许 0.5 步进用 x2 处理） */
function evenSplit(total, n, halfStep) {
  const t = halfStep ? Math.round(total * 2) : total;
  const base = Math.floor(t / n), rem = t % n;
  return Array.from({ length: n }, (_, i) => {
    const v = base + (i < rem ? 1 : 0);
    return halfStep ? v / 2 : v;
  });
}

function main() {
  console.log('=== 书香读书系统 · 多卷书拆分脚本 ===');
  let totalErrs = 0;

  for (const file of DATA_FILES) {
    const label = file.includes('线上') ? '线上版' : '本地版';
    console.log(`\n--- ${label}: ${file}`);
    const backup = file + '.拆分前备份';
    if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup); console.log(`  已备份 → ${backup}`); }

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = { usersCount: data.users.length, bookCount: data.books.length };
    let idBase = Math.max(Date.now(), ...data.books.map((b) => (typeof b.id === 'number' ? b.id : 0))) + 1;

    let splitBooks = 0, newCount = 0;
    for (const def of SPLIT_DEFS) {
      const orig = data.books.find((b) => b.title === def.base);
      // 幂等：原条目不在（已拆过）则跳过
      if (!orig) { console.log(`  《${def.base}》原条目不在，视为已拆，跳过`); continue; }

      const words = evenSplit(orig.totalWords || 0, def.parts.length, true);
      const pages = evenSplit(orig.totalPages || 0, def.parts.length, false);
      const pieces = def.parts.map((suffix, i) => ({
        id: idBase++,
        title: `${def.base}（${suffix}）`,
        author: orig.author,
        totalPages: pages[i],
        totalWords: words[i],
        difficulty: orig.difficulty,
        category: orig.category,
        series: def.series,
        desc: (orig.desc || '') + (i === 0 ? '' : `〔测评题挂《${def.base}（${def.parts[0]}）》〕`),
        questions: i === 0 ? (orig.questions || []) : [],
      }));
      // 移除原条目、追加分册
      data.books = data.books.filter((b) => b.id !== orig.id);
      data.books.push(...pieces);
      splitBooks++; newCount += pieces.length;
      console.log(`  《${def.base}》→ ${pieces.length} 册（${words.join('/')} 万字，${pages.join('/')} 页，题目挂第一册）`);
    }

    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');

    // 读回校验
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errs = [];
    if (after.users.length !== before.usersCount) errs.push('users 变化！');
    const expectCount = before.bookCount + newCount - splitBooks;
    if (after.books.length !== expectCount) errs.push(`书籍数 ${after.books.length} 应为 ${expectCount}`);
    if (after.books.some((b) => b.title.includes('白夜行') && !b.title.includes('（'))) errs.push('《白夜行》单条目残留！');
    // 分册校验：都在、系列齐、字数页数为正
    for (const def of SPLIT_DEFS) {
      const pieces = after.books.filter((b) => b.title.startsWith(def.base + '（'));
      if (pieces.length !== def.parts.length) { errs.push(`《${def.base}》分册数 ${pieces.length} 应为 ${def.parts.length}`); continue; }
      if (!pieces.every((b) => b.series === def.series && b.category && b.totalWords > 0 && b.totalPages > 0)) errs.push(`《${def.base}》分册字段缺失`);
      const q0 = pieces[0].questions.length, qRest = pieces.slice(1).reduce((s, b) => s + b.questions.length, 0);
      if (qRest > 0) errs.push(`《${def.base}》非第一册不应带题目`);
      console.log(`  校验《${def.base}》: ${pieces.length} 册 · 系列${def.series} · 题目 ${q0} 道挂第一册 ✅`);
    }
    const dupIds = after.books.length - new Set(after.books.map((b) => b.id)).size;
    if (dupIds) errs.push(`id 重复 ${dupIds} 个`);
    console.log(`  书籍 ${before.bookCount} → ${after.books.length} 本 · users ${after.users.length}`);
    console.log(`  校验: ${errs.length === 0 ? '✅ 全部通过' : '❌ ' + errs.join('; ')}`);
    totalErrs += errs.length;
  }

  console.log('\n结果: ' + (totalErrs === 0 ? '✅ 两份数据文件拆分完成。' : `❌ ${totalErrs} 个错误`));
  if (totalErrs) process.exitCode = 1;
}

main();

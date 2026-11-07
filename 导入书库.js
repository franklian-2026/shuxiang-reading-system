/**
 * 导入书库脚本 —— 书香读书系统
 *
 * 功能：
 *   1. 备份两份 书会数据.json（同目录，后缀 .导入前备份）
 *   2. 将 书单导入源.json 的 79 本书合并进两份数据文件的 books（按书名精确匹配去重）
 *      - 已存在同名书：author 为空/佚名则覆盖；desc 为空则填入；difficulty 直接更新；
 *        id/totalPages/totalWords/questions 保留原值
 *      - 不存在：新增 { id, title, author, totalPages: 0, totalWords: 0, difficulty, desc, questions: [] }
 *   3. JSON 以 2 空格缩进写回，其他顶层键原样保留（users 绝不改动）
 *   4. 自动执行校验并打印汇总报告
 *
 * 运行：node 导入书库.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const SOURCE_FILE = path.join(__dirname, '书单导入源.json');
const DATA_FILES = [
  path.join(__dirname, '书会数据.json'),
  path.join('D:', path.sep, '书香读书系统-线上', '书会数据.json'),
];
const ANON_AUTHOR = '佚名';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 判断作者是否为「空/佚名」，需要用源值覆盖 */
function isMissingAuthor(author) {
  return typeof author !== 'string' || author.trim() === '' || author.trim() === ANON_AUTHOR;
}

/** 生成新书的唯一 id：以 Date.now() 与现有最大 id 为基准自增，保证不与已有 id 冲突 */
function nextIdBase(existingBooks) {
  const now = Date.now();
  const maxExisting = existingBooks.reduce((m, b) => (typeof b.id === 'number' && b.id > m ? b.id : m), 0);
  return Math.max(now, maxExisting + 1);
}

/** 校验单本书的字段完整性，返回错误信息数组（空数组 = 通过） */
function validateBook(book, index, seenIds) {
  const errs = [];
  if (typeof book.id !== 'number' || Number.isNaN(book.id)) {
    errs.push(`books[${index}](${book.title || '?'}): id 不是数字`);
  } else if (seenIds.has(book.id)) {
    errs.push(`books[${index}](${book.title}): id 重复 ${book.id}`);
  }
  if (typeof book.title !== 'string' || !book.title.trim()) {
    errs.push(`books[${index}]: title 缺失`);
  }
  if (!Number.isInteger(book.difficulty) || book.difficulty < 1 || book.difficulty > 5) {
    errs.push(`books[${index}](${book.title}): difficulty=${book.difficulty} 不在 1-5`);
  }
  if (!Array.isArray(book.questions)) {
    errs.push(`books[${index}](${book.title}): questions 不是数组`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// 核心合并逻辑
// ---------------------------------------------------------------------------

/**
 * 将源书单合并进 data.books（按书名精确匹配去重），原地修改 data 并返回统计。
 * @param {object} data  数据文件解析后的对象
 * @param {Array}  sourceBooks  导入源 books
 * @returns {{existingUpdated: number, added: number, finalCount: number, originalCount: number, dedupTitles: string[]}}
 */
function mergeBooks(data, sourceBooks) {
  const originalCount = data.books.length;
  const byTitle = new Map();
  for (const b of data.books) byTitle.set(b.title, b);

  const dedupTitles = [];
  let existingUpdated = 0;
  let added = 0;

  // 新书 id 基准：保证不与现有 id 冲突
  let idBase = nextIdBase(data.books);

  for (const src of sourceBooks) {
    const existing = byTitle.get(src.title);
    if (existing) {
      // 已存在：只补空/佚名字段，保留 id/totalPages/totalWords/questions
      dedupTitles.push(src.title);
      if (isMissingAuthor(existing.author)) existing.author = src.author;
      if (typeof existing.desc !== 'string' || existing.desc.trim() === '') existing.desc = src.desc;
      existing.difficulty = src.difficulty;
      existingUpdated++;
    } else {
      // 不存在：新增
      const newBook = {
        id: idBase++,
        title: src.title,
        author: src.author,
        totalPages: 0,
        totalWords: 0,
        difficulty: src.difficulty,
        desc: src.desc,
        questions: [],
      };
      data.books.push(newBook);
      byTitle.set(newBook.title, newBook);
      added++;
    }
  }

  return { existingUpdated, added, finalCount: data.books.length, originalCount, dedupTitles };
}

// ---------------------------------------------------------------------------
// 校验逻辑
// ---------------------------------------------------------------------------

/**
 * 对合并后的数据文件做完整校验。
 * @param {string} label  文件标签（本地/线上）
 * @param {object} before  导入前快照 {usersCount, firstUsername, counts, firstUserRef}
 * @param {object} after   合并后的数据对象
 * @param {object} stats   mergeBooks 返回的统计
 * @param {Array}  sourceBooks  导入源
 */
function validate(label, before, after, stats, sourceBooks) {
  const errs = [];
  const lines = [];

  // 1. 数量公式校验：最终 = 原有 + 新增源书 - 去重数
  const dedup = sourceBooks.length - stats.added;
  const expected = before.bookCount + stats.added;
  lines.push(`  书籍数量: ${before.bookCount} → ${after.books.length}（去重 ${dedup} 本，新增 ${stats.added} 本，期望 ${expected}）`);
  if (after.books.length !== expected) errs.push(`书籍数量不符：期望 ${expected}，实际 ${after.books.length}`);

  // 2. 抽查书籍字段完整性
  const spotTitles = ['三体', '百年孤独', '资本论', '白鸟岛（精忠录）'];
  for (const t of spotTitles) {
    const b = after.books.find((x) => x.title === t);
    if (!b) {
      errs.push(`抽查失败：找不到《${t}》`);
      continue;
    }
    const issues = [];
    if (t === '三体') {
      if (b.author !== '刘慈欣') issues.push(`author=${b.author} 应为 刘慈欣`);
      if (b.difficulty !== 4) issues.push(`difficulty=${b.difficulty} 应为 4`);
      if (!b.desc || !b.desc.trim()) issues.push('desc 为空');
      const orig = before.bookSnapshot['三体'];
      if (orig && b.id !== orig.id) issues.push(`id 变了：${orig.id} → ${b.id}`);
      if (orig && JSON.stringify(b.questions) !== JSON.stringify(orig.questions)) issues.push('questions 被改动');
      if (orig && b.totalPages !== orig.totalPages) issues.push(`totalPages 被改动：${orig.totalPages} → ${b.totalPages}`);
    } else {
      if (typeof b.author !== 'string' || !b.author.trim()) issues.push('author 缺失');
      if (!Number.isInteger(b.difficulty) || b.difficulty < 1 || b.difficulty > 5) issues.push(`difficulty=${b.difficulty} 非法`);
      if (!b.desc || !b.desc.trim()) issues.push('desc 缺失');
      if (!Array.isArray(b.questions)) issues.push('questions 非数组');
      if (typeof b.id !== 'number') issues.push('id 非数字');
      if (t === '资本论' && b.difficulty !== 5) issues.push(`difficulty=${b.difficulty} 应为 5`);
      if (t === '百年孤独' && b.author !== '加西亚·马尔克斯') issues.push(`author=${b.author}`);
    }
    lines.push(`  抽查《${t}》: ${issues.length ? '❌ ' + issues.join('; ') : '✅ 通过'} ${t === '三体' ? `(id=${b.id}, totalPages=${b.totalPages})` : `(id=${b.id})`}`);
    if (issues.length) errs.push(`抽查《${t}》失败: ${issues.join('; ')}`);
  }

  // 3. users 不可变校验
  const usersOk = after.users.length === before.usersCount && after.users[0].username === before.firstUsername;
  lines.push(`  users: ${before.usersCount} → ${after.users.length}, 首个用户名 ${before.firstUsername} → ${after.users[0].username} ${usersOk ? '✅' : '❌'}`);
  if (!usersOk) errs.push('users 数据发生变化（数量或首用户名）！');

  // 4. 其他顶层键数量一致
  for (const k of ['achievements', 'forum', 'notifications', 'activities']) {
    const ok = Array.isArray(after[k]) && after[k].length === before.counts[k];
    lines.push(`  ${k}: ${before.counts[k]} → ${Array.isArray(after[k]) ? after[k].length : '?'} ${ok ? '✅' : '❌'}`);
    if (!ok) errs.push(`${k} 数量发生变化！`);
  }

  // 5. 全量校验：唯一 id、difficulty 1-5、questions 为数组
  const seenIds = new Set();
  let dupIds = 0, badDiff = 0, badQ = 0;
  for (const b of after.books) {
    if (seenIds.has(b.id)) dupIds++;
    seenIds.add(b.id);
    if (!Number.isInteger(b.difficulty) || b.difficulty < 1 || b.difficulty > 5) badDiff++;
    if (!Array.isArray(b.questions)) badQ++;
  }
  const allOk = dupIds === 0 && badDiff === 0 && badQ === 0;
  lines.push(`  全量 ${after.books.length} 本: id 重复 ${dupIds}, difficulty 越界 ${badDiff}, questions 非数组 ${badQ} ${allOk ? '✅' : '❌'}`);
  if (!allOk) errs.push(`全量校验失败: 重复id=${dupIds}, difficulty越界=${badDiff}, questions非数组=${badQ}`);

  console.log(`\n【${label}】校验结果 ${errs.length === 0 ? '✅ 全部通过' : '❌ 存在问题'}`);
  for (const l of lines) console.log(l);

  return { errs, lines, dedup, allOk };
}

/** 导入前快照，用于前后对比 */
function snapshot(data) {
  const bookSnapshot = {};
  for (const b of data.books) bookSnapshot[b.title] = b;
  return {
    bookCount: data.books.length,
    usersCount: data.users.length,
    firstUsername: data.users[0] ? data.users[0].username : null,
    counts: {
      achievements: Array.isArray(data.achievements) ? data.achievements.length : -1,
      forum: Array.isArray(data.forum) ? data.forum.length : -1,
      notifications: Array.isArray(data.notifications) ? data.notifications.length : -1,
      activities: Array.isArray(data.activities) ? data.activities.length : -1,
    },
    bookSnapshot,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  console.log('=== 书香读书系统 · 书库导入脚本 ===');

  // 读取导入源
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const sourceBooks = source.books;
  console.log(`导入源: ${sourceBooks.length} 本书（来自 书单导入源.json）`);

  // 源内重名自检
  const srcTitles = new Set();
  for (const b of sourceBooks) {
    if (srcTitles.has(b.title)) throw new Error(`导入源内存在重名书：${b.title}`);
    srcTitles.add(b.title);
  }

  const report = [];
  let totalErrors = 0;

  for (const file of DATA_FILES) {
    const label = file.includes('线上') ? '线上版' : '本地版';
    console.log(`\n----------------------------------------\n处理: ${file}`);

    // 1. 备份（备份文件不存在时才创建，避免重复运行覆盖原始备份）
    const backupFile = file + '.导入前备份';
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(file, backupFile);
      console.log(`  已备份 → ${backupFile}`);
    } else {
      console.log(`  备份已存在，跳过（保留最早原始备份）: ${backupFile}`);
    }

    // 2. 读取 + 快照
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = snapshot(data);

    // 3. 合并
    const stats = mergeBooks(data, sourceBooks);
    console.log(`  已存在同名（去重并补字段）: ${stats.existingUpdated} 本 → [${stats.dedupTitles.join('、')}]`);
    console.log(`  新增: ${stats.added} 本`);

    // 4. 写回（2 空格缩进，其他顶层键原样保留——mergeBooks 只改 data.books）
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`  已写回（JSON 2 空格缩进）`);

    // 5. 重新读回校验（以落盘内容为准）
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = validate(label, before, after, stats, sourceBooks);
    report.push({ label, file, stats, v });
    totalErrors += v.errs.length;
  }

  // 汇总报告
  console.log('\n========================================');
  console.log('=== 汇总报告 ===');
  for (const r of report) {
    console.log(`${r.label} (${r.file}):`);
    console.log(`  书籍 ${r.stats.originalCount} → ${r.stats.finalCount} 本（去重 ${r.v.dedup}，新增 ${r.stats.added}）`);
    console.log(`  校验: ${r.v.allOk ? '✅ 全部通过' : '❌ ' + r.v.errs.join('; ')}`);
  }
  if (totalErrors > 0) {
    console.log(`\n结果: ❌ 共 ${totalErrors} 个校验错误，请检查！`);
    process.exitCode = 1;
  } else {
    console.log(`\n结果: ✅ 两份文件导入完成，全部校验通过。`);
  }
}

main();

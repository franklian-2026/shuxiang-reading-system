/**
 * 导入分类脚本 —— 书香读书系统
 *
 * 功能：
 *   1. 解析 书单字数清单.md 的分类标题行（| **文学小说** | …），给每本书写入 category 字段
 *   2. 清单外的 5 本书按简介归类（快乐王子→文学、当幸福来敲门→传记、白鸟岛→历史、火牌→纪实等）
 *   3. 系列归拢：同系列书写 series 字段（教父系列、简史系列）；单本多卷书写 volNote（上下两册/三卷本等）
 *   4. 幂等；users 及其他顶层键绝不改动
 *
 * 运行：node 导入分类.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '书单字数清单.md');
const DATA_FILES = [
  path.join(__dirname, '书会数据.json'),
  path.join('D:', path.sep, '书香读书系统-线上', '书会数据.json'),
];

/** 清单外书籍的归类（按简介人工判定） */
const EXTRA_CATEGORY = {
  '快乐王子': '文学小说',
  '一只特立独行的猪': '文学小说',
  '当幸福来敲门': '人物传记',
  '白鸟岛（精忠录）': '社科·历史·哲学',
  '火牌—寻找中国': '社会纪实',
};

/** 系列归拢：同 series 值的书在书库中相邻显示并挂系列徽章 */
const SERIES = {
  '教父': '教父系列',
  '教父2：西西里人': '教父系列',
  '教父3：最后的教父': '教父系列',
  '人类简史': '简史系列',
  '未来简史': '简史系列',
};

/** 单本多卷标记（书是一册条目，但实体分多册） */
const VOL_NOTE = {
  '基督山伯爵': '上下两册',
  '国富论': '上下两册',
  '资本论': '三卷本',
  '平凡的世界': '三卷本',
  '明朝那些事儿': '九册合集',
  '三体': '三部曲合集',
};

/** 从清单解析 书名→分类：只认「| **分类** |」标题行与其后的数据行 */
function parseCategories(md) {
  const map = {};
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((s) => s.trim());
    const c1 = (cells[1] || '').replace(/\*\*/g, '').trim();
    // 分类标题行：首格加粗、其余格全空
    if (/^\*\*.+\*\*$/.test(cells[1] || '') && cells.slice(2).every((c) => !c)) {
      cur = c1;
      continue;
    }
    if (cur && c1 && c1 !== '书名') map[c1] = cur;
  }
  return map;
}

function main() {
  console.log('=== 书香读书系统 · 分类导入脚本 ===');
  const catMap = parseCategories(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const total = Object.keys(catMap).length + Object.keys(EXTRA_CATEGORY).length;
  console.log(`清单解析: ${Object.keys(catMap).length} 本 + 清单外人工归类 ${Object.keys(EXTRA_CATEGORY).length} 本 = ${total} 本`);

  let totalErrs = 0;
  for (const file of DATA_FILES) {
    const label = file.includes('线上') ? '线上版' : '本地版';
    console.log(`\n--- ${label}: ${file}`);
    const backup = file + '.分类导入前备份';
    if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup); console.log(`  已备份 → ${backup}`); }

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = { usersCount: data.users.length, bookCount: data.books.length };

    let updated = 0, catSet = new Set(), seriesN = 0, volN = 0;
    const unknown = [];
    for (const b of data.books) {
      const cat = catMap[b.title] || EXTRA_CATEGORY[b.title];
      if (!cat) { unknown.push(b.title); continue; }
      b.category = cat;
      if (SERIES[b.title]) { b.series = SERIES[b.title]; seriesN++; } else delete b.series;
      if (VOL_NOTE[b.title]) { b.volNote = VOL_NOTE[b.title]; volN++; } else delete b.volNote;
      catSet.add(cat);
      updated++;
    }
    if (unknown.length) console.log(`  ⚠ 未归类的书（保留无分类）: ${unknown.join('、')}`);

    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');

    // 读回校验
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errs = [];
    if (after.users.length !== before.usersCount) errs.push('users 变化！');
    if (after.books.length !== before.bookCount) errs.push('books 数量变化！');
    let okCat = 0;
    for (const b of after.books) {
      const expect = catMap[b.title] || EXTRA_CATEGORY[b.title];
      if (!expect) continue;
      if (b.category === expect) okCat++; else errs.push(`《${b.title}》category=${b.category} 应为 ${expect}`);
    }
    for (const [t, s] of Object.entries(SERIES)) {
      const b = after.books.find((x) => x.title === t);
      if (b && b.series !== s) errs.push(`《${t}》series=${b.series} 应为 ${s}`);
    }
    console.log(`  分类写入: ${okCat} 本 · 系列标记 ${seriesN} 本 · 多卷标记 ${volN} 本`);
    console.log(`  分类全集: [${[...catSet].join('、')}]`);
    console.log(`  校验: ${errs.length === 0 ? '✅ 全部通过' : '❌ ' + errs.join('; ')}`);
    totalErrs += errs.length;
  }

  console.log('\n结果: ' + (totalErrs === 0 ? '✅ 两份数据文件分类导入完成。' : `❌ ${totalErrs} 个错误`));
  if (totalErrs) process.exitCode = 1;
}

main();

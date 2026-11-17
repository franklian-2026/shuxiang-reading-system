/**
 * 导入题目.js — 解析 D:\书单题目.md 并把题目合并进书会数据.json 的 books[].questions
 *
 * 用法: node 导入题目.js <数据文件路径>
 *   例: node 导入题目.js "D:\书香读书系统\书会数据.json"
 *
 * 题目 schema:
 *   选择题: { q, opts: [...], ans: 正确选项索引 }            (与现有数据一致, 无 type 字段)
 *   填空题: { q, type: 'blank', answer: '参考答案' }          (answer 含 / 表示多种可接受写法)
 *   理解题: { q, type: 'essay' }
 *
 * 合并规则: 书已有 questions 时追加不覆盖; 整本按题干去重。
 * 只改 books 数组, users 等其余字段原样保留。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MD_FILE = process.env.MD_FILE || 'D:\\书单题目.md';

// ---------- 读取命令行指定的数据文件 ----------
const dataFile = process.argv[2];
if (!dataFile) {
    console.error('用法: node 导入题目.js <书会数据.json 路径>');
    process.exit(1);
}
if (!fs.existsSync(dataFile)) {
    console.error('数据文件不存在: ' + dataFile);
    process.exit(1);
}
if (!fs.existsSync(MD_FILE)) {
    console.error('题库文件不存在: ' + MD_FILE);
    process.exit(1);
}

// ---------- 解析 ----------
const failures = [];   // 解析失败明细
const RE_BOOK = /^###\s+\d+\.\s*《(.+?)》\s*(.*)$/;
const RE_SEC_CHOICE = /^####\s*选择题/;
const RE_SEC_BLANK = /^####\s*填空题/;
const RE_SEC_ESSAY = /^####\s*理解\/心得题/;
const RE_STEM = /^\*\*(\d+)\.\*\*\s*(.*)$/;
const RE_OPT = /^-\s*([A-Za-z])\.\s*(.*)$/;
const RE_ANS = /^\*\*答案：\s*([A-Za-z])\s*\*\*/;
const RE_REF_ANS = /^\*\*参考答案：\*\*\s*(.*)$/;
const RE_BLANK_Q = /^(\d+)\.\s*(.*)$/;

/**
 * 从标题行提取书名与作者。
 * 返回 { title, author, skip } — skip=true 表示备注条目(如《飘》补充)需跳过。
 */
function parseBookHeading(line) {
    const m = line.match(RE_BOOK);
    if (!m) return null;
    const title = m[1].trim();
    let rest = (m[2] || '').trim();
    // 备注条目跳过: "（补充，之前没单独出题，用上面的就好）"
    if (rest.includes('补充') || rest.includes('用上面的就好')) {
        return { title, author: '', skip: true };
    }
    // 作者: "— 作者" 格式, 可能紧跟 "（注释）"
    rest = rest.replace(/^[-—–·\s]+/, '');
    const parenIdx = rest.indexOf('（');
    let author = parenIdx >= 0 ? rest.slice(0, parenIdx) : rest;
    author = author.replace(/[-—–\s]+$/, '').trim();
    return { title, author: author || '佚名', skip: false };
}

/** 清洗填空参考答案: "（或X）" 转为 "/X" 多写法分隔, 其余原样保留 */
function cleanBlankAnswer(ans) {
    return ans.replace(/（或([^）]*)）/g, '/$1').trim();
}

/** 解析一行参考答案: "1. X 2. Y 3. Z 4. W" → {1:'X', 2:'Y', ...} */
function splitRefAnswers(text) {
    const map = {};
    const parts = text.split(/\s+(?=\d{1,2}\.\s)/);
    for (const p of parts) {
        const m = p.trim().match(/^(\d{1,2})\.\s*([\s\S]*)$/);
        if (m) map[parseInt(m[1], 10)] = m[2].trim();
    }
    return map;
}

function parseMd() {
    const lines = fs.readFileSync(MD_FILE, 'utf8').split(/\r?\n/);
    const books = [];
    let cur = null;          // 当前书 { title, author, choice:[], blank:[], essay:[], blankAnswers:{} }
    let sec = null;          // 当前小节: 'choice' | 'blank' | 'essay' | null
    let cq = null;           // 当前选择题草稿
    let essayLines = [];
    const stats = { books: 0, skipped: 0 };

    const flushEssay = () => {
        if (cur && sec === 'essay') {
            const q = essayLines.join('\n').trim();
            if (q) cur.essay.push({ q, type: 'essay' });
        }
        essayLines = [];
    };

    for (const raw of lines) {
        const line = raw.trim();

        // 新书条目
        const hb = parseBookHeading(line);
        if (hb) {
            flushEssay();
            if (cur) books.push(cur);
            if (hb.skip) { stats.skipped++; cur = null; sec = null; continue; }
            cur = { title: hb.title, author: hb.author, choice: [], blank: [], essay: [], blankAnswers: {} };
            sec = null;
            stats.books++;
            continue;
        }
        if (!cur) continue;

        // 小节切换
        if (RE_SEC_CHOICE.test(line)) { flushEssay(); sec = 'choice'; continue; }
        if (RE_SEC_BLANK.test(line)) { flushEssay(); sec = 'blank'; continue; }
        if (RE_SEC_ESSAY.test(line)) { flushEssay(); sec = 'essay'; continue; }

        // 大标题/分隔线: 结束当前小节
        if (/^##\s/.test(line) || line === '---') { flushEssay(); sec = null; cq = null; continue; }
        if (/^#{1,4}\s/.test(line)) { flushEssay(); sec = null; cq = null; continue; }
        if (!sec || !line) continue;

        if (sec === 'choice') {
            // 选择题: 题干 / 选项 / 答案 (选项按字母收集, 答案按字母定位, 容忍缺项)
            const sa = line.match(RE_STEM);
            const so = line.match(RE_OPT);
            const sr = line.match(RE_ANS);
            if (sr && cq) {
                const letter = sr[1].toUpperCase();
                const pairs = cq.pairs.slice().sort((a, b) => a[0].localeCompare(b[0]));
                const opts = pairs.map(p => p[1]);
                const idx = pairs.findIndex(p => p[0] === letter);
                if (idx < 0) {
                    failures.push(`[选择题]《${cur.title}》"${cq.q}" 答案 ${letter} 无对应选项, 已跳过`);
                } else {
                    cur.choice.push({ q: cq.q, opts, ans: idx });
                }
                cq = null;
            } else if (so) {
                if (!cq) { failures.push(`[选择题]《${cur.title}》出现孤立选项行: ${line}`); continue; }
                cq.pairs.push([so[1].toUpperCase(), so[2].trim()]);
            } else if (sa) {
                if (cq) failures.push(`[选择题]《${cur.title}》上一题"${cq.q}"缺少答案, 已丢弃`);
                cq = { q: sa[2].trim(), pairs: [] };
            } else {
                // 续行: 追加到题干
                if (cq) cq.q += line;
            }
        } else if (sec === 'blank') {
            // 参考答案行: "**参考答案：** 1. X 2. Y 3. Z 4. W"
            const ra = line.match(RE_REF_ANS);
            if (ra) {
                cur.blankAnswers = splitRefAnswers(ra[1]);
                continue;
            }
            // 填空题: 编号条目
            const sq = line.match(RE_BLANK_Q);
            if (sq) {
                cur.blank.push({ num: parseInt(sq[1], 10), q: sq[2].trim() });
            } else if (cur.blank.length) {
                // 续行追加到最后一题
                const last = cur.blank[cur.blank.length - 1];
                last.q += line;
            }
        } else if (sec === 'essay') {
            // 理解题: 参考答案行也归入(理论上无, 防御), 正文逐行收集
            const ra = line.match(RE_REF_ANS);
            if (ra) continue;   // 理解题不应有参考答案, 忽略
            essayLines.push(line);
        }
    }
    flushEssay();
    if (cur) books.push(cur);
    return { books, stats };
}

/** 把参考答案行按编号对应到填空题, 生成题目对象; 失败返回 null 并记录 */
function buildBlankQuestions(book) {
    const out = [];
    for (const b of book.blank) {
        const ans = book.blankAnswers[b.num];
        if (ans === undefined) {
            failures.push(`[填空题]《${book.title}》第${b.num}题无对应参考答案, 已跳过: ${b.q}`);
            continue;
        }
        out.push({ q: b.q, type: 'blank', answer: cleanBlankAnswer(ans) });
    }
    return out;
}

// ---------- 主流程 ----------
const md = parseMd();
console.log(`题库解析: 共 ${md.stats.books} 个书目条目, 跳过备注条目 ${md.stats.skipped} 个`);

const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
db.books = db.books || [];
const byTitle = new Map(db.books.map(b => [b.title, b]));

let matched = 0, created = 0;
let addedChoice = 0, addedBlank = 0, addedEssay = 0, dupSkipped = 0;
const unmatchedMd = [];
const nextIdBase = Date.now();

// 书名别名映射: md 中的书名 → 库内正式书名
const TITLE_ALIAS = { '动物庄园': '动物农场' };

md.books.forEach((mb, i) => {
    let b = byTitle.get(TITLE_ALIAS[mb.title] || mb.title);
    if (!b) {
        unmatchedMd.push(mb.title);
        // 新建书目条目
        b = {
            id: nextIdBase + i,
            title: mb.title,
            author: mb.author || '佚名',
            totalPages: 0,
            totalWords: 0,
            difficulty: 3,
            desc: '',
            questions: []
        };
        db.books.push(b);
        byTitle.set(mb.title, b);
        created++;
    } else {
        matched++;
    }
    b.questions = b.questions || [];

    const newQs = [
        ...mb.choice,
        ...buildBlankQuestions(mb),
        ...mb.essay
    ];
    for (const q of newQs) {
        if (b.questions.some(x => x.q === q.q)) { dupSkipped++; continue; }
        if (q.type === 'blank') addedBlank++;
        else if (q.type === 'essay') addedEssay++;
        else addedChoice++;
        b.questions.push(q);
    }
});

// ---------- 统计输出 ----------
const totalQ = db.books.reduce((s, b) => s + (b.questions ? b.questions.length : 0), 0);
console.log('\n===== 导入统计 =====');
console.log(`匹配成功(已有书目): ${matched} 本`);
console.log(`新建书目: ${created} 本`);
console.log(`追加选择题: ${addedChoice} 道`);
console.log(`追加填空题: ${addedBlank} 道`);
console.log(`追加理解题: ${addedEssay} 道`);
console.log(`因题干重复跳过: ${dupSkipped} 道`);
console.log(`数据文件 books 总数: ${db.books.length}, 题目总数: ${totalQ}`);

if (unmatchedMd.length) console.log('md 中库内原本没有的书(已新建): ' + unmatchedMd.join(', '));

if (failures.length) {
    console.log(`\n===== 解析失败明细 (${failures.length}) =====`);
    failures.forEach(f => console.log('  ' + f));
} else {
    console.log('\n解析失败: 0 条');
}

// ---------- 抽查 ----------
console.log('\n===== 抽查 =====');
const spot = (title) => {
    const b = byTitle.get(title);
    if (!b) { console.log(`《${title}》未找到`); return; }
    const c = b.questions.filter(q => !q.type).length;
    const bl = b.questions.filter(q => q.type === 'blank').length;
    const es = b.questions.filter(q => q.type === 'essay').length;
    console.log(`《${title}》: 选择${c} + 填空${bl} + 理解${es} = ${b.questions.length} 题`);
    const firstChoice = b.questions.find(q => !q.type);
    if (firstChoice) {
        console.log(`  第1题: ${firstChoice.q}`);
        console.log(`  选项: ${firstChoice.opts.map((o, i) => 'ABCD'[i] + '.' + o).join(' | ')}`);
        console.log(`  ans: ${firstChoice.ans} (即 ${'ABCD'[firstChoice.ans]})`);
    }
    const firstBlank = b.questions.find(q => q.type === 'blank');
    if (firstBlank) console.log(`  填空第1题答案: ${firstBlank.answer}`);
};
spot('百年孤独');
spot('三体');
spot('乌合之众');

// 百年孤独第1题 ans 应为 B → 索引 1
const bn = byTitle.get('百年孤独');
if (bn) {
    const q1 = bn.questions.find(q => !q.type && q.q.includes('作者是哪国作家'));
    if (!q1) console.log('校验失败: 百年孤独第1题未找到');
    else if (q1.ans !== 1) console.log(`校验失败: 百年孤独第1题 ans=${q1.ans}, 应为 1(B)`);
    else console.log('校验通过: 百年孤独第1题 ans=1 (B)');
}

// ---------- 写回 ----------
if (failures.length) {
    console.log('\n存在解析失败条目 — 按"宁缺勿错"原则: 失败题目已跳过, 其余正常写入。');
}
const tmp = dataFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
fs.renameSync(tmp, dataFile);
console.log(`\n已写入: ${path.resolve(dataFile)}`);

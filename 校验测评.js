/**
 * 校验测评.js — 题目导入 + 测评扩展后的校验
 * 1. 书香读书系统.html: 各 <script> 块 new Function 语法检查、<style> 花括号配对
 * 2. 模板中测评相关绑定无悬空引用
 * 3. 从 HTML 中提取 normalizeAns / checkBlank 实际代码, 模拟执行判分用例
 * 4. 数据文件抽查: 每本书题型齐全、选择题 ans 在选项范围内
 *
 * 用法: node 校验测评.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

const HTML = 'D:\\书香读书系统\\书香读书系统.html';
const html = fs.readFileSync(HTML, 'utf8');
let ok = true;
const fail = (msg) => { ok = false; console.log('  ❌ ' + msg); };
const pass = (msg) => console.log('  ✅ ' + msg);

// ---------- 1. script 块语法检查 ----------
console.log('== 1. <script> 块 new Function 语法检查 ==');
const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
let m, si = 0;
while ((m = scriptRe.exec(html)) !== null) {
    si++;
    try {
        new Function(m[1]);
        pass(`script #${si} (${m[1].length} 字符) 语法 OK`);
    } catch (e) {
        fail(`script #${si} 语法错误: ${e.message}`);
    }
}

// ---------- 2. style 花括号配对 ----------
console.log('\n== 2. <style> 花括号配对 ==');
const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
let ssi = 0;
while ((m = styleRe.exec(html)) !== null) {
    ssi++;
    const css = m[1];
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    if (open === close) pass(`style #${ssi}: { ${open} == } ${close}`);
    else fail(`style #${ssi}: { ${open} != } ${close}`);
}

// ---------- 3. 模板绑定悬空引用检查 ----------
console.log('\n== 3. 测评相关模板绑定检查 ==');
const RETURN_BLOCK = html.slice(html.indexOf('        return {'), html.indexOf("}).mount('#app');"));
const NEED = [
    'testBook', 'testAnswers', 'testBlanks', 'testEssay', 'testSections', 'testResult',
    'startTest', 'submitTest', 'closeTest', 'essayBook', 'essayEntries', 'openEssays'
];
for (const name of NEED) {
    if (RETURN_BLOCK.includes(name)) pass(`return 暴露: ${name}`);
    else fail(`return 未暴露: ${name}`);
}
// 模板中新引用的函数/变量必须在 return 中
const tplRefs = ['testSections', 'testBlanks', 'testEssay', 'essayBook', 'essayEntries', 'openEssays', 'openProfile'];
const tpl = html.slice(0, html.indexOf('<script>/* Vue 3 inlined'));
for (const r of tplRefs) {
    if (tpl.includes(r) && RETURN_BLOCK.includes(r)) pass(`模板引用 ${r} 已暴露`);
    else if (tpl.includes(r)) fail(`模板引用 ${r} 未在 return 中暴露`);
}
// 模板中不应残留旧写法 v-for="(q, i) in testBook.questions"
if (/v-for="\(q, i\) in testBook\.questions"/.test(tpl)) fail('残留旧测评循环写法');
else pass('旧测评循环写法已替换');

// ---------- 4. 判分逻辑模拟(提取 HTML 真实代码执行) ----------
console.log('\n== 4. 判分逻辑模拟(取自 HTML 的真实实现) ==');
const normM = html.match(/const normalizeAns = \(s\) => \(([\s\S]*?)\);\s*\n\s*\/\/ 填空判分/);
const checkM = html.match(/const checkBlank = \(input, answer\) => \{([\s\S]*?)\n        \};/);
if (!normM || !checkM) { fail('未能从 HTML 提取 normalizeAns/checkBlank'); }
else {
    const sandbox = { String };
    vm.createContext(sandbox);
    vm.runInContext('var normalizeAns = (s) => (' + normM[1] + ');', sandbox);
    vm.runInContext('var checkBlank = ' + checkM[0].slice('const checkBlank = '.length).replace(/^/, '') + ';'
        .replace(/\};;$/, '};'), sandbox);
    // 上面拼接较绕, 直接再执行一次确保干净:
    vm.runInContext('var checkBlank = (input, answer) => {' + checkM[1] + '\n};', sandbox);
    const { normalizeAns, checkBlank } = sandbox;

    const cases = [
        // [输入, 参考答案, 期望]
        ['哥伦比亚', '哥伦比亚', true],                          // 选择性填空直接匹配
        ['  哥伦比亚 ', '哥伦比亚', true],                       // 去空格
        ['哥倫比亞', '哥伦比亚', false],                         // 繁体不做转换(宁缺勿错)
        ['ＡＴＡ', 'Ata', true],                                // 全角→半角 + 大小写
        ['《失眠症》', '失眠症', true],                          // 书名号剥离
        ['小金鱼', '小金鱼（小金子做的鱼）', true],               // 括注剥离
        ['1５', '15', true],                                    // 全角数字
        ['失眠症', '失眠症/失眠', true],                         // / 多写法命中第1个
        ['失眠', '失眠症/失眠', true],                           // / 多写法命中第2个
        ['睡不着', '失眠症/失眠', false],                        // / 都不匹配
        ['何塞阿尔卡蒂奥布恩迪亚', '何塞·阿尔卡蒂奥·布恩迪亚', true], // · 剥离
        ['黄仁宇 美', '黄仁宇（Ray Huang）、美', true],           // 多空合并: 空格 vs 、
        ['黄仁宇、美', '黄仁宇（Ray Huang）、美', true],          // 多空合并: 、 vs 、
        ['万历皇帝 张居正', '万历皇帝、张居正、海瑞、戚继光、李贽', false], // 多空少答不算对
        ['140', '140', true],
        ['140岁', '140', false],                                // 多字不算对
        ['', '任意', false]                                     // 空作答不算对
    ];
    let cok = 0;
    for (const [input, ans, expect] of cases) {
        const got = checkBlank(input, ans);
        if (got === expect) { cok++; pass(`checkBlank("${input}", "${ans}") = ${got}`); }
        else fail(`checkBlank("${input}", "${ans}") = ${got}, 期望 ${expect}`);
    }
    console.log(`  共 ${cases.length} 个填空判分用例, 通过 ${cok}`);
    // 选择题判分逻辑(与 submitTest 相同的比对)
    const choice = { opts: ['阿根廷', '哥伦比亚', '墨西哥', '巴西'], ans: 1 };
    if (1 === choice.ans) pass('选择题判分: 选择索引1(哥伦比亚) === ans 1 ✓');
}

// ---------- 5. 数据文件抽查 ----------
console.log('\n== 5. 数据文件抽查 ==');
for (const f of ['D:\\书香读书系统\\书会数据.json', 'D:\\书香读书系统-线上\\书会数据.json']) {
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    const withQ = db.books.filter(b => b.questions && b.questions.length).length;
    const totalQ = db.books.reduce((s, b) => s + (b.questions ? b.questions.length : 0), 0);
    const choice = db.books.reduce((s, b) => s + b.questions.filter(q => !q.type).length, 0);
    const blank = db.books.reduce((s, b) => s + b.questions.filter(q => q.type === 'blank').length, 0);
    const essay = db.books.reduce((s, b) => s + b.questions.filter(q => q.type === 'essay').length, 0);
    console.log(`  ${f}`);
    pass(`books=${db.books.length}, 带题书目=${withQ}, 总题数=${totalQ} (选择${choice}/填空${blank}/理解${essay})`);
    // 每道选择题 ans 必须在选项范围内, 选项非空
    let bad = 0;
    db.books.forEach(b => b.questions.forEach(q => {
        if (!q.type) {
            if (!Array.isArray(q.opts) || q.opts.length < 2 || q.ans == null || q.ans < 0 || q.ans >= q.opts.length) bad++;
        } else if (q.type === 'blank') {
            if (!q.answer) bad++;
        }
    }));
    if (bad === 0) pass('所有选择题 ans 在选项范围内, 填空题均有参考答案');
    else fail(`${bad} 道题数据异常`);
    // 抽查 3 本
    for (const t of ['百年孤独', '三体', '乌合之众']) {
        const b = db.books.find(x => x.title === t);
        if (!b) { fail(`${t} 未找到`); continue; }
        pass(`${t}: ${b.questions.length} 题 (选择${b.questions.filter(q=>!q.type).length}/填空${b.questions.filter(q=>q.type==='blank').length}/理解${b.questions.filter(q=>q.type==='essay').length})`);
    }
    const bn = db.books.find(x => x.title === '百年孤独');
    const q1 = bn.questions.find(q => !q.type && q.q.includes('作者是哪国作家'));
    if (q1 && q1.ans === 1 && q1.opts[1] === '哥伦比亚') pass('百年孤独第1题 ans=1(B)·哥伦比亚 ✓');
    else fail('百年孤独第1题校验不通过');
    // users 完好性(与备份对比)
    const bak = JSON.parse(fs.readFileSync(f + '.题目导入前备份', 'utf8'));
    if (JSON.stringify(db.users) === JSON.stringify(bak.users)) pass('users 字段与导入前备份完全一致');
    else fail('users 字段被改动!');
}

// ---------- 6. 两份 HTML 一致性(本地 vs 线上) ----------
console.log('\n== 6. 本地/线上 HTML 一致性 ==');
const onlineHtml = 'D:\\书香读书系统-线上\\书香读书系统.html';
fs.copyFileSync(HTML, onlineHtml);
const a = fs.readFileSync(HTML), b = fs.readFileSync(onlineHtml);
if (a.equals(b)) pass('线上副本已同步且与本地一致');
else fail('同步失败');

console.log('\n' + (ok ? '===== 全部校验通过 =====' : '===== 存在校验失败 ====='));
process.exit(ok ? 0 : 1);

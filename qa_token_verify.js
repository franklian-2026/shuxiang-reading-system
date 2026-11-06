/* 段位令牌 · QA 校验脚本 */
const fs = require('fs');
const path = 'D:/书香读书系统/书香读书系统.html';
const html = fs.readFileSync(path, 'utf8');
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg); if (!cond) fail++; };

// ---- 1. <script> 块 new Function 语法检查 ----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(scripts.length >= 2, '提取到 script 块数量 = ' + scripts.length);
scripts.forEach((s, i) => {
    try { new Function(s); ok(true, `script #${i + 1} 语法检查通过`); }
    catch (e) { ok(false, `script #${i + 1} 语法错误: ${e.message}`); }
});

// ---- 2. <style> 花括号配对 ----
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
styles.forEach((s, i) => {
    const open = (s.match(/{/g) || []).length, close = (s.match(/}/g) || []).length;
    ok(open === close, `style #${i + 1} 花括号配对 { ${open} } ${close}`);
});

// ---- 3. 模拟执行 tokenSvg / tokenName ----
// 截取 TITLES 至 tokenSvg 定义段（升段检测注释前），独立执行
const start = html.indexOf('const TITLES = [');
const end = html.indexOf('// 升段检测');
ok(start > 0 && end > start, '令牌代码段定位成功');
const chunk = html.slice(start, end);
const sandbox = new Function(chunk + `;
    return { TITLES, TOKEN_NAMES, tokenName, tokenSvg };`);
const { TITLES, TOKEN_NAMES, tokenName, tokenSvg } = sandbox();

const EXPECT = ['青铜坚盾', '白银之翼', '黄金桂冠', '铂金圣环', '永恒钻石', '星耀辉光', '王者之冠', '无双双刃', '荣耀凤凰', '传奇星辰'];
ok(JSON.stringify(TOKEN_NAMES) === JSON.stringify(EXPECT), 'TOKEN_NAMES 与规格表一致');
let namesOk = true;
for (let i = 0; i < 10; i++) if (tokenName(i) !== EXPECT[i]) namesOk = false;
ok(namesOk, 'tokenName(0..9) 全部匹配');

let svgOk = true, nanOk = true, gradOk = true;
for (let i = 0; i < 10; i++) {
    for (const size of [30, 48, 60]) {
        const s = tokenSvg(i, size);
        if (!s.includes('<svg') || !s.includes('viewBox="0 0 64 64"')) svgOk = false;
        if (/undefined|NaN/.test(s)) nanOk = false;
        // 同一枚内渐变 id 不重复
        const ids = [...s.matchAll(/id="(tg\d+[abc])"/g)].map(m => m[1]);
        if (new Set(ids).size !== ids.length || ids.length !== 3) gradOk = false;
    }
}
ok(svgOk, 'tokenSvg(0..9) 均返回合法 <svg viewBox="0 0 64 64">');
ok(nanOk, 'tokenSvg 输出无 undefined / NaN');
ok(gradOk, '每枚令牌 3 个渐变 id（tg{n}a/b/c）且无重复');

// 渐变引用与定义一致
let refOk = true;
for (let i = 0; i < 10; i++) {
    const s = tokenSvg(i, 48);
    for (const suf of ['a', 'b', 'c']) if (!s.includes(`url(#tg${i}${suf})`)) refOk = false;
}
ok(refOk, '每枚令牌均实际引用其渐变定义');

// 主题形状差异抽查（各枚包含其标志性元素）
const marks = [
    [/V30 C52 42/, '0 盾形'], [/展开|C24 24|C40 24/, '1 双翼'],
    [/ellipse/g, '2 桂叶'], [/polygon points="32,9 52,20/, '3 六边形'],
    [/M20 18 H44 L52 29 L32 54/, '4 钻石'], [/points="32,16 35\.5,25\.1/, '5 大星'],
    [/M14 44 L12 22 L23 31 L32 14/, '6 王冠'], [/rotate\(38 32 28\)/, '7 双剑'],
    [/C38 16 44 20 44 32/, '8 火焰'], [/points="32,17 34\.8,24\.2/, '9 星辰']
];
marks.forEach(([re, label]) => ok(re.test(tokenSvg(parseInt(label), 48)), '造型标识 - ' + label));

// 模板接线抽查
ok(html.includes('v-html="tokenSvg(i, 30)"'), '段位之路节点已接入 tokenSvg');
ok(html.includes('v-html="tokenSvg(i, 60)"'), '收藏架已接入 tokenSvg');
ok(html.includes('🎟 段位令牌 · 收藏架'), '收藏架区块存在');
ok(/tokenSvg, tokenName,/.test(html), 'setup() 已导出 tokenSvg / tokenName');
ok(html.includes('获得专属令牌'), '升段通知文案已提及令牌');
ok(html.includes('token-shelf') && html.includes('token-cell') && html.includes('tok-ic'), '新 CSS 类已就位');

console.log(fail === 0 ? '\n== ALL PASS ==' : `\n== ${fail} FAILED ==`);
process.exit(fail === 0 ? 0 : 1);

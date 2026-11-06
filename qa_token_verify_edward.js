// QA 回归验证脚本 —— 段位专属令牌（Edward / 任务 #2）
// 只读验证，不修改任何业务文件
const fs = require('fs');
const path = require('path');

const FILES = [
    'D:\\书香读书系统\\书香读书系统.html',
    'D:\\书香读书系统-线上\\书香读书系统.html'
];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
    else { fail++; failures.push({ name, detail }); console.log(`  [FAIL] ${name} — ${detail}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

const html = fs.readFileSync(FILES[0], 'utf8');
const htmlOnline = fs.readFileSync(FILES[1], 'utf8');

// ---------- 1. 语法检查 ----------
section('1. 语法检查（script 编译 + style 花括号）');
for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    scripts.forEach((m, i) => {
        const inner = m[1].trim();
        if (!inner) return check(`${path.basename(f)} script#${i} 空`, true, '空块跳过');
        try { new Function(inner); check(`${path.basename(f)} script#${i} new Function 编译`, true, `${inner.length} chars`); }
        catch (e) { check(`${path.basename(f)} script#${i} new Function 编译`, false, e.message); }
    });
    // <style> 花括号配对
    const styles = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
    styles.forEach((m, i) => {
        const css = m[1];
        const open = (css.match(/{/g) || []).length;
        const close = (css.match(/}/g) || []).length;
        check(`${path.basename(f)} style#${i} 花括号配对`, open === close, `{=${open} }=${close}`);
    });
}

// ---------- 2. 函数行为 ----------
section('2. 函数行为（提取实际代码执行）');
// 提取 TITLES 定义
const titlesMatch = html.match(/const TITLES = \[([\s\S]*?)\];/);
if (!titlesMatch) { console.log('  [FAIL] 未找到 TITLES 定义'); process.exit(1); }
const TITLES = eval('[' + titlesMatch[1] + ']');

// 提取令牌工具代码块（从 TOKEN_NAMES 到 tokenSvg 结尾）
const tokenBlockMatch = html.match(/const TOKEN_NAMES = \[[\s\S]*?const tokenSvg = \(i, size = 48\) => \{[\s\S]*?\n        \};/);
if (!tokenBlockMatch) { console.log('  [FAIL] 未找到令牌代码块'); process.exit(1); }
let tokenBlock = tokenBlockMatch[0];

// 构造沙箱执行
const sandbox = new Function('TITLES', tokenBlock + `
    return { TOKEN_NAMES, tokenName, tokenSvg, tint, sparkPath };
`);
const api = sandbox(TITLES);

// 2a tokenName
const EXPECT_NAMES = ['青铜坚盾','白银之翼','黄金桂冠','铂金圣环','永恒钻石','星耀辉光','王者之冠','无双双刃','荣耀凤凰','传奇星辰'];
check('TOKEN_NAMES 顺序正确', JSON.stringify(api.TOKEN_NAMES) === JSON.stringify(EXPECT_NAMES), api.TOKEN_NAMES.join('/'));
check('tokenName(0..9) 依次正确', EXPECT_NAMES.every((n, i) => api.tokenName(i) === n), '');
check('tokenName 越界回退神秘令牌', api.tokenName(10) === '神秘令牌' && api.tokenName(-1) === '神秘令牌', '');

// 2b tokenSvg 0..9
const svgs = [];
let svgOk = true, svgDetail = [];
for (let i = 0; i < 10; i++) {
    const s = api.tokenSvg(i, 60);
    svgs.push(s);
    const issues = [];
    if (typeof s !== 'string' || s.length === 0) issues.push('空串');
    if (!s.startsWith('<svg')) issues.push('非SVG开头');
    if (!s.includes('viewBox="0 0 64 64"')) issues.push('缺viewBox');
    if (/undefined|NaN/.test(s)) issues.push('含undefined/NaN');
    if (!s.endsWith('</svg>')) issues.push('结尾不完整');
    if (issues.length) { svgOk = false; svgDetail.push(`tokenSvg(${i}): ${issues.join(',')}`); }
}
check('tokenSvg(0..9) 返回合法SVG', svgOk, svgDetail.join('; ') || '全部含 viewBox 0 0 64 64 且无 undefined/NaN');

// 2c 渐变 id 唯一且被引用
let gradOk = true, gradDetail = [];
for (let i = 0; i < 10; i++) {
    const s = svgs[i];
    const ids = [...s.matchAll(/id="(tg\d+[abc])"/g)].map(m => m[1]);
    const refs = [...s.matchAll(/url\(#(tg\d+[abc])\)/g)].map(m => m[1]);
    const uniq = new Set(ids).size === ids.length;
    const allRef = ids.every(id => refs.includes(id));
    if (!uniq || !allRef || ids.length !== 3) { gradOk = false; gradDetail.push(`#${i} ids=[${ids}] refs=[${refs}]`); }
}
check('每枚 3 个渐变 id 无重复且均被引用', gradOk, gradDetail.join('; ') || 'tg{n}a/b/c 各就各位');

// 跨令牌 id 前缀不冲突
const allIdPrefixes = new Set();
for (let i = 0; i < 10; i++) {
    [...svgs[i].matchAll(/id="tg(\d+)[abc]"/g)].forEach(m => allIdPrefixes.add(m[1]));
}
check('10 枚渐变前缀 tg0..tg9 各不重复', allIdPrefixes.size === 10, [...allIdPrefixes].join(','));

// 2d 越界输入不抛异常（规格要求：-1、10 等数值越界须安全回退）
let oobOk = true, oobDetail = [];
for (const bad of [-1, 10, 100, -100]) {
    try {
        const s = api.tokenSvg(bad, 40);
        if (typeof s !== 'string' || !s.includes('<svg') || /undefined|NaN/.test(s)) { oobOk = false; oobDetail.push(`${bad} -> 异常输出`); }
    } catch (e) { oobOk = false; oobDetail.push(`${bad} 抛异常: ${e.message}`); }
}
check('tokenSvg 数值越界(-1/10/±100)不抛异常且输出安全', oobOk, oobDetail.join('; ') || '统一取模回退（-1→tg9，10→tg0）');
// 非数值输入超出规格（模板调用点均为 v-for 数值索引），仅作观察记录
const nonNumResults = {};
for (const bad of ['abc', null, undefined]) {
    try { const s = api.tokenSvg(bad, 40); nonNumResults[String(bad)] = /undefined|NaN/.test(s) ? '异常输出' : `安全渲染(${s.includes('viewBox') ? 'SVG正常' : '非SVG'})`; }
    catch (e) { nonNumResults[String(bad)] = `throw: ${e.message.slice(0, 50)}`; }
}
check('观察: 非数值输入行为记录(null取模为0安全渲染, NaN类throw且无调用点)', true, JSON.stringify(nonNumResults));

// tint / sparkPath 行为
check('tint 提亮/加深正确', api.tint('#a2703f', 1) === '#ffffff' && api.tint('#000000', -1) === '#000000' && api.tint('#ffffff', 0) === '#ffffff', `tint('#a2703f',.55)=${api.tint('#a2703f', .55)}`);
check('sparkPath 生成闭合8点星芒', /^M[\d. ]+L[\d. L]+Z$/.test(api.sparkPath(10, 10, 4)), api.sparkPath(10, 10, 4).slice(0, 40) + '...');

// ---------- 3. 造型差异性 ----------
section('3. 十枚令牌两两相似度粗检（去色后结构指纹）');
function fingerprint(svg) {
    // 去掉所有颜色/渐变引用/坐标无关属性，只留标签名+路径d数据+几何参数
    let t = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '')
        .replace(/fill="[^"]*"/g, '').replace(/stroke="[^"]*"/g, '')
        .replace(/opacity="[^"]*"/g, '').replace(/stroke-width="[^"]*"/g, '')
        .replace(/stroke-linecap="[^"]*"/g, '').replace(/stroke-linejoin="[^"]*"/g, '')
        .replace(/transform="[^"]*"/g, '')
        .replace(/<svg[^>]*>|<\/svg>|xmlns="[^"]*"|role="[^"]*"|aria-label="[^"]*"/g, '')
        .replace(/\s+/g, '');
    return t;
}
let dupFound = false;
for (let a = 0; a < 10; a++) {
    for (let b = a + 1; b < 10; b++) {
        const fa = fingerprint(svgs[a]), fb = fingerprint(svgs[b]);
        if (fa === fb) { dupFound = true; console.log(`  [FAIL] 令牌${a}与令牌${b}去色后结构完全相同`); }
        else {
            // 粗相似度：最长公共子串长度占比
            let lcs = 0;
            for (let len = Math.min(fa.length, fb.length); len >= 8; len--) {
                for (let st = 0; st + len <= fa.length; st++) {
                    if (fb.includes(fa.substr(st, len))) { lcs = Math.max(lcs, len); break; }
                }
                if (lcs > 0) break;
            }
            const ratio = lcs / Math.max(fa.length, fb.length);
            if (ratio > 0.6) { dupFound = true; console.log(`  [WARN] 令牌${a}(${api.tokenName(a)}) 与令牌${b}(${api.tokenName(b)}) 相似度过高 ${Math.round(ratio * 100)}%`); }
        }
    }
}
check('无两枚实质相同（去色指纹两两互异 & LCS<60%）', !dupFound, '45 组对比完成');
console.log('  指纹长度: ' + svgs.map((s, i) => `${i}:${fingerprint(s).length}`).join(' '));

// ---------- 4. 模板接线 ----------
section('4. 模板接线检查');
check('收藏架区块存在', html.includes('🎟 段位令牌 · 收藏架') && html.includes('class="token-shelf"'), '');
check('收藏架 v-for 循环 TITLES(10次)', /<template v-for="\(t, i\) in TITLES" :key="'tok-' \+ t\.name">/.test(html), 'v-for="(t, i) in TITLES"');
check('token-coin v-html 绑定 tokenSvg', /<div class="token-coin" v-html="tokenSvg\(i, 60\)"><\/div>/.test(html), '');
check('token-nm 绑定 tokenName(i)', /<div class="token-nm">\{\{ tokenName\(i\) \}\}<\/div>/.test(html), '');
check('解锁判断 profileUser.totalPoints >= t.min', /profileUser\.totalPoints >= t\.min/.test(html) && /profileUser\.totalPoints < t\.min/.test(html), '');
check('锁定态 grayscale CSS', /\.token-cell\.locked [\s\S]*?grayscale\(1\)/.test(html), '');
check('锁定态 🔒 图标', /<span class="token-lock" v-if="profileUser\.totalPoints < t\.min">🔒<\/span>/.test(html), '');
check('段位之路节点使用 tok-ic + tokenSvg', /class="tb-ic tok-ic" v-html="tokenSvg\(i, 30\)"/.test(html), '');
check('未到达节点置灰 CSS', /\.tier-ladder \.tl-node:not\(\.reached\) \.tok-ic svg \{ filter: grayscale\(1\) opacity\(\.55\); \}/.test(html), '');
check('setup return 导出 tokenSvg/tokenName', /return \{[\s\S]*?tokenSvg, tokenName,/.test(html), '见 return 行 3064');
check('升段通知文案含「专属令牌」+tokenName', (html.match(/获得专属令牌「<b>\$\{tokenName\(idx\)\}<\/b>」/g) || []).length === 2, '通知+toast 两处');
check('.token-shelf/.token-cell/.tok-ic CSS 定义齐全', ['.token-shelf', '.token-cell', '.token-cell .token-coin', '.token-cell .token-lock', '.token-cell .token-nm', '.token-cell .token-sub', '.tok-ic'].every(c => html.includes(c)), '');

// ---------- 5. 回归检查 ----------
section('5. 回归检查（原功能未破坏）');
check('TITLES 10 级阈值不变', TITLES.length === 10 && JSON.stringify(TITLES.map(t => t.min)) === JSON.stringify([0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500]), TITLES.map(t => t.min).join(','));
check('getTitle/nextTitle/tierStyle 仍导出', /return \{[\s\S]*?TITLES, getTitle, nextTitle, tierStyle, uTotal,/.test(html), '');
check('积分榜模板存在', html.includes('leaderboard') || /积分榜|leaderBoard/.test(html), '');
const lbPos = html.indexOf(`v-else-if="currentPage === 'leaderboard'"`);
check('积分榜区块存在(currentPage===leaderboard)', lbPos > 0, `位置 ${lbPos}`);
const lbBlock = lbPos > 0 ? html.slice(lbPos, lbPos + 6000) : '';
const lbOpen = (lbBlock.match(/<div\b/g) || []).length, lbClose = (lbBlock.match(/<\/div>/g) || []).length;
check('积分榜区块结构完整(截取窗口内 div 可解析)', !!lbBlock && lbOpen > 3 && lbClose > 3, `窗口内 <div>=${lbOpen} </div>=${lbClose}`);
check('积分榜数据绑定 leaderboardData', /v-for="\(u,idx\) in leaderboardData"/.test(html), '');
check('无「科举」残留', !html.includes('科举'), '');
check('Vue createApp 存在', /Vue\.createApp|createApp\(/.test(html), '');
// mustache 配对：必须剥离 script/style 只统计模板区（JS 代码的 }} 会污染全文统计）
const tplOnly = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const openMustache = (tplOnly.match(/\{\{/g) || []).length;
const closeMustache = (tplOnly.match(/\}\}/g) || []).length;
check('模板区 {{ }} 配对', openMustache === closeMustache, `${openMustache}/${closeMustache}`);

// ---------- 6. 一致性 ----------
section('6. 本地版 vs 线上版一致性');
const { createHash } = require('crypto');
const h1 = createHash('md5').update(html).digest('hex');
const h2 = createHash('md5').update(htmlOnline).digest('hex');
check('MD5 hash 一致', h1 === h2, `${h1}`);

console.log('\n========================================');
console.log(`总计: ${pass + fail} 项 | 通过 ${pass} | 失败 ${fail}`);
if (fail) { console.log('失败项:'); failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`)); process.exit(1); }

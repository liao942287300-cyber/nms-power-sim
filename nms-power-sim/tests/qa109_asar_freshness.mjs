#!/usr/bin/env node
/**
 * tests/qa109_asar_freshness.mjs — 1.0.9 打包产物新鲜度证据（不依赖运行 exe）
 *
 * 目标：证明「打进 app.asar 的就是 1.0.9 源码」，而非只证明源目录是 1.0.9。
 *  1) 解出 asar 内 renderer/ 7 文件，与源码 nms-power-sim/ 做 sha256 对比；
 *  2) 与 nms-power-sim-desktop/renderer/ 做 sha256 对比 → 三者一致；
 *  3) 断言 1.0.9 特征串：engine 含 glow_floor/LIGHT_COLOR_KEYS；catalog 含 glow_floor/
 *     LIGHT_COLORS；app.js 含 is-marquee-ready；index.html hint 含「Alt+拖动元件复制一份」。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const RD = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop';
const SRC = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim';
const ASAR = `${RD}/dist/win-unpacked/resources/app.asar`;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (h) => String(h);

/* ---------- 解析 asar 头 ---------- */
const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonSize).toString('utf8'));
const dataStart = 8 + headerSize;
function resolveEntry(root, segs) {
  let node = root;
  for (const s of segs) { if (!node.files || !node.files[s]) return null; node = node.files[s]; }
  return node;
}
function asarFile(rel) {
  const e = resolveEntry(header, rel.split('/'));
  if (!e || e.offset === undefined) return null;
  const off = dataStart + Number(e.offset);
  return buf.slice(off, off + e.size);
}

console.log('asar 头解析: headerSize=' + headerSize + ' jsonSize=' + jsonSize + ' dataStart=' + dataStart);

/* ---------- 1/2. 三处 sha256 对比 ---------- */
const files = ['js/engine.js', 'js/board.js', 'js/app.js', 'js/catalog.js', 'js/presets.js', 'css/styles.css', 'index.html'];
let allMatch = true;
for (const rel of files) {
  const inAsar = asarFile('renderer/' + rel);
  const srcPath = `${SRC}/${rel}`;
  const rdPath = `${RD}/renderer/${rel}`;
  if (!inAsar) { allMatch = false; ok(`F ${rel} 存在于 asar`, false, 'asar 内缺失'); continue; }
  if (!existsSync(srcPath)) { allMatch = false; ok(`F ${rel} 源码存在`, false, srcPath); continue; }
  if (!existsSync(rdPath)) { allMatch = false; ok(`F ${rel} desktop/renderer 存在`, false, rdPath); continue; }
  const hA = sha(inAsar), hS = sha(readFileSync(srcPath)), hR = sha(readFileSync(rdPath));
  const trio = hA === hS && hA === hR;
  if (!trio) allMatch = false;
  ok(`F ${rel} asar==源码==renderer/${rel}`, trio, `asar=${short(hA)} src=${short(hS)} rd=${short(hR)}`);
}
if (allMatch) ok('F1 asar 内 renderer 全部 7 文件 = 源码 = desktop/renderer（三方 sha256 一致）', true, files.join(','));

/* ---------- 3. 1.0.9 特征串 ---------- */
const eng = asarFile('renderer/js/engine.js').toString('utf8');
const cat = asarFile('renderer/js/catalog.js').toString('utf8');
const app = asarFile('renderer/js/app.js').toString('utf8');
const html = asarFile('renderer/index.html').toString('utf8');

ok('S1 asar engine.js 含 glow_floor', eng.includes('glow_floor'));
ok('S2 asar engine.js 含 LIGHT_COLOR_KEYS', eng.includes('LIGHT_COLOR_KEYS'));
ok('S2b asar engine.js SINK_TYPES 含 glow_floor', /SINK_TYPES\s*=\s*\[[^\]]*'glow_floor'[^\]]*\]/.test(eng));
ok('S3 asar catalog.js 含 glow_floor', cat.includes('glow_floor'));
ok('S3b asar catalog.js 含 LIGHT_COLORS', cat.includes('LIGHT_COLORS'));
ok('S4 asar app.js 含 is-marquee-ready', app.includes('is-marquee-ready'));
ok('S5 asar index.html hint 含「Alt+拖动元件复制一份」', html.includes('Alt+拖动元件复制一份'));
ok('S5b asar index.html hint 含「Ctrl+拖动框选元件」', html.includes('Ctrl+拖动框选元件'));
ok('S5c asar index.html hint 含「空白处拖动平移画布」', html.includes('空白处拖动平移画布'));
ok('S6 asar app.js 已无 colorHistSig（1.0.9 移除）', !app.includes('colorHistSig'));

/* main.js / package.json 版本 */
try {
  const mainJs = asarFile('main.js').toString('utf8');
  ok('V main.js APP_VERSION=1.0.9', mainJs.includes("APP_VERSION = '1.0.9'") || mainJs.includes('APP_VERSION = "1.0.9"'));
} catch (e) { ok('V main.js APP_VERSION=1.0.9', false, e.message); }
try {
  const pkg = JSON.parse(asarFile('package.json').toString('utf8'));
  ok('V2 package.json version=1.0.9', pkg.version === '1.0.9', 'ver=' + pkg.version);
} catch (e) { ok('V2 package.json version=1.0.9', false, e.message); }

console.log(`\n===== 结果 =====\n通过 ${R.pass} / 失败 ${R.fail}`);
console.log(R.fail === 0 ? 'QA109_ASAR_FRESHNESS_PASS' : 'QA109_ASAR_FRESHNESS_FAILED');
if (R.fail) console.log('FAILURES:\n' + R.failures.join('\n'));
process.exit(R.fail === 0 ? 0 : 1);

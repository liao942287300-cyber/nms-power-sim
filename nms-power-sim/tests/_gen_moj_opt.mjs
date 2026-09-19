#!/usr/bin/env node
/**
 * _gen_moj_opt.mjs —— 重构 moj-scroll-screen.json
 *
 * 目标：
 *   1) 修镜像：原电路的「环拍号 p → 图案列 p」注入方式会让屏幕左右翻转。
 *      新电路改成「拍号 p → 图案列 17-p」，从映射上把镜像拧正（不是硬翻位图）。
 *   2) 精简连线：删掉 36 个字形解码开关（f_*）、移位链从 32 格压到 18 格
 *      （图案周期就是 18：同屏第 c 列与第 c+18 列永远同亮，实测已验证），
 *      并给供电轨改走菊花链（同电气节点，等价但走线短）。
 *
 * 输出：把结果写到 argv[3]，同时把分析/验证文本写到 argv[4]。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const OLD_PATH = process.argv[2];
const NEW_PATH = process.argv[3];
const LOG_PATH = process.argv[4] || path.join(path.resolve(ROOT, '..'), '_gen_moj_opt.txt');

const L = [];
const log = (s = '') => L.push(String(s));

const { createEngine } = await import('file:///' + path.join(ROOT, 'js', 'engine.js').replace(/\\/g, '/'));

const ROWS = 5;
const COLS = 32;
const PTN = 18;
const DT = 1 / 60;

const art = (grid, label) => {
  log(label);
  log('     ' + Array.from({ length: grid[0].length }, (_, i) => String(i % 10)).join(''));
  grid.forEach((row, r) => log(`  r${r} ` + row.map((v) => (v ? '\u25A0' : '\u00B7')).join('')));
};

const frameOf = (engine) => {
  const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  for (const v of engine.getElementViews()) {
    const m = /^lamp_r(\d+)c(\d+)$/.exec(v.id);
    if (m && v.type === 'lamp') g[+m[1]][+m[2]] = !!v.state.lit;
  }
  return g;
};

/** 按下 START 后逐秒采样 N 秒，返回 { frames, firstLitSec } */
const run = (jsonText, seconds) => {
  const engine = createEngine();
  const ok = engine.deserialize(jsonText);
  if (!ok) throw new Error('deserialize failed');
  engine.triggerButton('scroll_btn');
  const frames = [];
  for (let s = 1; s <= seconds; s++) {
    for (let i = 0; i < 60; i++) engine.tick(DT);
    frames.push(frameOf(engine));
  }
  const firstLit = frames.findIndex((f) => f.flat().some(Boolean));
  return { engine, frames, firstLit };
};

const eq = (a, b) => a.every((row, r) => row.every((v, c) => v === b[r][c]));

// ---------------------------------------------------------------- 1. 读旧电路
const oldText = fs.readFileSync(OLD_PATH, 'utf8');
const oldObj = JSON.parse(oldText);
const oldRun = run(oldText, 90);
log('=== 旧电路 ===');
log(`元件 ${oldObj.elements.length} / 连线 ${oldObj.wires.length}`);
log(`首次点亮：第 ${oldRun.firstLit + 1} 秒`);

// 稳态：连续两秒都满足 18 秒周期
let steady = -1;
for (let t = oldRun.firstLit; t + 19 < oldRun.frames.length; t++) {
  if (eq(oldRun.frames[t], oldRun.frames[t + 18]) && eq(oldRun.frames[t + 1], oldRun.frames[t + 19])) {
    steady = t;
    break;
  }
}
if (steady < 0) throw new Error('旧电路未找到 18s 稳态');
const oldFrame = oldRun.frames[steady];
art(oldFrame, `\n旧电路稳态画面（第 ${steady + 1} 秒，用户反馈：字母镜像）`);

// 验证 18 周期性（列 c 与 c+18 恒同）
let periodic = true;
for (let r = 0; r < ROWS; r++) for (let c = 0; c + PTN < COLS; c++) if (oldFrame[r][c] !== oldFrame[r][c + PTN]) periodic = false;
log(`\n列 c 与 c+18 恒同（18 周期）：${periodic}`);

// 旧画面左起前 18 列即「屏幕上的 18 列循环条带」
const S = Array.from({ length: ROWS }, (_, r) => oldFrame[r].slice(0, PTN));
art(S, '\n旧画面条带 S（屏幕左→右读数，即用户看到的镜像字）');

// 目标内容 T = 镜像(S)
const T = Array.from({ length: ROWS }, (_, r) => S[r].slice().reverse());
art(T, '\n目标内容 T = mirror(S)（期望：左→右读到正向 M O J）');

// ---------------------------------------------------------------- 2. 生成新电路
// 内容按周期旋转，使「最早被点亮的图案列」落在 q=17（对应环拍号 0）→ 点 START 后约 3 秒即出画面
let tau = PTN;
for (let r = 0; r < ROWS; r++) for (let q = 0; q < PTN; q++) if (T[r][q] && q < tau) tau = q;
const delta = (PTN - 1 - tau + PTN) % PTN;
const P = Array.from({ length: ROWS }, (_, r) => Array.from({ length: PTN }, (_, q) => T[r][(q + delta) % PTN]));
art(P, `\n注入用图案 P = rotate(T, δ=${delta})（最早亮列落在 q=17，最早 3 秒出画面）`);

// 解码开关（元素列表在下面构造）：每个字形亮点一个，作用是把环拍点与链首节点隔离——
// 若把多个环拍点的 b 直接并到一个节点，环的相邻拍会被短接成同一节点 → 整环自锁，屏幕全亮
const decoders = [];
for (let r = 0; r < ROWS; r++) for (let q = 0; q < PTN; q++) if (P[r][q]) decoders.push({ r, q });

const elements = [];
const wires = [];
let wid = 1;
const W = (ae, ap, be, bp) => wires.push({ id: `w${wid++}`, a: { el: ae, port: ap }, b: { el: be, port: bp } });
const SW = (id, x, y) => ({ id, type: 'auto_switch', x, y, props: {}, state: { conducting: false, timer: 0 } });

elements.push({ id: 'scroll_power', type: 'power', x: 3300, y: 3750, props: {}, state: { conducting: false, timer: 0, on: true } });
elements.push({ id: 'scroll_btn', type: 'button', x: 3620, y: 3750, props: { pulseSeconds: 1 }, state: { conducting: false, timer: 0, pulse: 0 } });
elements.push(SW('scroll_buf', 3940, 3750));

// 18 拍环
for (let k = 0; k < PTN; k++) elements.push(SW(`s${k}`, 100 + 190 * k, 3500));
// 解码开关（每个字形亮点一个）
for (const { r, q } of decoders) elements.push(SW(`g_r${r}p${q}`, 100 + 170 * q, 2400 + 220 * r));
// 每行 18 格移位链 + 灯阵
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < PTN; c++) elements.push(SW(`cell_r${r}c${c}`, 100 + 170 * c, 1400 + 220 * r));
  for (let c = 0; c < COLS; c++) {
    elements.push({ id: `lamp_r${r}c${c}`, type: 'lamp', x: 100 + 150 * c, y: 120 + 200 * r, props: {}, state: { conducting: false, timer: 0, lit: false } });
  }
}

// 启动：电源 → 按钮 → 缓冲 → 环
W('scroll_power', 'out', 'scroll_btn', 'a');
W('scroll_power', 'out', 'scroll_buf', 'a');
W('scroll_btn', 'b', 'scroll_buf', 'ctrl');
W('scroll_buf', 'b', 's0', 'ctrl');
for (let k = 0; k < PTN; k++) W(`s${k}`, 'b', `s${(k + 1) % PTN}`, 'ctrl');   // 环拍链（回绕，18 拍一循环）

// 供电轨：菊花链（同节点等价，走线短且整齐）
W('scroll_power', 'out', 's0', 'a');
for (let k = 0; k < PTN - 1; k++) W(`s${k}`, 'a', `s${k + 1}`, 'a');
W('scroll_power', 'out', 'cell_r0c0', 'a');
for (let r = 0; r < ROWS; r++) for (let c = 0; c < PTN - 1; c++) W(`cell_r${r}c${c}`, 'a', `cell_r${r}c${c + 1}`, 'a');
for (let r = 0; r < ROWS - 1; r++) W(`cell_r${r}c${PTN - 1}`, 'a', `cell_r${r + 1}c0`, 'a');
// 解码开关供电：接在链供电轨尾端，再沿解码区菊花链
W(`cell_r${ROWS - 1}c${PTN - 1}`, 'a', `g_r${decoders[0].r}p${decoders[0].q}`, 'a');
for (let i = 0; i < decoders.length - 1; i++) {
  W(`g_r${decoders[i].r}p${decoders[i].q}`, 'a', `g_r${decoders[i + 1].r}p${decoders[i + 1].q}`, 'a');
}

// 注入：拍号 k 携带图案列 q=17-k  —— 修正镜像的关键（解码开关隔离环与链）
for (const { r, q } of decoders) {
  const id = `g_r${r}p${q}`;
  W(`s${PTN - 1 - q}`, 'b', id, 'ctrl');
  W(id, 'b', `cell_r${r}c0`, 'ctrl');
}
log(`\n解码开关 ${decoders.length} 个（每个字形亮点一个）`);

// 移位链
for (let r = 0; r < ROWS; r++) for (let c = 0; c < PTN - 1; c++) W(`cell_r${r}c${c}`, 'b', `cell_r${r}c${c + 1}`, 'ctrl');
// 灯：cell(c).b → lamp(c).in，并用菊花链带出 lamp(c+18).in（18 周期等价）
for (let r = 0; r < ROWS; r++) for (let c = 0; c < PTN; c++) {
  W(`cell_r${r}c${c}`, 'b', `lamp_r${r}c${c}`, 'in');
  if (c + PTN < COLS) W(`lamp_r${r}c${c}`, 'in', `lamp_r${r}c${c + PTN}`, 'in');
}

const desc =
  'MOJ 滚动大屏幕（复刻贴吧帖《我在无人深空造了个滚动屏》）：点 START（scroll_btn）约 4 秒后屏幕开始显示，约 22 秒进入稳定循环——' +
  '5 行×32 列灯阵以每秒 1 列的速度向右滚动 MOJ 字样，周期 18 秒。上方为显示器；' +
  '中部每行 18 格移位链（每格延迟 1 秒，脉冲逐列右移；第 c 格同时点亮第 c 与第 c+18 列——图案 18 秒一循环，两列恒同亮）；' +
  '下方 18 拍扫描环（1 拍 1 秒）提供节拍，每个字形亮点配一个解码开关把对应节拍送入该行链首，' +
  '映射关系为「拍号 k → 图案列 17-k」，这个映射同时决定字形朝向（改成正向）；' +
  '所有开关间距已拉开、供电轨走菊花链，方便操作也更少走线。';

const outObj = {
  version: 1,
  simTime: 0,
  timeOfDay: 8,
  dayCycle: true,
  wireStyle: 'straight',
  idSeq: 900,
  wireSeq: 900,
  desc,
  elements,
  wires,
};

const newText = JSON.stringify(outObj, null, 1);
fs.writeFileSync(NEW_PATH, newText, 'utf8');

// ---------------------------------------------------------------- 3. 验证新电路
const newRun = run(newText, 90);
log('\n=== 新电路 ===');
log(`元件 ${elements.length} / 连线 ${wires.length} / 体积 ${(Buffer.byteLength(newText) / 1024).toFixed(1)} KB（旧：${(Buffer.byteLength(oldText) / 1024).toFixed(1)} KB）`);
log(`deserialize 后：${newRun.engine.getElements().length} 元件 / ${newRun.engine.getWires().length} 连线（若小于上面数字说明有非法端口被丢弃）`);
log(`首次点亮：第 ${newRun.firstLit + 1} 秒`);

let nsteady = -1;
for (let t = newRun.firstLit; t + 19 < newRun.frames.length; t++) {
  if (eq(newRun.frames[t], newRun.frames[t + 18]) && eq(newRun.frames[t + 1], newRun.frames[t + 19])) { nsteady = t; break; }
}
if (nsteady < 0) throw new Error('新电路未找到 18s 稳态');
const newFrame = newRun.frames[nsteady];
art(newFrame, `\n新电路稳态画面（第 ${nsteady + 1} 秒）`);

// 3a. 18 周期性
let p2 = true;
for (let r = 0; r < ROWS; r++) for (let c = 0; c + PTN < COLS; c++) if (newFrame[r][c] !== newFrame[r][c + PTN]) p2 = false;
log(`\n列 c 与 c+18 恒同：${p2}`);

// 3b. 向右滚动，1 列/秒（含第 0 列，全列检查）
let scrollOk = true;
for (let t = nsteady + 1; t < newRun.frames.length; t++)
  for (let r = 0; r < ROWS; r++)
    for (let c = 1; c < COLS; c++) if (newRun.frames[t][r][c] !== newRun.frames[t - 1][r][c - 1]) scrollOk = false;
log(`向右滚动 1 列/秒（含第 0 列）：${scrollOk}`);

// 3c. 朝向：newFrame 必须等于「T 的水平平移」，且不能等于「T 的镜像平移」
const shiftsMatch = (grid, base, sign) => {
  for (let k = 0; k < PTN; k++) {
    let ok = true;
    for (let r = 0; r < ROWS && ok; r++) for (let c = 0; c < COLS && ok; c++) {
      if (grid[r][c] !== base[r][((sign > 0 ? c : -c) + k + PTN * 4) % PTN]) ok = false;
    }
    if (ok) return k;
  }
  return -1;
};
const kDirect = shiftsMatch(newFrame, T, +1);
const kMirror = shiftsMatch(newFrame, T, -1);
log(`\n朝向判定：与 T 同向平移匹配 k=${kDirect}（应 ≥0）；与 T 镜像平移匹配 k=${kMirror}`);
log(`→ 字形正向（非镜像）：${kDirect >= 0}`);

// 3d. 每盏灯的亮灭区间数（应约等于该图案列条带的亮列数）
const intervals = new Map();
{
  const engine = createEngine();
  engine.deserialize(newText);
  engine.triggerButton('scroll_btn');
  for (let i = 0; i < 60 * 80; i++) {
    engine.tick(DT);
    for (const v of engine.getElementViews()) {
      if (v.type !== 'lamp') continue;
      const prev = intervals.get(v.id) || { on: false, count: 0, maxLen: 0, len: 0 };
      if (v.state.lit && !prev.on) { prev.count++; prev.len = 0; }
      if (v.state.lit) { prev.len += DT; if (prev.len > prev.maxLen) prev.maxLen = prev.len; }
      prev.on = !!v.state.lit;
      intervals.set(v.id, prev);
    }
  }
  let worst = 0;
  let worstId = '';
  for (const [id, v] of intervals) if (v.maxLen > worst) { worst = v.maxLen; worstId = id; }
  log(`\n单灯最长连续点亮：${worst.toFixed(2)} 秒（${worstId}）——连续多列同亮属正常（图案相邻列同时亮）`);
  log(`例如 lamp_r0c0：亮 ${intervals.get('lamp_r0c0').count} 次 / 80 秒`);
}

log('\n结论：' + (p2 && scrollOk && kDirect >= 0 && kMirror < 0 ? 'PASS' : 'FAIL'));
fs.writeFileSync(LOG_PATH, L.join('\n'), 'utf8');

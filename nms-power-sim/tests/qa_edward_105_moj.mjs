#!/usr/bin/env node
/**
 * tests/qa_edward_105_moj.mjs — QA Edward 1.0.5 大电路功能专项（MOJ 滚动屏）
 * 纯 Node 侧（engine.js 零 DOM 依赖，确定性复现，无浏览器时序噪声）。
 *
 * 验证 moj-scroll-screen.json（376 元件 / 620 导线，5 行 × 32 列灯阵）：
 *   M1 规模与网格：160 灯 = 5 行 × 32 列，id 规整 lamp_r{r}c{c}。
 *   M2 启动语义：START 前全灭；触发 scroll_btn 后数秒内屏幕点亮。
 *   M3 滚动方向与速率：稳定后灯阵内容以 1 列/秒 向右滚动
 *      （lit(c, t+1) === lit(c-1, t)，c ≥ 1，连续 ≥30 秒逐秒核对）。
 *   M4 周期：lit(c, t+18) === lit(c, t)（18 拍扫描环 → 18 秒周期）。
 *   M5 非平凡性：模板既有亮列也有灭列，且画面随时间变化（非静止/非全亮）。
 *   M6 字形：输出稳定循环 18 列模板的 ASCII 图样（5 行 × 18 列），
 *      供人工核对 MOJ 字样（自动断言模板与逐帧观测一致）。
 *
 * 用法：node tests/qa_edward_105_moj.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const JSON_PATH = path.join(WORKSPACE, 'moj-scroll-screen.json');

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}

const ROWS = 5, COLS = 32;
const DT = 1 / 60;
const SAMPLE_TOTAL_S = 100;   // 模拟 100 秒（覆盖启动 ~4s + 稳定循环多轮）

const main = async () => {
  const { createEngine } = await import('file:///' + path.join(PROJECT_ROOT, 'js', 'engine.js').replace(/\\/g, '/'));
  const engine = createEngine();
  const data = fs.readFileSync(JSON_PATH, 'utf8');
  ok('M0 大电路 JSON 导入成功', engine.deserialize(data) === true,
    `${engine.getElements().length} 元件 / ${engine.getWires().length} 导线`);
  ok('M0a 规模符合（376 元件 / 620 导线）',
    engine.getElements().length === 376 && engine.getWires().length === 620);

  /* ---- M1 网格与 id 规整 ---- */
  const lamps = engine.getElements().filter((e) => e.type === 'lamp');
  ok('M1 灯数 = 160（5 行 × 32 列）', lamps.length === ROWS * COLS, `实际 ${lamps.length}`);
  let idOk = true, posOk = true;
  for (const l of lamps) {
    const m = /^lamp_r(\d+)c(\d+)$/.exec(l.id);
    if (!m) { idOk = false; continue; }
    const r = +m[1], c = +m[2];
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) idOk = false;
    // 位置核对：x = 100 + 48*c，y = 120 + 62*r
    if (l.x !== 100 + 48 * c || l.y !== 120 + 62 * r) posOk = false;
  }
  ok('M1a 灯 id 规整（lamp_r{0-4}c{0-31} 且互不重复）', idOk && new Set(lamps.map((l) => l.id)).size === ROWS * COLS);
  ok('M1b 灯位与网格坐标一致（x=100+48c, y=120+62r）', posOk);

  const lit = () => {
    // 返回 5×32 布尔阵
    const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    for (const v of engine.getElementViews()) {
      if (v.type !== 'lamp') continue;
      const m = /^lamp_r(\d+)c(\d+)$/.exec(v.id);
      if (m) grid[+m[1]][+m[2]] = !!v.state.lit;
    }
    return grid;
  };

  /* ---- M2 启动语义 ---- */
  const g0 = lit();
  const litCount = (g) => g.flat().filter(Boolean).length;
  ok('M2 START 前全灭', litCount(g0) === 0, `亮灯 ${litCount(g0)}`);

  const btn = engine.getElements().find((e) => e.type === 'button');
  ok('M2a 存在唯一 START 按钮（scroll_btn）', !!btn && btn.id === 'scroll_btn', btn ? btn.id : '未找到');
  const trig = engine.triggerButton('scroll_btn');
  ok('M2b triggerButton(scroll_btn) 生效', trig === true);

  // 逐秒推进并采样
  const samples = []; // samples[s] = grid（第 s 秒末）
  for (let s = 1; s <= SAMPLE_TOTAL_S; s++) {
    for (let i = 0; i < 60; i++) engine.tick(DT);
    samples.push(lit());
  }
  const firstLitS = samples.findIndex((g) => litCount(g) > 0) + 1;
  ok('M2c 触发后 ≤15s 内屏幕点亮（点 START 约数秒后开始显示）',
    firstLitS >= 1 && firstLitS <= 15, `首次点亮于第 ${firstLitS} 秒`);

  /* ---- M3/M4：滚动方向 + 稳态起点 + 周期 ----
   * 语义（经逐秒诊断确认）：
   *  · 滚动右移 lit(c,t)==lit(c-1,t-1) 自点亮后即成立（含进入期，左侧补空白流）；
   *  · 稳态 = 整幅 32 列窗口均为 18 周期流（首个稳态秒 s：pattern(s)==pattern(s+18)）；
   *  · 稳态内 18 秒周期逐秒成立。
   */
  const gridEq = (a, b) => a.every((row, r) => row.every((v, c) => v === b[r][c]));
  const scrollOkAt = (t) => {
    // lit(c, t) === lit(c-1, t-1)，c ≥ 1（内容右移：本秒第 c 列 = 上秒第 c-1 列）
    for (let r = 0; r < ROWS; r++)
      for (let c = 1; c < COLS; c++)
        if (samples[t][r][c] !== samples[t - 1][r][c - 1]) return false;
    return true;
  };
  const firstLitIdx = samples.findIndex((g) => litCount(g) > 0); // 0-based
  ok('M3 点亮后滚动右移 1 列/秒 持续成立（≥40 秒逐秒核对）',
    (() => {
      for (let t = firstLitIdx + 1; t + 40 <= SAMPLE_TOTAL_S; t++) {
        let good = true;
        for (let k = t; k < t + 40; k++) if (!scrollOkAt(k)) { good = false; break; }
        if (good) return true;
      }
      return false;
    })(), `首次点亮于第 ${firstLitIdx + 1} 秒，其后滚动性连续成立`);

  // 稳态起点：最小 s 使 pattern(s)==pattern(s+18) 连续 3 秒成立（流内容已充满整幅窗口）
  let steady = -1;
  for (let t = firstLitIdx; t + 21 <= SAMPLE_TOTAL_S; t++) {
    if (gridEq(samples[t], samples[t + 18]) && gridEq(samples[t + 1], samples[t + 19]) && gridEq(samples[t + 2], samples[t + 20])) { steady = t; break; }
  }
  ok('M4 存在稳态：整幅画面成为 18 秒周期流', steady >= 0, steady >= 0 ? `自第 ${steady + 1} 秒起稳态` : '未找到稳态');
  if (steady >= 0) {
    ok('M4a 稳态起点 ≤ 40 秒（规格：点 START 后约 38 秒进入稳定循环）',
      steady + 1 <= 40, `稳态起点=${steady + 1}s`);
    let periodAllOk = true;
    for (let k = steady + 18; k < Math.min(steady + 48, SAMPLE_TOTAL_S); k++)
      if (!gridEq(samples[k], samples[k - 18])) { periodAllOk = false; break; }
    ok('M4b 稳态内 18 秒周期逐秒成立（≥30 秒窗口）', periodAllOk);
  }

  if (steady >= 0) {
    const t0 = steady;
    // 模板：稳定窗口内逐秒进入最左列(c=0)的内容 → 18 列
    const template = Array.from({ length: ROWS }, () => new Array(18).fill(false));
    let consistent = true;
    for (let k = 0; k < 18; k++) {
      const g = samples[t0 + k];
      for (let r = 0; r < ROWS; r++) template[r][k] = g[r][0];
    }
    // 交叉验证：画面第 (t0+k) 秒第 c 列 应等于 第 (t0+k-c) 秒第 0 列（且模板 18 周期一致）
    for (let k = 0; k < 18 && consistent; k++)
      for (let c = 0; c < COLS && consistent; c++) {
        const back = t0 + k - c;
        if (back >= 0) {
          for (let r = 0; r < ROWS; r++)
            if (samples[back][r][0] !== samples[t0 + k][r][c]) { consistent = false; break; }
        }
      }
    ok('M5 模板与整幅滚动画面逐格一致（18 秒 × 32 列交叉核对）', consistent);

    const tCols = template.flat().filter(Boolean).length;
    ok('M5a 模板非空（有亮列）', tCols > 0, `模板亮格 ${tCols}/90`);
    ok('M5b 模板非全亮', tCols < ROWS * 18);
    let changed = false;
    for (let k = 1; k < 18; k++)
      if (!gridEq(samples[t0 + k], samples[t0 + k - 1])) { changed = true; break; }
    ok('M5c 画面随时间变化（非静止）', changed);

    // ASCII 图样（■=亮 ·=灭），列 0..17；3 列一组便于读字
    console.log('  ---- 稳定循环模板（5 行 × 18 列，■=亮） ----');
    for (let r = 0; r < ROWS; r++) {
      const line = template[r].map((v) => (v ? '\u25A0' : '\u00B7')).join('');
      console.log('  r' + r + ' ' + line);
    }
    console.log('  ----------------------------------------');
  }
};

main().then(() => {
  console.log(`\n===== 结果 =====`);
  console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
  if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
  console.log(R.fail === 0 ? 'QA_105_MOJ_PASS' : 'QA_105_MOJ_FAILED');
  process.exit(R.fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('MOJ_VERIFY_ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});

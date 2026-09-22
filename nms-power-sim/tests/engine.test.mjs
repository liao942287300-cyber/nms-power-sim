#!/usr/bin/env node
/**
 * tests/engine.test.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 · 纯内核独立回归套件
 *
 * 作者：QA 严过关。期望值依据《需求原文》与内核设计**独立推导**，
 * 未参考工程师自测脚本或报告中的任何数字。
 *
 * 运行： node tests/engine.test.mjs
 * 通过： exit 0；有失败： exit 1
 * ---------------------------------------------------------------------------
 */
import {
  createEngine, FIXED_DT, MAX_STEPS, DELAY_SECONDS, TYPE_PORTS, nodeKey,
  DAY_LENGTH_SECONDS, DAY_START_HOUR, DAY_END_HOUR, SOURCE_TYPES,
} from '../js/engine.js';
import { PRESETS, PRESET_BY_ID, loadPreset } from '../js/presets.js';

const results = { pass: 0, fail: 0, failures: [], notes: [] };

function check(name, cond, detail = '') {
  if (cond) results.pass++;
  else {
    results.fail++;
    results.failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
  }
  return !!cond;
}
function near(name, val, expect, tol, extra = '') {
  const ok = Number.isFinite(val) && Math.abs(val - expect) <= tol;
  return check(
    name,
    ok,
    `实测 ${Number.isFinite(val) ? val.toFixed(4) : val}，期望 ${expect}±${tol}${extra ? ' (' + extra + ')' : ''}`,
  );
}
function note(s) { results.notes.push(s); }

function ticks(e, seconds, dt = FIXED_DT) {
  const n = Math.max(0, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) e.tick(dt);
}

/** 连续采样某观测量，返回 [{t, v}]。 */
function series(e, seconds, dt, fn) {
  const n = Math.max(0, Math.round(seconds / dt));
  const out = [];
  for (let i = 0; i < n; i++) {
    e.tick(dt);
    out.push({ t: e.getSimTime(), v: fn(e) });
  }
  return out;
}

function risingEdges(arr) {
  const t = [];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].v && !arr[i - 1].v) t.push(arr[i].t);
  }
  return t;
}

/** 语义延迟：从「ctrl 首次通电」到「输出首次变化」的真实时长。 */
function semanticDelay(e, dt, ctrlOn, outOn, maxSec = 8) {
  const n = Math.ceil(maxSec / dt);
  let tCtrl = null;
  for (let i = 0; i < n; i++) {
    e.tick(dt);
    if (tCtrl === null && ctrlOn(e)) tCtrl = e.getSimTime();
    if (tCtrl !== null && outOn(e)) return e.getSimTime() - tCtrl;
  }
  return Infinity;
}

const lit = (e, id) => e.getElementView(id).lit === true;
const cond = (e, id) => e.getElementView(id).conducting === true;

/* =========================================================================
 * 1. 并查集传播
 * ========================================================================= */
function section1() {
  // 1.1 直连
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'l', 'in');
    e.tick(FIXED_DT);
    check('1.1 直连电源→灯：灯亮', lit(e, 'l'));
    check('1.1 直连：灯 in 端通电', e.getNodePowered('l', 'in'));
  }
  // 1.2 多跳（经墙开）
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('wall_switch', { id: 'w' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('w', 'b', 'l', 'in');
    ticks(e, 0.5);
    check('1.2 多跳：墙开断开时灯灭', !lit(e, 'l'));
    check('1.2 多跳：墙开断开时 b 端不通电', !e.getNodePowered('w', 'b'));
    e.setWallSwitch('w', true);
    e.tick(FIXED_DT);
    check('1.2 多跳：墙开接通后灯亮', lit(e, 'l'));
    check('1.2 多跳：接通后 b 端通电', e.getNodePowered('w', 'b'));
  }
  // 1.3 分叉（一个电源口带 3 盏灯）
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    for (const id of ['l1', 'l2', 'l3']) e.addElement('lamp', { id });
    e.addWire('p', 'out', 'l1', 'in');
    e.addWire('p', 'out', 'l2', 'in');
    e.addWire('p', 'out', 'l3', 'in');
    ticks(e, 0.5);
    check('1.3 分叉：三盏灯全亮', lit(e, 'l1') && lit(e, 'l2') && lit(e, 'l3'));
  }
  // 1.4 同一端口接多根线
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('wall_switch', { id: 'w' });
    e.addElement('lamp', { id: 'la' });
    e.addElement('lamp', { id: 'lb' });
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('p', 'out', 'la', 'in');           // power.out 接第二根线
    e.setWallSwitch('w', true);
    e.addWire('w', 'b', 'lb', 'in');
    // 再在同一个 w.b 上接第三根线
    e.addElement('lamp', { id: 'lc' });
    e.addWire('w', 'b', 'lc', 'in');
    ticks(e, 0.5);
    check('1.4 同端口多线：三盏灯全亮', lit(e, 'la') && lit(e, 'lb') && lit(e, 'lc'));
  }
  // 1.5 悬空端口 / 未接线元件不通电
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('lamp', { id: 'lonely' });
    e.addElement('wall_switch', { id: 'w2' });
    e.addWire('p', 'out', 'w2', 'a'); // w2.b 悬空
    ticks(e, 0.5);
    check('1.5 未接线灯不亮', !lit(e, 'lonely'));
    check('1.5 悬空端口不通电', !e.getNodePowered('lonely', 'in'));
    check('1.5 悬空 b 端不通电', !e.getNodePowered('w2', 'b'));
    check('1.5 电源自身 out 端通电', e.getNodePowered('p', 'out'));
  }
  // 1.6 两个互相隔离的电源网络
  {
    const e = createEngine();
    e.addElement('power', { id: 'p1' });
    e.addElement('power', { id: 'p2' });
    e.addElement('lamp', { id: 'l1' });
    e.addElement('lamp', { id: 'l2' });
    e.addWire('p1', 'out', 'l1', 'in');
    // l2 未接
    ticks(e, 0.5);
    check('1.6 隔离网络：仅被接的灯亮', lit(e, 'l1') && !lit(e, 'l2'));
  }
}

/* =========================================================================
 * 2. 自动开关（延迟 1 秒跟随）
 * ========================================================================= */
function makeAutoRig() {
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('wall_switch', { id: 'w' });
  e.addElement('auto_switch', { id: 'a' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('p', 'out', 'w', 'a');   // 电源 → 墙开
  e.addWire('p', 'out', 'a', 'a');   // 电源母线 → 自动开关输入 a
  e.addWire('w', 'b', 'a', 'ctrl');  // 墙开 → ctrl
  e.addWire('a', 'b', 'l', 'in');    // 输出 → 灯
  return e;
}
function section2() {
  // 2.1 上升沿
  {
    const e = makeAutoRig();
    ticks(e, 2, FIXED_DT);
    check('2.1 初始：ctrl 未通电，输出切断，灯灭', !cond(e, 'a') && !lit(e, 'l'));
    e.setWallSwitch('w', true);
    const d = semanticDelay(e, FIXED_DT, (x) => x.getNodePowered('a', 'ctrl'), (x) => cond(x, 'a'));
    near('2.1 自动开关上升沿延迟', d, DELAY_SECONDS, 0.15);
    note(`[2.1] 自动开关上升沿语义延迟 = ${d.toFixed(4)}s（规格 1.0±0.15）`);
    check('2.1 上升沿后灯亮', lit(e, 'l'));
  }
  // 2.2 0.9s 时不得已切换
  {
    const e = makeAutoRig();
    ticks(e, 2, FIXED_DT);
    e.setWallSwitch('w', true);
    // 先推进到 ctrl 刚通电的那一刻
    let guard = 0;
    while (!e.getNodePowered('a', 'ctrl') && guard++ < 200) e.tick(FIXED_DT);
    const tCtrl = e.getSimTime();
    // 再推进 0.9s
    while (e.getSimTime() - tCtrl < 0.9 - 1e-9) e.tick(FIXED_DT);
    check('2.2 自动开关：ctrl 通电 0.9s 时输出仍未接通',
      !cond(e, 'a') && !lit(e, 'l'), `t-tCtrl=${(e.getSimTime() - tCtrl).toFixed(4)}`);
  }
  // 2.3 下降沿
  {
    const e = makeAutoRig();
    e.setWallSwitch('w', true);
    ticks(e, 3, FIXED_DT);
    check('2.3 下降沿前：输出接通、灯亮', cond(e, 'a') && lit(e, 'l'));
    e.setWallSwitch('w', false);
    const d = semanticDelay(e, FIXED_DT,
      (x) => !x.getNodePowered('a', 'ctrl'), (x) => !cond(x, 'a'));
    note(`[2.3] 自动开关下降沿语义延迟 = ${d.toFixed(4)}s`);
    near('2.3 自动开关下降沿延迟', d, DELAY_SECONDS, 0.15);
    check('2.3 下降沿后灯灭', !lit(e, 'l'));
  }
  // 2.4 中途变回 → 计时清零
  {
    const e = makeAutoRig();
    ticks(e, 2, FIXED_DT);
    e.setWallSwitch('w', true);
    ticks(e, 0.6, FIXED_DT);            // 计时 0.6s
    e.setWallSwitch('w', false);         // 目标变回
    ticks(e, 0.6, FIXED_DT);            // 再等 0.6s，不应切换
    check('2.4 目标中途变回：计时清零不切换', !cond(e, 'a'));
    e.setWallSwitch('w', true);
    const d = semanticDelay(e, FIXED_DT, (x) => x.getNodePowered('a', 'ctrl'), (x) => cond(x, 'a'));
    near('2.4 重新计时后仍为 1 秒', d, DELAY_SECONDS, 0.15);
  }
}

/* =========================================================================
 * 3. 能量逆变器（延迟 1 秒取反）
 * ========================================================================= */
function makeInvRig() {
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('wall_switch', { id: 'w' });
  e.addElement('inverter', { id: 'v' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('p', 'out', 'w', 'a');
  e.addWire('p', 'out', 'v', 'a');
  e.addWire('w', 'b', 'v', 'ctrl');
  e.addWire('v', 'b', 'l', 'in');
  return e;
}
function section3() {
  // 3.1 初始无控制信号 → 逆变器应导通（取反）
  {
    const e = makeInvRig();
    ticks(e, 3, FIXED_DT);
    check('3.1 ctrl 未通电时逆变器导通（灯亮）', cond(e, 'v') && lit(e, 'l'));
  }
  // 3.2 上升沿：ctrl 通电 → 1 秒后输出切断
  {
    const e = makeInvRig();
    ticks(e, 3, FIXED_DT);
    e.setWallSwitch('w', true);
    const d = semanticDelay(e, FIXED_DT, (x) => x.getNodePowered('v', 'ctrl'), (x) => !cond(x, 'v'));
    near('3.2 逆变器上升沿延迟（取反）', d, DELAY_SECONDS, 0.15);
    note(`[3.2] 逆变器上升沿语义延迟 = ${d.toFixed(4)}s`);
    check('3.2 上升沿后输出切断、灯灭', !cond(e, 'v') && !lit(e, 'l'));
  }
  // 3.3 下降沿：ctrl 断 → 1 秒后输出接通
  {
    const e = makeInvRig();
    e.setWallSwitch('w', true);
    ticks(e, 3, FIXED_DT);
    check('3.3 下降沿前：逆变器切断', !cond(e, 'v'));
    e.setWallSwitch('w', false);
    const d = semanticDelay(e, FIXED_DT,
      (x) => !x.getNodePowered('v', 'ctrl'), (x) => cond(x, 'v'));
    note(`[3.3] 逆变器下降沿语义延迟 = ${d.toFixed(4)}s`);
    near('3.3 逆变器下降沿延迟（取反）', d, DELAY_SECONDS, 0.15);
    check('3.3 下降沿后灯亮', lit(e, 'l'));
  }
}

/* =========================================================================
 * 4. 频闪灯（逆变器输出自反馈）
 * ========================================================================= */
function section4() {
  const p = PRESET_BY_ID.strobe;
  const e = createEngine();
  loadPreset(e, p);
  const wallId = 'strobe_wall';
  e.setWallSwitch(wallId, true);
  const s = series(e, 20, FIXED_DT, (x) => lit(x, 'strobe_lamp'));
  const ris = risingEdges(s);
  // 用「亮/灭 双向跳变」得到半周期（rising→rising 是全周期）
  const edges = [];
  for (let i = 1; i < s.length; i++) if (s[i].v !== s[i - 1].v) edges.push(s[i].t);
  const halfPeriods = [];
  for (let i = 1; i < edges.length; i++) halfPeriods.push(edges[i] - edges[i - 1]);
  const fullPeriods = [];
  for (let i = 2; i < edges.length; i++) fullPeriods.push(edges[i] - edges[i - 2]);
  const avgHalf = halfPeriods.reduce((a, b) => a + b, 0) / (halfPeriods.length || 1);
  const avgFull = fullPeriods.reduce((a, b) => a + b, 0) / (fullPeriods.length || 1);
  note(`[4 频闪] 20s 内灯亮次数=${ris.length}，半周期样本=${halfPeriods.length}，`
    + `平均半周期=${avgHalf.toFixed(4)}s，平均全周期=${avgFull.toFixed(4)}s，`
    + `前 6 个半周期=${halfPeriods.slice(0, 6).map((x) => x.toFixed(3)).join(', ')}`);
  check('4 频闪：持续振荡（20s 内至少 8 次点亮）', ris.length >= 8);
  near('4 频闪：半周期 ≈1s', avgHalf, 1.0, 0.15);
  near('4 频闪：全周期 ≈2s', avgFull, 2.0, 0.3);
  // 不衰减：前后各半段半周期均值接近
  if (halfPeriods.length >= 6) {
    const firstH = halfPeriods.slice(0, 3).reduce((a, b) => a + b) / 3;
    const lastH = halfPeriods.slice(-3).reduce((a, b) => a + b) / 3;
    check('4 频闪：幅度不衰减（首尾半周期一致）', Math.abs(firstH - lastH) <= 0.1,
      `首3=${firstH.toFixed(3)} 尾3=${lastH.toFixed(3)}`);
  }
}

/* =========================================================================
 * 5. 走马灯（按钮版）
 * ========================================================================= */
function section5() {
  const p = PRESET_BY_ID.marquee_button;
  const e = createEngine();
  loadPreset(e, p);
  ticks(e, 2, FIXED_DT);
  check('5 走马灯：初始三灯全灭',
    !lit(e, 'marquee_button_l1') && !lit(e, 'marquee_button_l2') && !lit(e, 'marquee_button_l3'));
  e.triggerButton('marquee_button_btn');

  // 记录三灯状态序列
  const n = Math.round(20 / FIXED_DT);
  let stateSeq = [];
  let maxConcurrent = 0;
  let prev = '';
  const lampOnTimes = { l1: [], l2: [], l3: [] };
  const last = { l1: false, l2: false, l3: false };
  for (let i = 0; i < n; i++) {
    e.tick(FIXED_DT);
    const a = lit(e, 'marquee_button_l1');
    const b = lit(e, 'marquee_button_l2');
    const c = lit(e, 'marquee_button_l3');
    const cnt = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0);
    if (cnt > maxConcurrent) maxConcurrent = cnt;
    const key = `${a ? 1 : 0}${b ? 1 : 0}${c ? 1 : 0}`;
    if (key !== prev) { stateSeq.push(`${e.getSimTime().toFixed(2)}:${key}`); prev = key; }
    for (const [k, val] of [['l1', a], ['l2', b], ['l3', c]]) {
      if (val && !last[k]) lampOnTimes[k].push(e.getSimTime());
      last[k] = val;
    }
  }
  note(`[5 走马灯] 20s 内状态序列（前 18 段）：${stateSeq.slice(0, 18).join(' -> ')}`);
  note(`[5 走马灯] 三灯点亮时刻：l1=${lampOnTimes.l1.slice(0, 6).map((x) => x.toFixed(2)).join('/')} | `
    + `l2=${lampOnTimes.l2.slice(0, 6).map((x) => x.toFixed(2)).join('/')} | `
    + `l3=${lampOnTimes.l3.slice(0, 6).map((x) => x.toFixed(2)).join('/')}`);

  check('5 走马灯：稳态同一时刻最多 1 盏亮', maxConcurrent <= 1, `实测最大并发=${maxConcurrent}`);
  check('5 走马灯：三盏灯都被点亮过',
    lampOnTimes.l1.length > 0 && lampOnTimes.l2.length > 0 && lampOnTimes.l3.length > 0);
  check('5 走马灯：能持续循环（每盏至少点亮 3 次）',
    lampOnTimes.l1.length >= 3 && lampOnTimes.l2.length >= 3 && lampOnTimes.l3.length >= 3);
  // 需求原文「多次开关会使全部输出激活」——持续多次连按
  {
    const e2 = createEngine();
    loadPreset(e2, PRESET_BY_ID.marquee_button);
    ticks(e2, 1, FIXED_DT);
    let maxC = 0;
    const n3 = Math.round(15 / FIXED_DT);
    for (let i = 0; i < n3; i++) {
      if (i % 12 === 0) e2.triggerButton('marquee_button_btn'); // 每 0.2s 连按
      e2.tick(FIXED_DT);
      const c = ['l1', 'l2', 'l3'].filter((k) => lit(e2, `marquee_button_${k}`)).length;
      if (c > maxC) maxC = c;
    }
    note(`[5b 走马灯·持续连按] 15s 内最大同时亮灯数 = ${maxC}`);
    check('5b（需求原文）多次连按会使全部输出激活（出现 3 灯同亮）', maxC === 3, `实测最大并发=${maxC}`);
  }
}

/* =========================================================================
 * 6. 流水灯（环形振荡器）
 * ========================================================================= */
function section6() {
  const p = PRESET_BY_ID.waterfall_inverter;
  const e = createEngine();
  loadPreset(e, p);
  const s = series(e, 30, FIXED_DT, (x) => lit(x, 'waterfall_inverter_l1'));
  const ris = risingEdges(s);
  const periods = [];
  for (let i = 1; i < ris.length; i++) periods.push(ris[i] - ris[i - 1]);
  const avg = periods.reduce((a, b) => a + b, 0) / (periods.length || 1);
  note(`[6 流水灯] 30s 内 l1 点亮次数=${ris.length}，周期样本=${periods.length}，`
    + `平均周期=${avg.toFixed(4)}s，样本=${periods.slice(0, 5).map((x) => x.toFixed(3)).join(', ')}`);
  check('6 流水灯：持续循环（30s 内至少 3 个周期）', ris.length >= 4);
  near('6 流水灯：全周期 ≈8s', avg, 8.0, 0.6, '容差放宽到 ±0.6（4 级各 ±0.15）');
  // 逐秒打印灯态时间线，核对「依次点亮 / 追逐」形态
  const e2 = createEngine();
  loadPreset(e2, p);
  const tl = [];
  let prevMask = '';
  const n2 = Math.round(20 / FIXED_DT);
  for (let i = 0; i < n2; i++) {
    e2.tick(FIXED_DT);
    const m = ['l1', 'l2', 'l3'].map((k) => (lit(e2, `waterfall_inverter_${k}`) ? 1 : 0)).join('');
    if (m !== prevMask) { tl.push(`${e2.getSimTime().toFixed(2)}:${m}`); prevMask = m; }
  }
  note(`[6 流水灯] 20s 灯态时间线（l1l2l3）：${tl.join(' -> ')}`);
}

/* =========================================================================
 * 7. 密码门：16 种组合全测
 * ========================================================================= */
function section7() {
  // 1.0.12：拓扑按参考图重做（3 自动开关 + 3 逆变器 + 无状态灯），门的方向改为
  // 「密码正确 → 门断电 → 打开（通行）」，故 1010 是唯一门开的组合，其余 15 种门关闭。
  const p = PRESET_BY_ID.password_door;
  const EXPECT = { w1: true, w2: false, w3: true, w4: false };
  const rows = [];
  let wrong = 0;
  for (let mask = 0; mask < 16; mask++) {
    const combo = {
      w1: !!(mask & 1), w2: !!(mask & 2), w3: !!(mask & 4), w4: !!(mask & 8),
    };
    const e = createEngine();
    loadPreset(e, p);
    for (const k of ['w1', 'w2', 'w3', 'w4']) {
      e.setWallSwitch(`password_door_${k}`, combo[k]);
    }
    ticks(e, 8, FIXED_DT); // 4 级 × 1s，8s 充足
    const doorOpen = e.getElementView('password_door_door').open;
    const isCorrect = combo.w1 === EXPECT.w1 && combo.w2 === EXPECT.w2
      && combo.w3 === EXPECT.w3 && combo.w4 === EXPECT.w4;
    const expectDoorOpen = isCorrect; // 正确 → 链导通 → 末级逆变器切断 → 门断电 → 打开
    rows.push(`${combo.w1 ? 1 : 0}${combo.w2 ? 1 : 0}${combo.w3 ? 1 : 0}${combo.w4 ? 1 : 0}`
      + ` | door.open=${doorOpen ? '开' : '关'}`
      + ` | 期望门${expectDoorOpen ? '开' : '关'}`
      + `${(doorOpen === expectDoorOpen) ? '' : '  <<< 不符'}`);
    if (doorOpen !== expectDoorOpen) wrong++;
  }
  note('[7 密码门] 16 组合真值表（w1w2w3w4 顺序，正确=1010 即 开-关-开-关）：\n    ' + rows.join('\n    '));
  check('7 密码门：16 组合全部符合（仅 1010 门打开，其余 15 种门关闭）', wrong === 0, `不符 ${wrong} 组`);
}

/* =========================================================================
 * 8. 双控 XOR
 * ========================================================================= */
function section8() {
  const p = PRESET_BY_ID.two_way;
  const setup = (a, b) => {
    const e = createEngine();
    loadPreset(e, p);
    e.setWallSwitch('two_way_w1', a);
    e.setWallSwitch('two_way_w2', b);
    ticks(e, 6, FIXED_DT);
    return e;
  };
  const cases = [
    [true, false, true, '10'],
    [false, true, true, '01'],
    [false, false, false, '00'],
    [true, true, false, '11'],
  ];
  for (const [a, b, expectLit, tag] of cases) {
    const e = setup(a, b);
    check(`8 XOR：${tag} → 灯${expectLit ? '亮' : '灭'}`, lit(e, 'two_way_lamp') === expectLit);
  }
  // 从任一状态按一次任意开关 → 灯翻转
  let flips = 0; let total = 0;
  for (const [a, b] of [[true, false], [false, true], [false, false], [true, true]]) {
    for (const which of ['w1', 'w2']) {
      const e = setup(a, b);
      const before = lit(e, 'two_way_lamp');
      const na = which === 'w1' ? !a : a;
      const nb = which === 'w2' ? !b : b;
      e.setWallSwitch(`two_way_${which}`, which === 'w1' ? na : nb);
      ticks(e, 6, FIXED_DT);
      const after = lit(e, 'two_way_lamp');
      total++;
      if (after !== before) flips++;
    }
  }
  check('8 XOR：从任一状态按一次任意开关灯都翻转', flips === total, `${flips}/${total}`);
}

/* =========================================================================
 * 9. 门自动开关（邻近开关 + 逆变器）
 * ========================================================================= */
function section9() {
  const p = PRESET_BY_ID.door_auto;
  const e = createEngine();
  loadPreset(e, p);
  ticks(e, 3, FIXED_DT);
  check('9 门自动开关：玩家在圈外时门关闭（通电）',
    e.getElementView('door_auto_door').open === false);
  // 玩家拖入感应圈
  e.setPlayerPos('door_auto_player', 430, 170); // 与 prox 重合
  const dIn = semanticDelay(e, FIXED_DT,
    (x) => cond(x, 'door_auto_prox'), (x) => x.getElementView('door_auto_door').open === true);
  near('9 玩家进入感应圈后门打开的延迟', dIn, 1.0, 0.15);
  check('9 玩家在圈内时门打开', e.getElementView('door_auto_door').open === true);
  // 玩家离开
  e.setPlayerPos('door_auto_player', 640, 140);
  const dOut = semanticDelay(e, FIXED_DT,
    (x) => !cond(x, 'door_auto_prox'), (x) => x.getElementView('door_auto_door').open === false);
  near('9 玩家离开感应圈后门关闭的延迟', dOut, 1.0, 0.15);
  check('9 玩家离开后门重新关闭', e.getElementView('door_auto_door').open === false);
}

/* =========================================================================
 * 10. 边界与健壮性
 * ========================================================================= */
function section10() {
  // 10.1 环路：自动开关输出接自己 ctrl
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('auto_switch', { id: 'a' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'a', 'a');
    e.addWire('a', 'b', 'a', 'ctrl');
    e.addWire('a', 'b', 'l', 'in');
    let err = null;
    try { ticks(e, 10, FIXED_DT); } catch (x) { err = x; }
    check('10.1 自反馈环路无异常', !err, err && String(err));
  }
  // 10.2 两个逆变器互接
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('inverter', { id: 'v1' });
    e.addElement('inverter', { id: 'v2' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'v1', 'a');
    e.addWire('p', 'out', 'v2', 'a');
    e.addWire('v1', 'b', 'v2', 'ctrl');
    e.addWire('v2', 'b', 'v1', 'ctrl');
    e.addWire('v1', 'b', 'l', 'in');
    let err = null;
    try { ticks(e, 10, FIXED_DT); } catch (x) { err = x; }
    check('10.2 双逆变器互接无异常', !err, err && String(err));
  }
  // 10.3 三元件成环
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    for (const id of ['a', 'b', 'c']) e.addElement('auto_switch', { id });
    e.addWire('p', 'out', 'a', 'a');
    e.addWire('a', 'b', 'b', 'ctrl');
    e.addWire('b', 'b', 'c', 'ctrl');
    e.addWire('c', 'b', 'a', 'ctrl');
    let err = null;
    try { ticks(e, 15, FIXED_DT); } catch (x) { err = x; }
    check('10.3 三元件环路无异常', !err, err && String(err));
  }
  // 10.4 删除元件时导线被清理，后续 tick 不报错
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('lamp', { id: 'l' });
    e.addElement('wall_switch', { id: 'w' });
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('w', 'b', 'l', 'in');
    ticks(e, 0.5);
    const before = e.getWires().length;
    e.removeElement('w');
    const after = e.getWires().length;
    check('10.4 删除元件后其导线被清理', before === 2 && after === 0, `${before}→${after}`);
    let err = null;
    try { ticks(e, 5, FIXED_DT); } catch (x) { err = x; }
    check('10.4 删除元件后 tick 不报错', !err, err && String(err));
    check('10.4 删除后灯灭', !lit(e, 'l'));
  }
  // 10.5 删除导线 / 同一元件 a-b 直连 / 重复连同一对端口
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('wall_switch', { id: 'w' });
    e.addElement('lamp', { id: 'l' });
    const w1 = e.addWire('p', 'out', 'w', 'a');
    e.addWire('w', 'b', 'l', 'in');
    e.removeWire(w1.id);
    e.setWallSwitch('w', true);
    ticks(e, 0.5);
    check('10.5 删除导线后电路断开', !lit(e, 'l'));
    // 同一元件 a-b 直连（允许）
    const e2 = createEngine();
    const w2 = e2.addElement('wall_switch', { id: 'w' });
    const self = e2.addWire('w', 'a', 'w', 'b');
    check('10.5 允许同一元件 a-b 直连（生成导线）', self !== null);
    // 同一元素同一端口自连应被拒
    const self2 = e2.addWire('w', 'a', 'w', 'a');
    check('10.5 拒绝同一端口自连', self2 === null);
    // 重复连同一对端口：允许，且不报错
    const e3 = createEngine();
    e3.addElement('power', { id: 'p' });
    e3.addElement('lamp', { id: 'l' });
    const a1 = e3.addWire('p', 'out', 'l', 'in');
    const a2 = e3.addWire('p', 'out', 'l', 'in');
    check('10.5 重复连同一对端口被允许', a1 !== null && a2 !== null);
    let err = null;
    try { ticks(e3, 2, FIXED_DT); } catch (x) { err = x; }
    check('10.5 重复连线后无异常且灯亮', !err && lit(e3, 'l'), err && String(err));
  }
  // 10.6 序列化 → 反序列化往返行为一致
  {
    const p = PRESET_BY_ID.waterfall_inverter;
    const e1 = createEngine();
    loadPreset(e1, p);
    ticks(e1, 6, FIXED_DT);
    const snap1 = series(e1, 8, FIXED_DT, (x) => `${lit(x, 'waterfall_inverter_l1')}${lit(x, 'waterfall_inverter_l2')}${lit(x, 'waterfall_inverter_l3')}`);
    const e2 = createEngine();
    const okd = e2.deserialize(e1.serializeJSON());
    check('10.6 反序列化返回成功', okd === true);
    check('10.6 往返后元件数一致', e2.getElements().length === e1.getElements().length);
    check('10.6 往返后导线数一致', e2.getWires().length === e1.getWires().length);
    const snap2 = series(e2, 8, FIXED_DT, (x) => `${lit(x, 'waterfall_inverter_l1')}${lit(x, 'waterfall_inverter_l2')}${lit(x, 'waterfall_inverter_l3')}`);
    const same = snap1.length === snap2.length
      && snap1.every((s, i) => s.v === snap2[i].v);
    check('10.6 往返后 8s 仿真行为逐帧一致', same);
  }
  // 10.7 不同时间步长下的语义延迟
  {
    const vals = [];
    for (const dt of [1 / 60, 1 / 30, 0.1, 0.5]) {
      const e = makeAutoRig();
      ticks(e, 2, dt);
      e.setWallSwitch('w', true);
      const d = semanticDelay(e, dt, (x) => x.getNodePowered('a', 'ctrl'), (x) => cond(x, 'a'));
      vals.push(`dt=${dt.toFixed(4)}→${d.toFixed(4)}s`);
      near(`10.7 dt=${dt.toFixed(4)} 语义延迟`, d, 1.0, 0.15);
    }
    note('[10.7] 各步长语义延迟：' + vals.join('，'));
  }
  // 10.8 暂停时改开关，恢复后状态正确
  {
    const e = makeAutoRig();
    ticks(e, 1, FIXED_DT);
    // 模拟暂停：不 tick，只改状态
    e.setWallSwitch('w', true);
    check('10.8 暂停期间引擎状态未变（仍切断）', !cond(e, 'a'));
    // 恢复
    ticks(e, 2, FIXED_DT);
    check('10.8 恢复后自动开关接通、灯亮', cond(e, 'a') && lit(e, 'l'));
  }
  // 10.9 性能：200 元件 + 300 导线
  {
    const e = createEngine();
    const types = ['power', 'lamp', 'door', 'wall_switch', 'prox_switch', 'button',
      'floor_switch', 'auto_switch', 'inverter', 'player'];
    let n = 0;
    while (n < 200) {
      const t = types[n % types.length];
      e.addElement(t, { id: `perf${n}`, x: (n % 20) * 40, y: Math.floor(n / 20) * 40 });
      n++;
    }
    const portList = [];
    for (const el of e.getElements()) {
      for (const port of TYPE_PORTS[el.type] || []) portList.push([el.id, port]);
    }
    let made = 0; let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let guard = 0;
    while (made < 300 && guard++ < 20000) {
      const a = portList[Math.floor(rnd() * portList.length)];
      const b = portList[Math.floor(rnd() * portList.length)];
      const w = e.addWire(a[0], a[1], b[0], b[1]);
      if (w) made++;
    }
    check('10.9 成功构造 300 根导线', made === 300, `实测 ${made}`);
    // 预热
    for (let i = 0; i < 10; i++) e.tick(FIXED_DT);
    const REPS = 200;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < REPS; i++) e.tick(FIXED_DT);
    const t1 = process.hrtime.bigint();
    const msPerTick = Number(t1 - t0) / 1e6 / REPS;
    note(`[10.9 性能] 200 元件 + ${made} 导线，单次 tick 平均 = ${msPerTick.toFixed(4)} ms`
      + `（一帧预算 16.67ms 的 ${(msPerTick / 16.667 * 100).toFixed(2)}%）`);
    check('10.9 单次 tick 远低于一帧预算（<2ms）', msPerTick < 2, `${msPerTick.toFixed(4)}ms`);
  }
  // 10.10 反序列化健壮性 / 导入边界
  {
    const e = createEngine();
    check('10.10 deserialize(null) 返回 false', e.deserialize(null) === false);
    check('10.10 deserialize(非法 JSON) 返回 false', e.deserialize('{not json') === false);
    check('10.10 deserialize(无 elements) 返回 false', e.deserialize({ wires: [] }) === false);

    // 缺 id 的导线：应仍可被 removeWire 删除（id 必须与内部键一致）
    const e2 = createEngine();
    const okd = e2.deserialize({
      elements: [{ id: 'p', type: 'power' }, { id: 'l', type: 'lamp' }],
      wires: [{ a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
    });
    ticks(e2, 0.5);
    check('10.10 缺 id 导线导入后灯亮', okd === true && lit(e2, 'l'));
    const w = e2.getWires()[0];
    const removed = e2.removeWire(w.id);
    const left = e2.getWires().length;
    note(`[10.10] 缺 id 导线：w.id=${JSON.stringify(w.id)}，removeWire 返回 ${removed}，剩余 ${left}`);
    check('10.10 缺 id 的导线可被 removeWire 删除', removed === true && left === 0);

    // 非法元件类型应被跳过
    const e3 = createEngine();
    e3.deserialize({
      elements: [{ id: 'x', type: 'not_a_type' }, { id: 'p', type: 'power' }],
      wires: [],
    });
    check('10.10 非法元件类型被跳过', e3.getElements().length === 1 && e3.hasElement('p'));

    // 指向不存在端口的导线应被跳过
    const e4 = createEngine();
    e4.deserialize({
      elements: [{ id: 'p', type: 'power' }],
      wires: [{ id: 'wq', a: { el: 'p', port: 'nope' }, b: { el: 'p', port: 'out' } }],
    });
    check('10.10 非法端口导线被跳过', e4.getWires().length === 0);
  }
}

/* =========================================================================
 * 11. 6 个预设各跑 20 秒
 * ========================================================================= */
function section11() {
  for (const p of PRESETS) {
    const e = createEngine();
    loadPreset(e, p);
    const n = Math.round(20 / FIXED_DT);
    let err = null;
    const lampStats = {};
    const doorStats = {};
    let maxLampsLit = 0;
    try {
      for (let i = 0; i < n; i++) {
        e.tick(FIXED_DT);
        let cl = 0;
        for (const el of e.getElements()) {
          if (el.type === 'lamp') {
            const v = e.getElementView(el.id);
            lampStats[el.id] = lampStats[el.id] || { on: 0, n: 0 };
            lampStats[el.id].n++;
            if (v.lit) { lampStats[el.id].on++; cl++; }
          } else if (el.type === 'door') {
            const v = e.getElementView(el.id);
            doorStats[el.id] = doorStats[el.id] || { open: 0, n: 0 };
            doorStats[el.id].n++;
            if (v.open) doorStats[el.id].open++;
          }
        }
        if (cl > maxLampsLit) maxLampsLit = cl;
      }
    } catch (x) { err = x; }
    const lampSummary = Object.entries(lampStats)
      .map(([id, s]) => `${id.replace(p.id + '_', '')}:${(s.on / s.n * 100).toFixed(0)}%`).join(' ');
    const doorSummary = Object.entries(doorStats)
      .map(([id, s]) => `${id.replace(p.id + '_', '')}:开${(s.open / s.n * 100).toFixed(0)}%`).join(' ');
    note(`[11 实例 ${p.id}] 20s 运行${err ? ' 异常:' + err : ' 正常'} | 灯点亮占比 ${lampSummary || '无'}`
      + ` | 门打开占比 ${doorSummary || '无'} | 最大同时亮灯数=${maxLampsLit}`);
    check(`11 实例 ${p.id} 20s 运行无异常`, !err, err && String(err));
  }
}

/* =========================================================================
 * 12. 昼夜 / 太阳能板（本轮新增；期望值全部由 QA 独立推导）
 *     isDay 语义：DAY_START_HOUR(6) <= t < DAY_END_HOUR(18)  —— 半开区间
 * ========================================================================= */
function makeSolarDirect() {
  const e = createEngine();
  e.setDayCycle(false);
  e.addElement('solar_panel', { id: 's' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('s', 'out', 'l', 'in');
  return e;
}
function makeSolarViaAuto() {
  const e = createEngine();
  e.setDayCycle(false);
  e.addElement('power', { id: 'p' });
  e.addElement('solar_panel', { id: 's' });
  e.addElement('auto_switch', { id: 'a' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('p', 'out', 'a', 'a');    // 电源母线保证 a 常备
  e.addWire('s', 'out', 'a', 'ctrl'); // 太阳能 → 控制端
  e.addWire('a', 'b', 'l', 'in');
  return e;
}
function section12() {
  // 12.0 常量 / 端口 / 源集合
  check('12.0 solar_panel 端口 = [out]', JSON.stringify(TYPE_PORTS.solar_panel) === '["out"]');
  check('12.0 SOURCE_TYPES 含 power 与 solar_panel',
    SOURCE_TYPES.includes('power') && SOURCE_TYPES.includes('solar_panel'));
  check('12.0 白天区间常量 = [6,18)', DAY_START_HOUR === 6 && DAY_END_HOUR === 18 && DAY_LENGTH_SECONDS === 60);

  // 12.1 白天初始：供电、灯亮
  {
    const e0 = createEngine();
    check('12.1 初始 timeOfDay = 8', e0.getTimeOfDay() === 8);
    check('12.1 初始 dayCycle = true', e0.getDayCycle() === true);
    check('12.1 初始 getIsDay = true', e0.getIsDay() === true);
    const e = makeSolarDirect();
    e.setDayCycle(false);
    ticks(e, 2, FIXED_DT);
    check('12.1 t=8 getIsDay=true', e.getIsDay() === true);
    check('12.1 t=8 太阳能供电、灯亮、s.out 通电', lit(e, 'l') && e.getNodePowered('s', 'out'));
    check('12.1 t=8 太阳能板 supplying=true', e.getElementView('s').supplying === true);
  }
  // 12.2 夜晚即时断电（专门证明「无 1 秒延迟」）
  {
    const e = makeSolarDirect();
    ticks(e, 2, FIXED_DT);
    check('12.2 切夜前灯亮', lit(e, 'l'));
    e.setTimeOfDay(22);
    e.tick(FIXED_DT); // 只推进 1 帧
    check('12.2 setTimeOfDay(22) 后同一帧即断电、灯灭', !lit(e, 'l') && !e.getNodePowered('l', 'in'));
    check('12.2 t=22 getIsDay=false', e.getIsDay() === false);
  }
  // 12.3 对照：太阳能直连 vs 经自动开关 ctrl → 量化 1 秒延迟差
  {
    const eD = makeSolarDirect();
    ticks(eD, 2, FIXED_DT);
    const eA = makeSolarViaAuto();
    ticks(eA, 3, FIXED_DT);
    check('12.3 自动开关路径：白天灯亮', lit(eA, 'l'));
    eD.setTimeOfDay(22); eA.setTimeOfDay(22);
    let framesDirect = -1, framesAuto = -1;
    for (let i = 0; i < 120; i++) {
      eD.tick(FIXED_DT); eA.tick(FIXED_DT);
      if (framesDirect < 0 && !lit(eD, 'l')) framesDirect = i + 1;
      if (framesAuto < 0 && !lit(eA, 'l')) framesAuto = i + 1;
    }
    const sDirect = framesDirect * FIXED_DT, sAuto = framesAuto * FIXED_DT;
    note(`[12.3] 入夜后灯灭耗时：太阳能直连=${sDirect.toFixed(4)}s(${framesDirect}帧)，经自动开关=${sAuto.toFixed(4)}s(${framesAuto}帧)`);
    check('12.3 太阳能直连≤2 帧即断电（无 1 秒延迟）', framesDirect >= 1 && framesDirect <= 2, `帧=${framesDirect}`);
    near('12.3 经自动开关≈1.0s 才断电（对照）', sAuto, 1.0, 0.15);
    check('12.3 两者存在≈1 秒延迟差', Math.abs(sAuto - sDirect) > 0.9, `差=${(sAuto - sDirect).toFixed(4)}s`);
  }
  // 12.4 边界时刻 06:00 / 18:00（半开区间自洽性）
  {
    const day = (t) => { const e = createEngine(); e.setDayCycle(false); e.setTimeOfDay(t); return e.getIsDay(); };
    check('12.4 05:59:59 → 夜晚', day(5.9999) === false);
    check('12.4 06:00 → 白天（下界闭）', day(6) === true);
    check('12.4 17:59:59 → 白天', day(17.9999) === true);
    check('12.4 18:00 → 夜晚（上界开，推导自 isDay 代码）', day(18) === false);
    check('12.4 12:00 → 白天', day(12) === true);
    check('12.4 00:00 → 夜晚', day(0) === false);
    note('[12.4] isDay 语义 = 06:00 <= t < 18:00');
  }
  // 12.5 昼夜推进速率：60 真实秒 = 24 小时
  {
    const e = createEngine();
    e.setDayCycle(true); e.setTimeOfDay(8);
    for (let i = 0; i < Math.round(60 / FIXED_DT); i++) e.tick(FIXED_DT);
    near('12.5 推进 60s 回到 08:00', e.getTimeOfDay(), 8, 0.06);
    const e2 = createEngine();
    e2.setDayCycle(true); e2.setTimeOfDay(8);
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) e2.tick(FIXED_DT);
    near('12.5 推进 30s = 20:00', e2.getTimeOfDay(), 20, 0.06);
  }
  // 12.6 setDayCycle(false) 冻结
  {
    const e = createEngine();
    e.setTimeOfDay(8); e.setDayCycle(false);
    ticks(e, 10, FIXED_DT);
    check('12.6 关闭循环后时间冻结', Math.abs(e.getTimeOfDay() - 8) < 1e-9, `t=${e.getTimeOfDay()}`);
  }
  // 12.7 setTimeOfDay 越界 / 非法输入
  {
    const e = createEngine();
    e.setTimeOfDay(8);
    check('12.7 setTimeOfDay(24)→0', e.setTimeOfDay(24) === true && e.getTimeOfDay() === 0);
    check('12.7 setTimeOfDay(-1)→23', e.setTimeOfDay(-1) === true && e.getTimeOfDay() === 23);
    check('12.7 setTimeOfDay(-25)→23', (() => { e.setTimeOfDay(-25); return Math.abs(e.getTimeOfDay() - 23) < 1e-9; })());
    const before = e.getTimeOfDay();
    check('12.7 setTimeOfDay(NaN)→false 且不变', e.setTimeOfDay(NaN) === false && e.getTimeOfDay() === before);
    check('12.7 setTimeOfDay("abc")→false 且不变', e.setTimeOfDay('abc') === false && e.getTimeOfDay() === before);
    check('12.7 setTimeOfDay(undefined)→false 且不变', e.setTimeOfDay(undefined) === false && e.getTimeOfDay() === before);
    check('12.7 setTimeOfDay("22")（数字串）→22', e.setTimeOfDay('22') === true && e.getTimeOfDay() === 22);
    check('12.7 setTimeOfDay(13.5)→13.5', e.setTimeOfDay(13.5) === true && Math.abs(e.getTimeOfDay() - 13.5) < 1e-9);
  }
  // 12.8 reset() 复位
  {
    const e = createEngine();
    e.setTimeOfDay(3); e.setDayCycle(false);
    e.reset();
    check('12.8 reset 后 timeOfDay=8', e.getTimeOfDay() === 8);
    check('12.8 reset 后 dayCycle=true', e.getDayCycle() === true);
  }
  // 12.9 序列化往返 + 缺省字段
  {
    const e = makeSolarDirect();
    e.setTimeOfDay(21);
    ticks(e, 1, FIXED_DT);
    const e2 = createEngine();
    check('12.9 反序列化成功', e2.deserialize(e.serializeJSON()) === true);
    check('12.9 往返 timeOfDay 一致(21)', Math.abs(e2.getTimeOfDay() - 21) < 1e-9, `t=${e2.getTimeOfDay()}`);
    check('12.9 往返 dayCycle 一致(false)', e2.getDayCycle() === false);
    ticks(e2, 0.5);
    check('12.9 夜晚往返后灯仍灭', !lit(e2, 'l'));

    const e3 = createEngine();
    const ok3 = e3.deserialize({
      elements: [{ id: 's', type: 'solar_panel' }, { id: 'l', type: 'lamp' }],
      wires: [{ id: 'w1', a: { el: 's', port: 'out' }, b: { el: 'l', port: 'in' } }],
    });
    check('12.9 缺 timeOfDay 的老 JSON 可载入', ok3 === true);
    check('12.9 缺省 timeOfDay=8', e3.getTimeOfDay() === 8);
    check('12.9 缺省 dayCycle=true', e3.getDayCycle() === true);
    ticks(e3, 0.5);
    check('12.9 缺省字段下白天太阳能供电、灯亮', lit(e3, 'l'));

    const e4 = createEngine();
    e4.deserialize({ elements: [{ id: 's', type: 'solar_panel' }, { id: 'l', type: 'lamp' }], wires: [{ id: 'w1', a: { el: 's', port: 'out' }, b: { el: 'l', port: 'in' } }], dayCycle: false });
    check('12.9 dayCycle:false 被尊重', e4.getDayCycle() === false);
  }
  // 12.10 太阳能与普通电源同一网络（关键回归：power 未被改坏）
  {
    const e = createEngine();
    e.setDayCycle(false);
    e.addElement('power', { id: 'p' });
    e.addElement('solar_panel', { id: 's' });
    e.addElement('wall_switch', { id: 'w' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('s', 'out', 'w', 'a');
    e.setWallSwitch('w', true);
    e.addWire('w', 'b', 'l', 'in');
    e.setTimeOfDay(22); ticks(e, 0.5);
    check('12.10 夜晚：普通电源照常供电', lit(e, 'l'));
    check('12.10 夜晚：太阳能板 supplying=false', e.getElementView('s').supplying === false);
    e.setTimeOfDay(12); ticks(e, 0.5);
    check('12.10 白天：双源同在仍通电', lit(e, 'l'));
  }
  // 12.11 太阳能串开关 / 接逆变器 ctrl 组合不报错
  {
    let err = null; let day = null; let night = null;
    try {
      const e = createEngine();
      e.setDayCycle(false);
      e.addElement('power', { id: 'p' });
      e.addElement('solar_panel', { id: 's' });
      e.addElement('wall_switch', { id: 'w' });
      e.addElement('inverter', { id: 'v' });
      e.addElement('lamp', { id: 'l' });
      e.addWire('s', 'out', 'w', 'a');
      e.setWallSwitch('w', true);
      e.addWire('w', 'b', 'v', 'ctrl');
      e.addWire('p', 'out', 'v', 'a');
      e.addWire('v', 'b', 'l', 'in');
      e.setTimeOfDay(8); ticks(e, 3, FIXED_DT); day = lit(e, 'l');
      e.setTimeOfDay(22); ticks(e, 3, FIXED_DT); night = lit(e, 'l');
    } catch (x) { err = x; }
    note(`[12.11] 太阳能经开关驱动逆变器 ctrl：白天灯=${day}，夜晚灯=${night}`);
    check('12.11 组合用法不报错', !err, err && String(err));
  }
  // 12.12 太阳能板 state
  {
    const e = createEngine();
    e.setDayCycle(false);
    e.addElement('solar_panel', { id: 's' });
    e.setTimeOfDay(8); ticks(e, 0.1);
    const v1 = e.getElementView('s');
    check('12.12 白天 supplying/conducting=true', v1.supplying === true && v1.conducting === true);
    e.setTimeOfDay(20); ticks(e, 0.1);
    const v2 = e.getElementView('s');
    check('12.12 夜晚 supplying/conducting=false', v2.supplying === false && v2.conducting === false);
  }
  // 12.13 getTimeOfDay 返回设定值
  {
    const e = createEngine();
    e.setDayCycle(false);
    e.setTimeOfDay(15.25);
    check('12.13 getTimeOfDay=15.25', Math.abs(e.getTimeOfDay() - 15.25) < 1e-9);
  }
}

/* =========================================================================
 * 13. 电源可开关（N1，QA 独立推导期望值）
 *     语义：power.state.on !== false 即供电（缺字段默认供电 → 旧 JSON 兼容）
 * ========================================================================= */
function makePowerRig() {
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('p', 'out', 'l', 'in');
  return e;
}
function section13() {
  // 13.1 默认新建：on=true、网络通电、灯亮
  {
    const e = createEngine();
    const p = e.addElement('power', { id: 'p' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'l', 'in');
    check('13.1 新建 power 默认 state.on === true', p.state.on === true, `on=${p.state.on}`);
    ticks(e, 0.5);
    check('13.1 默认新建即供电：灯亮、out 通电', lit(e, 'l') && e.getNodePowered('p', 'out'));
  }
  // 13.2 setPower(false) 同帧断电；togglePower 往返恢复
  {
    const e = makePowerRig();
    ticks(e, 0.5);
    check('13.2 关断前灯亮', lit(e, 'l'));
    check('13.2 setPower 返回 true', e.setPower('p', false) === true);
    e.tick(FIXED_DT); // 仅推进 1 帧
    const v = e.getElementView('p');
    check('13.2 关断后同一帧整网断电（灯灭）', !lit(e, 'l') && !e.getNodePowered('l', 'in'));
    check('13.2 关断后同一帧电源 out 也不通电', !e.getNodePowered('p', 'out'));
    check('13.2 关断后 state.on === false', v.state.on === false);
    // togglePower 往返
    check('13.2 togglePower 返回 true', e.togglePower('p') === true);
    e.tick(FIXED_DT);
    check('13.2 togglePower 恢复供电', lit(e, 'l') && e.getNodePowered('p', 'out'));
    check('13.2 再次 togglePower 再关断', e.togglePower('p') === true && !(() => { e.tick(FIXED_DT); return lit(e, 'l'); })());
  }
  // 13.3 旧 JSON 兼容：不含 on 字段 → 默认供电（!== false 语义）
  {
    const e = createEngine();
    const ok = e.deserialize({
      elements: [{ id: 'p', type: 'power' }, { id: 'l', type: 'lamp' }],
      wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
    });
    check('13.3 旧 JSON 载入成功', ok === true);
    check('13.3 旧 JSON power 默认供电（state.on===true）', e.getElementView('p').state.on === true);
    ticks(e, 0.5);
    check('13.3 旧 JSON 载入后灯亮', lit(e, 'l'));
  }
  // 13.4 setPower 传给非 power 元件 → false、无副作用
  {
    const e = createEngine();
    e.addElement('power', { id: 'p' });
    e.addElement('lamp', { id: 'l' });
    e.addElement('wall_switch', { id: 'w' });
    e.setWallSwitch('w', true);
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('w', 'b', 'l', 'in');
    ticks(e, 0.5);
    check('13.4 setPower(lamp) 返回 false', e.setPower('l', false) === false);
    check('13.4 setPower(wall_switch) 返回 false', e.setPower('w', false) === false);
    check('13.4 setPower(不存在 id) 返回 false', e.setPower('ghost', false) === false);
    check('13.4 副作用检查：墙开仍导通、灯仍亮', cond(e, 'w') && lit(e, 'l'));
    check('13.4 副作用检查：墙开 state.on 未被改动', e.getElementView('w').state.on === true);
    check('13.4 副作用检查：lamp state 无 on 字段被写入', !('on' in e.getElementView('l').state));
    check('13.4 togglePower(非 power) 返回 false', e.togglePower('l') === false && e.togglePower('w') === false);
  }
  // 13.5 混接：power 关断后同网络的 solar（白天）仍供电
  {
    const e = createEngine();
    e.setDayCycle(false);
    e.addElement('power', { id: 'p' });
    e.addElement('solar_panel', { id: 's' });
    e.addElement('wall_switch', { id: 'w' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p', 'out', 'w', 'a');
    e.addWire('s', 'out', 'w', 'a');
    e.setWallSwitch('w', true);
    e.addWire('w', 'b', 'l', 'in');
    e.setTimeOfDay(12); ticks(e, 0.5); // 白天
    check('13.5 双源白天灯亮', lit(e, 'l'));
    e.setPower('p', false);
    e.tick(FIXED_DT);
    check('13.5 power 关断后 solar 支路仍通电（灯亮）', lit(e, 'l') && e.getNodePowered('l', 'in'));
    check('13.5 power 关断后 state.on=false', e.getElementView('p').state.on === false);
    // 太阳能入夜（power 已关）→ 整网断电
    e.setTimeOfDay(22);
    e.tick(FIXED_DT);
    check('13.5 power 关 + 入夜 → 整网断电', !lit(e, 'l'));
    // 恢复 power → 立即（无延迟）重新供电
    e.togglePower('p');
    e.tick(FIXED_DT);
    check('13.5 恢复 power 后无延迟重新供电', lit(e, 'l'));
  }
  // 13.6 关断电源对延迟元件的影响：power→墙开(合)→auto ctrl，断电 1 秒后自动开关切断
  {
    const e = makeAutoRig(); // p→w.a, p→a.a, w.b→a.ctrl, a.b→l.in
    ticks(e, 2, FIXED_DT);
    e.setWallSwitch('w', true);
    // 等 ctrl 通电 + 自动开关 1s 延迟完成
    let guard = 0;
    while (!(cond(e, 'a') && lit(e, 'l')) && guard++ < 600) e.tick(FIXED_DT);
    check('13.6 前置：自动开关已接通、灯亮', cond(e, 'a') && lit(e, 'l'));
    const t0 = e.getSimTime();
    e.setPower('p', false);
    e.tick(FIXED_DT); // setPower 在下一 tick 生效（与 13.2 同帧语义一致）
    // power 断电：ctrl 失电（ctrl 是直连采样，无延迟）
    check('13.6 断电后 ctrl 立即失电', !e.getNodePowered('a', 'ctrl'));
    // 自动开关输出端 1 秒延迟后切断
    const d = semanticDelay(e, FIXED_DT,
      (x) => !x.getNodePowered('a', 'ctrl'), (x) => !cond(x, 'a'));
    note(`[13.6] 关断电源后自动开关切断延迟 = ${d.toFixed(4)}s`);
    near('13.6 关断电源后自动开关 1 秒延迟切断', d, DELAY_SECONDS, 0.15);
    check('13.6 自动开关切断后灯灭', !lit(e, 'l'));
    check(`13.6 从关断到灯灭总耗时 ≈1s（实测 ${(e.getSimTime() - t0).toFixed(4)}s）`,
      Math.abs(e.getSimTime() - t0 - 1) < 0.2);
    // 恢复电源 → ctrl 立即通电，1s 后自动开关重新接通
    const t1 = e.getSimTime();
    e.setPower('p', true);
    e.tick(FIXED_DT); // setPower 在下一 tick 生效
    check('13.6 恢复电源后 ctrl 立即通电', e.getNodePowered('a', 'ctrl'));
    const d2 = semanticDelay(e, FIXED_DT,
      (x) => x.getNodePowered('a', 'ctrl'), (x) => cond(x, 'a'));
    near('13.6 恢复电源后自动开关 1 秒延迟接通', d2, DELAY_SECONDS, 0.15);
    check('13.6 恢复后灯亮', lit(e, 'l'));
    check(`13.6 从恢复到灯亮总耗时 ≈1s（实测 ${(e.getSimTime() - t1).toFixed(4)}s）`,
      Math.abs(e.getSimTime() - t1 - 1) < 0.2);
  }
  // 13.7 serialize/deserialize 往返保留 on:false
  {
    const e = makePowerRig();
    ticks(e, 0.5);
    e.setPower('p', false);
    e.tick(FIXED_DT);
    const json = e.serializeJSON();
    check('13.7 序列化 JSON 含 "on": false', /"on"\s*:\s*false/.test(json));
    const e2 = createEngine();
    check('13.7 反序列化成功', e2.deserialize(json) === true);
    check('13.7 往返后 on=false 被保留', e2.getElementView('p').state.on === false);
    ticks(e2, 0.5);
    check('13.7 往返后灯仍灭（on=false 生效）', !lit(e2, 'l'));
    check('13.7 往返后 out 仍不通电', !e2.getNodePowered('p', 'out'));
  }
  // 13.8 多电源网络：只关掉一个，另一个仍供电
  {
    const e = createEngine();
    e.addElement('power', { id: 'p1' });
    e.addElement('power', { id: 'p2' });
    e.addElement('lamp', { id: 'l' });
    e.addWire('p1', 'out', 'l', 'in');
    e.addWire('p2', 'out', 'l', 'in');
    ticks(e, 0.5);
    check('13.8 双电源灯亮', lit(e, 'l'));
    e.setPower('p1', false);
    e.tick(FIXED_DT);
    check('13.8 关掉 p1 后 p2 仍供电', lit(e, 'l'));
    e.setPower('p2', false);
    e.tick(FIXED_DT);
    check('13.8 双双关断后灯灭', !lit(e, 'l'));
  }
}

/* =========================================================================
 * 14. 走线样式持久化（本轮新增：'straight' 直线 | 'curve' 曲线）
 * ========================================================================= */
function section14() {
  const e = createEngine();
  check('14.1 默认走线样式 = straight', e.getWireStyle() === 'straight', `实测 ${e.getWireStyle()}`);
  check('14.2 setWireStyle(curve) 成功', e.setWireStyle('curve') === true && e.getWireStyle() === 'curve');
  // 旧值 'orth'（直角，已废弃）与其余非法值一律拒绝
  check('14.3 setWireStyle(orth) 被拒绝（直角走线已取消）', e.setWireStyle('orth') === false && e.getWireStyle() === 'curve');
  check('14.4 setWireStyle(非法值) 被拒绝', e.setWireStyle('diagonal') === false && e.setWireStyle('') === false && e.setWireStyle(null) === false);
  // 序列化往返
  {
    const e2 = createEngine();
    e2.addElement('power', { id: 'p' });
    e2.addElement('lamp', { id: 'l' });
    e2.addWire('p', 'out', 'l', 'in');
    e2.setWireStyle('curve');
    const json = e2.serializeJSON();
    check('14.5 序列化 JSON 含 "wireStyle": "curve"', /"wireStyle"\s*:\s*"curve"/.test(json));
    const e3 = createEngine();
    check('14.6 反序列化成功', e3.deserialize(json) === true);
    check('14.7 往返后走线样式 = curve', e3.getWireStyle() === 'curve', `实测 ${e3.getWireStyle()}`);
  }
  {
    const e4 = createEngine();
    e4.setWireStyle('curve');
    e4.setWireStyle('straight');
    const e5 = createEngine();
    check('14.8 直线样式往返保留 straight', e5.deserialize(e4.serializeJSON()) === true && e5.getWireStyle() === 'straight');
  }
  // 旧 JSON 兼容：缺 wireStyle 字段 → 直线
  {
    const e7 = createEngine();
    const okd = e7.deserialize({
      elements: [{ id: 'p', type: 'power' }, { id: 'l', type: 'lamp' }],
      wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
    });
    check('14.9 旧 JSON（缺 wireStyle）载入成功', okd === true);
    check('14.10 旧 JSON 缺省走线样式 = straight', e7.getWireStyle() === 'straight');
  }
  // reset() 保留走线样式偏好（它是视图偏好，不随画布清空复位）
  {
    const e8 = createEngine();
    e8.setWireStyle('curve');
    e8.reset();
    check('14.11 reset 后保留走线样式偏好 curve', e8.getWireStyle() === 'curve');
  }
  // 走线样式不影响仿真结果
  {
    const eA = createEngine();
    eA.addElement('power', { id: 'p' });
    eA.addElement('lamp', { id: 'l' });
    eA.addWire('p', 'out', 'l', 'in');
    eA.setWireStyle('curve');
    ticks(eA, 0.5);
    const eB = createEngine();
    eB.addElement('power', { id: 'p' });
    eB.addElement('lamp', { id: 'l' });
    eB.addWire('p', 'out', 'l', 'in');
    ticks(eB, 0.5);
    check('14.12 走线样式不影响通电仿真（curve 与 straight 均灯亮）', lit(eA, 'l') && lit(eB, 'l'));
  }
}

/* =========================================================================
 * 运行
 * ========================================================================= */
const SECTIONS = [
  ['1 并查集传播', section1],
  ['2 自动开关', section2],
  ['3 逆变器', section3],
  ['4 频闪灯', section4],
  ['5 走马灯', section5],
  ['6 流水灯', section6],
  ['7 密码门', section7],
  ['8 双控 XOR', section8],
  ['9 门自动开关', section9],
  ['10 边界与健壮性', section10],
  ['11 七个预设 20s', section11],
  ['12 昼夜与太阳能板', section12],
  ['13 电源可开关', section13],
  ['14 走线样式持久化', section14],
];

console.log('===== NMS 电力模拟器 · 内核独立回归套件 =====');
for (const [name, fn] of SECTIONS) {
  try {
    fn();
  } catch (x) {
    results.fail++;
    results.failures.push(`[${name}] 抛出异常：${x && x.stack ? x.stack : x}`);
  }
}

console.log('\n----- 信息 / 实测值 -----');
for (const s of results.notes) console.log('  ' + s);

console.log('\n----- 结果 -----');
console.log(`  通过: ${results.pass}   失败: ${results.fail}`);
if (results.failures.length) {
  console.log('\n----- 失败明细 -----');
  for (const f of results.failures) console.log('  ✗ ' + f);
}
console.log(results.fail === 0 ? '\nALL_TESTS_PASS' : '\nTESTS_FAILED');
process.exit(results.fail === 0 ? 0 : 1);

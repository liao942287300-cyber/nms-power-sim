#!/usr/bin/env node
/**
 * tests/qa_109_glowcolor.test.mjs
 * ---------------------------------------------------------------------------
 * QA 严过关 · 1.0.9 增量「发光地板 + 灯色」独立内核验证套件。
 *
 * 原则：期望值全部由本人依据需求原文 / 内核语义独立推导，未采信工程师自测脚本
 *       （tests/_eng109_selfcheck.mjs）或报告中的任何数字。
 *
 * 覆盖：
 *   A. glow_floor 电气属性（端口集合 / SINK / 非 SWITCH / 零延迟点亮）
 *   B. setColor 合法 / 非法 / 非灯类 / 不存在 id 的返回值与零副作用
 *   C. setColor 不动 state、不动 revision（仅 dynRev 递增）
 *   D. 序列化往返（color / glow_floor 类型）
 *   E. 向后兼容（老 JSON 无 props.color → 默认黄）
 *   F. LIGHT_COLOR_KEYS ↔ catalog.LIGHT_COLORS 键集合一致 + 每色字段非空
 *   G. 新元件不破坏既有仿真（marquee_button 20s 走马灯不变）
 *
 * 运行： node tests/qa_109_glowcolor.test.mjs
 * 通过： exit 0；有失败： exit 1
 * ---------------------------------------------------------------------------
 */
import { createEngine, FIXED_DT, TYPE_PORTS, SINK_TYPES, SWITCH_TYPES, LIGHT_COLOR_KEYS } from '../js/engine.js';
import { LIGHT_COLORS } from '../js/catalog.js';
import { PRESET_BY_ID, loadPreset } from '../js/presets.js';

const R = { pass: 0, fail: 0, failures: [] };
function check(name, cond, detail = '') {
  if (cond) R.pass++;
  else { R.fail++; R.failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
  return !!cond;
}
function eq(name, a, b) {
  return check(name, JSON.stringify(a) === JSON.stringify(b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);
}
const lit = (e, id) => !!(e.getElementView(id) && e.getElementView(id).lit);
function ticks(e, seconds, dt = FIXED_DT) {
  const n = Math.max(0, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) e.tick(dt);
}

/* =========================================================================
 * A. glow_floor 电气属性
 * ========================================================================= */
function sectionA() {
  console.log('\n--- A. glow_floor 电气属性 ---');
  eq('A1 端口集合恰为 [in]', TYPE_PORTS.glow_floor, ['in']);
  check('A2 在 SINK_TYPES 中', SINK_TYPES.includes('glow_floor'));
  check('A3 不在 SWITCH_TYPES 中', !SWITCH_TYPES.includes('glow_floor'));

  // 电源 out → glow_floor in：单帧（1/60 s）即点亮 = 零延迟
  const e = createEngine();
  e.addElement('power', { id: 'p', x: 0, y: 0 });
  e.addElement('glow_floor', { id: 'g', x: 200, y: 0 });
  e.addWire('p', 'out', 'g', 'in');
  check('A4 上电前 lit=false', e.getElementView('g').lit === false);
  e.tick(FIXED_DT); // 仅推进 1 帧
  check('A5 通电后【1 帧即亮】= 零延迟（非 1 秒）', lit(e, 'g') === true,
    `1 帧后 lit=${lit(e, 'g')}`);

  // 电源人为关断 → 下一帧熄灭（零延迟）
  e.setPower('p', false);
  e.tick(FIXED_DT);
  check('A6 电源关断后 1 帧即灭（零延迟）', lit(e, 'g') === false);
  e.setPower('p', true);
  e.tick(FIXED_DT);
  check('A7 电源恢复后 1 帧即亮', lit(e, 'g') === true);

  // 断开导线 → 下一帧熄灭
  const w = e.getWires().find((x) => x.a.el === 'p' || x.b.el === 'p');
  e.removeWire(w.id);
  e.tick(FIXED_DT);
  check('A8 断开导线后 1 帧即灭', lit(e, 'g') === false);

  // 对照：同为负载的 lamp 语义一致
  const e2 = createEngine();
  e2.addElement('power', { id: 'p' });
  e2.addElement('lamp', { id: 'l' });
  e2.addWire('p', 'out', 'l', 'in');
  e2.tick(FIXED_DT);
  check('A9 对照：lamp 同样 1 帧即亮', lit(e2, 'l') === true);
}

/* =========================================================================
 * B. setColor 返回值与零副作用
 * ========================================================================= */
function sectionB() {
  console.log('\n--- B. setColor 合法 / 非法 / 非灯类 / 不存在 ---');
  const e = createEngine();
  e.addElement('lamp', { id: 'L', x: 0, y: 0 });
  e.addElement('glow_floor', { id: 'G', x: 0, y: 0 });
  e.addElement('power', { id: 'P', x: 0, y: 0 });
  e.addElement('door', { id: 'D', x: 0, y: 0 });
  e.addElement('wall_switch', { id: 'W', x: 0, y: 0 });

  // 合法 7 色全部成功（lamp + glow_floor）
  let allOkLamp = true, allOkGlow = true;
  for (const k of LIGHT_COLOR_KEYS) {
    if (e.setColor('L', k) !== true) allOkLamp = false;
    if (e.getElement('L').props.color !== k) allOkLamp = false;
    if (e.setColor('G', k) !== true) allOkGlow = false;
    if (e.getElement('G').props.color !== k) allOkGlow = false;
  }
  check('B1 lamp 7 色全部成功且落值', allOkLamp);
  check('B2 glow_floor 7 色全部成功且落值', allOkGlow);

  // 非法 key → false 且 color 不变
  e.setColor('L', 'green');
  const bad = ['orange', '', null, 123, 'GREEN', undefined, 'Green', {}];
  let badOk = true;
  for (const k of bad) {
    const before = e.getElement('L').props.color;
    const r = e.setColor('L', k);
    if (r !== false) badOk = false;
    if (e.getElement('L').props.color !== before) badOk = false;
  }
  check('B3 非法 key（orange/空/null/数字/大写/undefined/对象）→ false 且 color 不变', badOk);

  // 非灯类元件 → false 且无任何副作用（props 不变）
  let nonLightOk = true;
  for (const [id, type] of [['P', 'power'], ['D', 'door'], ['W', 'wall_switch']]) {
    const el = e.getElement(id);
    const snapProps = JSON.stringify(el.props);
    const snapState = JSON.stringify(el.state);
    const r = e.setColor(id, 'purple');
    if (r !== false) nonLightOk = false;
    if (JSON.stringify(el.props) !== snapProps) nonLightOk = false;
    if (JSON.stringify(el.state) !== snapState) nonLightOk = false;
    if (el.props.color !== undefined) nonLightOk = false;
  }
  check('B4 非灯类（power/door/wall_switch）→ false 且 props/state 零变化', nonLightOk);

  // 不存在 id → false
  check('B5 不存在的 id → false', e.setColor('nope', 'green') === false);
  check('B5b id=null → false', e.setColor(null, 'green') === false);
}

/* =========================================================================
 * C. setColor 不动 state / 不动 revision
 * ========================================================================= */
function sectionC() {
  console.log('\n--- C. setColor 只动 props.color + dynRev ---');
  const e = createEngine();
  e.addElement('lamp', { id: 'L' });
  e.addElement('power', { id: 'P' });
  e.addWire('P', 'out', 'L', 'in');
  ticks(e, 0.5);
  const stateBefore = JSON.stringify(e.getElement('L').state);
  const revBefore = e.getRevision();
  const dynBefore = e.getDynRev();

  check('C1 setColor 成功', e.setColor('L', 'purple') === true);
  const stateAfter = JSON.stringify(e.getElement('L').state);
  const revAfter = e.getRevision();
  const dynAfter = e.getDynRev();

  eq('C2 state 深比较完全不变', stateAfter, stateBefore);
  check('C3 getRevision() 不变', revAfter === revBefore, `${revBefore}→${revAfter}`);
  check('C4 getDynRev() 递增（≥+1）', dynAfter > dynBefore, `${dynBefore}→${dynAfter}`);
  check('C5 props.color 已改为 purple', e.getElement('L').props.color === 'purple');
  // 改色不改 lit（仿真结果与颜色无关）
  check('C6 改色不影响 lit', lit(e, 'L') === true);
}

/* =========================================================================
 * D. 序列化往返
 * ========================================================================= */
function sectionD() {
  console.log('\n--- D. 序列化往返 ---');
  const e = createEngine();
  e.addElement('lamp', { id: 'L', x: 120, y: 60 });
  e.addElement('glow_floor', { id: 'G', x: 240, y: 60 });
  e.addElement('power', { id: 'P', x: 0, y: 0 });
  e.setColor('L', 'purple');
  e.setColor('G', 'blue');
  e.addWire('P', 'out', 'L', 'in');

  const json = e.serializeJSON();
  const e2 = createEngine();
  check('D1 deserialize 成功', e2.deserialize(json) === true);
  eq('D2 lamp 颜色往返 = purple', e2.getElement('L').props.color, 'purple');
  eq('D3 glow_floor 类型往返成功', e2.getElement('G').type, 'glow_floor');
  eq('D4 glow_floor 颜色往返 = blue', e2.getElement('G').props.color, 'blue');
  // 往返后仍可仿真：电源经线点亮 lamp
  e2.tick(FIXED_DT);
  check('D5 往返后仿真仍正确（lamp 点亮）', lit(e2, 'L') === true);
}

/* =========================================================================
 * E. 向后兼容：老 JSON 无 props.color
 * ========================================================================= */
function sectionE() {
  console.log('\n--- E. 向后兼容（老 JSON 无 color） ---');
  const e = createEngine();
  // lamp：props 为空对象；glow_floor 仅 1.0.9 才有，这里额外造一个老式 lamp 无 props
  const old = {
    version: 1,
    elements: [
      { id: 'L', type: 'lamp', x: 0, y: 0, props: {} },
      { id: 'L2', type: 'lamp', x: 0, y: 0 }, // 连 props 字段都没有
    ],
    wires: [],
    timeOfDay: 8, dayCycle: false,
  };
  check('E1 老 JSON deserialize 成功', e.deserialize(old) === true);
  eq('E2 props 为空对象 → 默认黄', e.getElement('L').props.color, 'yellow');
  eq('E3 props 字段缺失 → 默认黄', e.getElement('L2').props.color, 'yellow');
}

/* =========================================================================
 * F. LIGHT_COLOR_KEYS ↔ LIGHT_COLORS 一致性
 * ========================================================================= */
function sectionF() {
  console.log('\n--- F. 引擎 ↔ 目录 颜色键一致 ---');
  const catKeys = Object.keys(LIGHT_COLORS);
  eq('F1 键集合完全一致（排序后）', [...catKeys].sort(), [...LIGHT_COLOR_KEYS].sort());
  eq('F2 键数量 = 7', catKeys.length, 7);
  let fieldsOk = true;
  for (const k of LIGHT_COLOR_KEYS) {
    const c = LIGHT_COLORS[k];
    if (!c) { fieldsOk = false; continue; }
    if (typeof c.name !== 'string' || !c.name) fieldsOk = false;
    if (typeof c.on !== 'string' || !c.on) fieldsOk = false;
    if (typeof c.off !== 'string' || !c.off) fieldsOk = false;
  }
  check('F3 每色 name/on/off 均为非空字符串', fieldsOk);
  check('F4 order 与引擎一致（逐位）', LIGHT_COLOR_KEYS.every((k, i) => catKeys[i] === k),
    `引擎=${LIGHT_COLOR_KEYS} 目录=${catKeys}`);
  // 顺序按需求原文：绿 粉 黄 蓝 紫 白 红
  eq('F5 顺序 = [green,pink,yellow,blue,purple,white,red]',
    LIGHT_COLOR_KEYS, ['green', 'pink', 'yellow', 'blue', 'purple', 'white', 'red']);
}

/* =========================================================================
 * G. 新元件不破坏既有仿真（走马灯 20s）
 * ========================================================================= */
function sectionG() {
  console.log('\n--- G. 回归：marquee_button 走马灯 20s ---');
  const e = createEngine();
  loadPreset(e, PRESET_BY_ID.marquee_button);
  ticks(e, 2);
  e.triggerButton('marquee_button_btn');

  const n = Math.round(20 / FIXED_DT);
  let maxConcurrent = 0;
  const rise = { l1: 0, l2: 0, l3: 0 };
  const last = { l1: false, l2: false, l3: false };
  const order = []; // 每次「新灯亮起」记录 1/2/3
  for (let i = 0; i < n; i++) {
    e.tick(FIXED_DT);
    const s = { l1: lit(e, 'marquee_button_l1'), l2: lit(e, 'marquee_button_l2'), l3: lit(e, 'marquee_button_l3') };
    maxConcurrent = Math.max(maxConcurrent, (s.l1 ? 1 : 0) + (s.l2 ? 1 : 0) + (s.l3 ? 1 : 0));
    for (const [k, idx] of [['l1', 1], ['l2', 2], ['l3', 3]]) {
      if (s[k] && !last[k]) { rise[k]++; order.push(idx); }
      last[k] = s[k];
    }
  }
  check('G1 三盏灯各翻转（点亮）≥ 4 次', rise.l1 >= 4 && rise.l2 >= 4 && rise.l3 >= 4,
    `rise=${JSON.stringify(rise)}`);
  check('G2 稳态同一时刻最多 1 盏亮', maxConcurrent <= 1, `maxConcurrent=${maxConcurrent}`);
  // 拍序交替：连续两次「新灯亮起」按 3 灯循环推进（环上步进 ≡ +1 mod 3）
  let rotate = order.length >= 6;
  for (let i = 1; i < Math.min(order.length, 9); i++) {
    const step = (order[i] - order[i - 1] + 3) % 3;
    if (step !== 1) rotate = false;
  }
  check('G3 三灯按拍序循环交替（环上 +1 步进）', rotate, `order(前9)=${order.slice(0, 9)}`);
  check('G4 至少发生 4 次灯序切换事件', order.length >= 4, `order.length=${order.length}`);
}

/* ============================== 主流程 ============================== */
console.log('===== 1.0.9 发光地板 / 灯色 · QA 独立内核套件 =====');
for (const fn of [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF, sectionG]) {
  try { fn(); } catch (err) {
    R.fail++;
    R.failures.push(`[${fn.name}] 抛出异常：${err && err.stack ? err.stack : err}`);
    console.log(`  ✗ [${fn.name}] 异常: ${err && err.message}`);
  }
}
console.log('\n===== 结果 =====');
console.log(`  通过: ${R.pass}   失败: ${R.fail}`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   ✗ ' + f)); }
console.log(R.fail === 0 ? 'QA109_GLOWCOLOR_PASS' : 'QA109_GLOWCOLOR_FAILED');
process.exit(R.fail === 0 ? 0 : 1);

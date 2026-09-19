#!/usr/bin/env node
/**
 * tests/_eng109_selfcheck.mjs
 * ---------------------------------------------------------------------------
 * 工程师寇豆码 · 1.0.9 内核自测（临时脚本，非正式回归套件——正式套件由 QA 严过关负责）。
 *
 * 覆盖：
 *   A. 发光地板 glow_floor 通电即 lit / 断电即灭
 *   B. 序列化往返保留 props.color（lamp 与 glow_floor）
 *   C. setColor 对非法 key / 非法类型 / 不存在 id 返回 false 且无副作用
 *   D. setColor 不改 state（lit 只由通电决定）
 *   E. 缺 color 的老 JSON 载入后默认 yellow
 *   F. 常量契约：LIGHT_COLOR_KEYS / TYPE_PORTS.glow_floor / SINK_TYPES
 *
 * 运行： node tests/_eng109_selfcheck.mjs
 * ---------------------------------------------------------------------------
 */
import { createEngine, FIXED_DT, LIGHT_COLOR_KEYS, TYPE_PORTS, SINK_TYPES, nodeKey } from '../js/engine.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
  return !!cond;
}
function ticks(e, sec) {
  const n = Math.max(0, Math.round(sec / FIXED_DT));
  for (let i = 0; i < n; i++) e.tick(FIXED_DT);
}
const lit = (e, id) => e.getElementView(id).lit === true;

/* ---------------- F. 常量契约 ---------------- */
check('F1 LIGHT_COLOR_KEYS 顺序 = 绿粉黄蓝紫白红',
  JSON.stringify(LIGHT_COLOR_KEYS) === JSON.stringify(['green', 'pink', 'yellow', 'blue', 'purple', 'white', 'red']),
  JSON.stringify(LIGHT_COLOR_KEYS));
check('F2 TYPE_PORTS.glow_floor = [in]', JSON.stringify(TYPE_PORTS.glow_floor) === '["in"]');
check('F3 SINK_TYPES 含 glow_floor', SINK_TYPES.includes('glow_floor'));

/* ---------------- A. glow_floor 通电即亮 / 断电即灭 ---------------- */
{
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('glow_floor', { id: 'g' });
  e.addElement('wall_switch', { id: 'w' });
  e.addWire('p', 'out', 'w', 'a');
  e.addWire('w', 'b', 'g', 'in');
  ticks(e, 0.5);
  check('A1 墙开断开时发光地板熄灭', !lit(e, 'g'));
  check('A1 断开时 in 端口不通电', !e.getNodePowered('g', 'in'));
  e.setWallSwitch('w', true);
  e.tick(FIXED_DT);
  check('A2 墙开接通后发光地板点亮', lit(e, 'g'));
  check('A2 接通后 in 端口通电', e.getNodePowered('g', 'in'));
  e.setWallSwitch('w', false);
  e.tick(FIXED_DT);
  check('A3 再次断开后发光地板熄灭', !lit(e, 'g'));

  // 默认 state.lit = false 且默认 props.color = yellow
  const e2 = createEngine();
  const g = e2.addElement('glow_floor', { id: 'g0' });
  check('A4 新建 glow_floor 默认 lit=false', g.state.lit === false);
  check('A5 新建 glow_floor 默认 color=yellow', g.props.color === 'yellow');
  const l = e2.addElement('lamp', { id: 'l0' });
  check('A6 新建 lamp 默认 color=yellow', l.props.color === 'yellow');
}

/* ---------------- B. 序列化往返保留 props.color ---------------- */
{
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('lamp', { id: 'l' });
  e.addElement('glow_floor', { id: 'g' });
  e.addWire('p', 'out', 'l', 'in');
  e.addWire('p', 'out', 'g', 'in');
  check('B1 setColor(lamp, purple) 成功', e.setColor('l', 'purple') === true);
  check('B2 setColor(glow_floor, pink) 成功', e.setColor('g', 'pink') === true);
  ticks(e, 0.5);
  const json = e.serializeJSON();
  const e2 = createEngine();
  check('B3 反序列化成功', e2.deserialize(json) === true);
  check('B4 往返后 lamp color=purple', e2.getElement('l').props.color === 'purple');
  check('B5 往返后 glow_floor color=pink', e2.getElement('g').props.color === 'pink');
  ticks(e2, 0.5);
  check('B6 往返后通电仍点亮', lit(e2, 'l') && lit(e2, 'g'));
}

/* ---------------- C. setColor 非法输入无副作用 ---------------- */
{
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('lamp', { id: 'l' });
  e.addElement('wall_switch', { id: 'w' });
  e.setWallSwitch('w', true);
  e.setColor('l', 'blue');
  const revBefore = e.getRevision();
  const dynBefore = e.getDynRev();

  check('C1 setColor(lamp, 非法key)  返回 false', e.setColor('l', 'magenta') === false);
  check('C2 setColor(lamp, null)     返回 false', e.setColor('l', null) === false);
  check('C3 setColor(lamp, undefined)返回 false', e.setColor('l', undefined) === false);
  check('C4 setColor(非法类型 wall_switch) 返回 false', e.setColor('w', 'green') === false);
  check('C5 setColor(不存在的 id)      返回 false', e.setColor('ghost', 'green') === false);
  check('C6 setColor(power)            返回 false', e.setColor('p', 'green') === false);

  check('C7 非法调用不改 props.color（仍 blue）', e.getElement('l').props.color === 'blue');
  check('C8 非法调用不动 dynamic 修订号（无副作用）', e.getDynRev() === dynBefore, `${dynBefore}->${e.getDynRev()}`);
  check('C9 非法调用不动结构修订号（无副作用）', e.getRevision() === revBefore);
  check('C10 非法调用未给 wall_switch 写入 color',
    !('color' in e.getElement('w').props) || e.getElement('w').props.color === undefined);
}

/* ---------------- D. setColor 不改 state ---------------- */
{
  const e = createEngine();
  e.addElement('power', { id: 'p' });
  e.addElement('lamp', { id: 'l' });
  e.addWire('p', 'out', 'l', 'in');
  ticks(e, 0.5);
  check('D1 前置：灯点亮', lit(e, 'l'));
  const litBefore = e.getElement('l').state.lit;
  e.setColor('l', 'red');
  check('D2 改色后 state.lit 不变', e.getElement('l').state.lit === litBefore);
  check('D3 改色后仍点亮（颜色不影响仿真）', lit(e, 'l'));
  e.tick(FIXED_DT);
  check('D4 改色并 tick 后仍点亮', lit(e, 'l'));

  // 断电侧：改色不点亮熄灭的灯
  const e2 = createEngine();
  e2.addElement('lamp', { id: 'lonely' });
  e2.setColor('lonely', 'green');
  ticks(e2, 0.2);
  check('D5 未通电灯改色后仍熄灭', !lit(e2, 'lonely'));
}

/* ---------------- E. 缺 color 的老 JSON → 默认 yellow ---------------- */
{
  const e = createEngine();
  const ok = e.deserialize({
    elements: [
      { id: 'p', type: 'power' },
      { id: 'l', type: 'lamp', props: {} },              // 显式空 props
      { id: 'l2', type: 'lamp' },                        // 无 props 字段
      { id: 'g', type: 'glow_floor' },                   // 新类型无 props
    ],
    wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
  });
  check('E1 老 JSON（无 color）载入成功', ok === true);
  check('E2 缺 color 的 lamp 默认 yellow（显式空 props）', e.getElement('l').props.color === 'yellow');
  check('E3 缺 color 的 lamp 默认 yellow（无 props 字段）', e.getElement('l2').props.color === 'yellow');
  check('E4 缺 color 的 glow_floor 默认 yellow', e.getElement('g').props.color === 'yellow');
  ticks(e, 0.5);
  check('E5 老 JSON 载入后电路正常通电（灯亮）', lit(e, 'l'));
}

/* ---------------- 结果 ---------------- */
console.log('===== 1.0.9 内核自测（_eng109_selfcheck） =====');
console.log(`  通过: ${pass}   失败: ${fail}`);
if (failures.length) {
  console.log('----- 失败明细 -----');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log(fail === 0 ? 'SELFCHECK_PASS' : 'SELFCHECK_FAIL');
process.exit(fail === 0 ? 0 : 1);

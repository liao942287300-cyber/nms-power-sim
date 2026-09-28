#!/usr/bin/env node
/**
 * tests/qa_113_powerbus.test.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 1.0.13 · 「隐藏电源线」判据（电源母线）独立验证套件
 *
 * 背景（用户两轮报障）：
 *   v1.1.0 把「结构上属于电源连通分量」的线全藏了（含开关之后的受控线）
 *     → 用户：「隐藏过多了，不是我需求的功能」
 *   v1.1.1 收窄成「一端必须是电源 out 端口」
 *     → 用户带截图：「要求还是不对…画圈的隐藏，因为他们的供电来源都是电源 不会被开关控制」
 *        截图里那根 `墙壁开关A.a → 自动开关A.a` 两端都不碰电源端口，但确实在母线上。
 *
 * 最终判据（本套件按此独立推导，不照抄实现）：
 *   并查集，**只 union 导线两端，绝不 union 开关内部 a-b**（那条内部边 = 「被控制」的分界线）；
 *   所有 SOURCE_TYPES（power / solar_panel）的 out 端口所在连通分量 = 「母线」；
 *   导线任一端落在母线上、且两端都不是 ctrl → 隐藏。
 *   直觉：母线 = 从电源 out 出发、沿途不穿过任何开关 a-b 内部即可达的所有节点。
 *
 * 运行： node tests/qa_113_powerbus.test.mjs
 * 通过： exit 0（结尾 POWERBUS_PASS）；失败： exit 1
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/* ============================ 环境准备 ============================ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = mkdtempSync(join(tmpdir(), 'qa113-'));

/** 源项目是浏览器 ES Module，包内无 package.json(type:module) —— 复制成 .mjs 再 import。 */
async function importAsMjs(jsPath, tag) {
  const dst = join(TMP, tag + '.mjs');
  writeFileSync(dst, readFileSync(jsPath, 'utf8'), 'utf8');
  return import(pathToFileURL(dst).href);
}
const engineMod = await importAsMjs(join(ROOT, 'js', 'engine.js'), 'engine');
const E = engineMod.default && engineMod.default.createEngine ? engineMod.default : engineMod;
const eng = () => E.createEngine();

/* ============================ 断言框架 ============================ */
let pass = 0;
const failures = [];
const lines = [];
function ck(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else failures.push(`${name} | 实际=${actual} 期望=${expected}`);
  lines.push(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  (实际=${actual} 期望=${expected})`}`);
}
function section(t) { lines.push(''); lines.push('── ' + t); }

/* ==================== A. 用户示例图（母线 + 双控 + 逆变器） ==================== */
section('A. 用户示例图：电源母线 + 双控 + 逆变器（4 根红圈应隐藏）');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('wall_switch', { id: 'SWA' });
  e.addElement('wall_switch', { id: 'SWB' });
  e.addElement('auto_switch', { id: 'ATA' });
  e.addElement('auto_switch', { id: 'ATB' });
  e.addElement('inverter', { id: 'IVA' });
  e.addElement('inverter', { id: 'IVB' });
  e.addElement('lamp', { id: 'OUT' });

  const w1 = e.addWire('P', 'out', 'SWA', 'a');   // 红圈① 电源 → 墙壁开关A.a
  const w2 = e.addWire('SWA', 'a', 'ATA', 'a');   // 红圈② 母线在输入端之间串联延伸
  const w3 = e.addWire('P', 'out', 'ATB', 'a');   // 红圈③ 电源 → 自动开关B.a
  const w4 = e.addWire('P', 'out', 'SWB', 'b');   // 红圈④ 电源 → 墙壁开关B.b
  const w5 = e.addWire('SWA', 'b', 'IVB', 'a');   // 跨过 a-b → 受控
  const w6 = e.addWire('ATA', 'b', 'IVA', 'a');   // 跨过 a-b → 受控
  const w7 = e.addWire('IVA', 'b', 'OUT', 'in');  // 跨过 a-b → 受控

  ck('A1 红圈① 电源→墙壁开关A.a 应隐藏', e.isWireOnPowerBus(w1.id), true);
  ck('A2 红圈② 墙壁开关A.a→自动开关A.a（母线延伸，两端都不碰电源）应隐藏', e.isWireOnPowerBus(w2.id), true);
  ck('A3 红圈③ 电源→自动开关B.a 应隐藏', e.isWireOnPowerBus(w3.id), true);
  ck('A4 红圈④ 电源→墙壁开关B.b 应隐藏', e.isWireOnPowerBus(w4.id), true);
  ck('A5 墙壁开关A.b→逆变器B.a（跨过 a-b）应保留', e.isWireOnPowerBus(w5.id), false);
  ck('A6 自动开关A.b→逆变器A.a（跨过 a-b）应保留', e.isWireOnPowerBus(w6.id), false);
  ck('A7 逆变器A.b→输出端.in（跨过 a-b）应保留', e.isWireOnPowerBus(w7.id), false);

  // 判据是纯结构拓扑，与开关通断无关（隐藏后画面不闪烁）
  e.toggleWallSwitch('SWA');
  for (let i = 0; i < 130; i++) e.tick(1 / 60);
  ck('A8 翻转开关 130 帧后 母线判据不变', e.isWireOnPowerBus(w1.id) && e.isWireOnPowerBus(w2.id), true);
  ck('A9 翻转开关后 受控线仍保留', e.isWireOnPowerBus(w5.id), false);
}

/* ==================== B. 开关输出端被拉回母线 ==================== */
section('B. 开关输出端落在母线上时，该端口引出的线也归母线');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('wall_switch', { id: 'SWB' });
  e.addElement('auto_switch', { id: 'AT' });
  const w1 = e.addWire('P', 'out', 'SWB', 'b');
  const w2 = e.addWire('AT', 'b', 'SWB', 'b');
  ck('B1 电源→墙壁开关B.b 应隐藏', e.isWireOnPowerBus(w1.id), true);
  ck('B2 自动开关.b→墙壁开关B.b（该端口在母线上）应隐藏', e.isWireOnPowerBus(w2.id), true);
}

/* ==================== C. 控制端口（ctrl）例外 ==================== */
section('C. 控制段（ctrl）永不隐藏');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('inverter', { id: 'IV' });
  e.addElement('wall_switch', { id: 'A' });
  const w1 = e.addWire('P', 'out', 'IV', 'ctrl');
  const w2 = e.addWire('A', 'b', 'IV', 'ctrl');
  const w3 = e.addWire('P', 'out', 'IV', 'a');
  ck('C1 电源→逆变器.ctrl 应保留（控制段）', e.isWireOnPowerBus(w1.id), false);
  ck('C2 开关b→逆变器.ctrl 应保留（控制段）', e.isWireOnPowerBus(w2.id), false);
  ck('C3 电源→逆变器.a 应隐藏', e.isWireOnPowerBus(w3.id), true);
}

/* ==================== D. 链式开关：受控侧逐级隔离 ==================== */
section('D. 链式开关：a-b 逐级切断');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('wall_switch', { id: 'A' });
  e.addElement('wall_switch', { id: 'B' });
  e.addElement('lamp', { id: 'L' });
  const w1 = e.addWire('P', 'out', 'A', 'a');
  const w2 = e.addWire('A', 'b', 'B', 'a');
  const w3 = e.addWire('B', 'b', 'L', 'in');
  ck('D1 电源→A.a 应隐藏', e.isWireOnPowerBus(w1.id), true);
  ck('D2 A.b→B.a 应保留', e.isWireOnPowerBus(w2.id), false);
  ck('D3 B.b→灯 应保留', e.isWireOnPowerBus(w3.id), false);
}

/* ==================== E. 边界：孤立线 / 空画布 ==================== */
section('E. 边界情形');
{
  const e = eng();
  e.addElement('wall_switch', { id: 'A' });
  e.addElement('wall_switch', { id: 'B' });
  const w = e.addWire('A', 'b', 'B', 'a');
  ck('E1 孤立线（无电源）应保留', e.isWireOnPowerBus(w.id), false);
}
{
  const e = eng();
  ck('E2 空画布 集合为空', e.getPowerBusWireIds().size, 0);
}

/* ==================== F. 电源直连负载 / 太阳能板 ==================== */
section('F. 电源直连负载 与 太阳能板');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('lamp', { id: 'L' });
  const w = e.addWire('P', 'out', 'L', 'in');
  ck('F1 电源→灯.in 应隐藏', e.isWireOnPowerBus(w.id), true);
}
{
  const e = eng();
  e.addElement('solar_panel', { id: 'S' });
  e.addElement('wall_switch', { id: 'A' });
  const w = e.addWire('S', 'out', 'A', 'a');
  ck('F2 太阳能板→开关.a 应隐藏', e.isWireOnPowerBus(w.id), true);
}

/* ==================== G. 删电源 / 缓存失效 ==================== */
section('G. 结构变更后的缓存失效');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('wall_switch', { id: 'A' });
  const w = e.addWire('P', 'out', 'A', 'a');
  ck('G1 删电源前 隐藏', e.isWireOnPowerBus(w.id), true);
  e.removeElement('P');
  ck('G2 删电源后 不再隐藏', e.isWireOnPowerBus(w.id), false);
}
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('wall_switch', { id: 'A' });
  e.addElement('wall_switch', { id: 'B' });
  e.getPowerBusWireIds();                        // 先建立缓存
  const w = e.addWire('A', 'a', 'B', 'a');       // 增量加线
  ck('G3 增量加线后 缓存失效并重算（A.a 尚未接电源）', e.isWireOnPowerBus(w.id), false);
  const w2 = e.addWire('P', 'out', 'A', 'a');    // 再把 A.a 接到电源
  ck('G4 再接电源后 A.a↔B.a 也归入母线', e.isWireOnPowerBus(w.id), true);
  ck('G5 同时 电源→A.a 也隐藏', e.isWireOnPowerBus(w2.id), true);
}

/* ==================== H. 逆变器级联 ==================== */
section('H. 逆变器级联');
{
  const e = eng();
  e.addElement('power', { id: 'P' });
  e.addElement('inverter', { id: 'IA' });
  e.addElement('inverter', { id: 'IB' });
  e.addElement('lamp', { id: 'L' });
  const w1 = e.addWire('P', 'out', 'IA', 'a');
  const w2 = e.addWire('IA', 'b', 'IB', 'a');
  const w3 = e.addWire('IB', 'b', 'L', 'in');
  ck('H1 电源→逆变器A.a 应隐藏', e.isWireOnPowerBus(w1.id), true);
  ck('H2 逆变器A.b→逆变器B.a 应保留', e.isWireOnPowerBus(w2.id), false);
  ck('H3 逆变器B.b→灯 应保留', e.isWireOnPowerBus(w3.id), false);
}

/* ==================== I. 多电源 ==================== */
section('I. 多电源');
{
  const e = eng();
  e.addElement('power', { id: 'P1' });
  e.addElement('power', { id: 'P2' });
  e.addElement('wall_switch', { id: 'A' });
  const w1 = e.addWire('P1', 'out', 'A', 'a');
  const w2 = e.addWire('P2', 'out', 'A', 'a');
  ck('I1 P1→A.a 应隐藏', e.isWireOnPowerBus(w1.id), true);
  ck('I2 P2→A.a 应隐藏', e.isWireOnPowerBus(w2.id), true);
}

/* ==================== J. 内置实例回归（真实电路上不崩、集合自洽） ==================== */
section('J. 内置实例回归');
{
  const presetMod = await importAsMjs(join(ROOT, 'js', 'presets.js'), 'presets');
  const PRESETS = presetMod.PRESETS || presetMod.default || [];
  const loadPreset = presetMod.loadPreset;
  const list = Array.isArray(PRESETS) ? PRESETS : [];

  let sane = 0;
  let withHidden = 0;
  let withKept = 0;
  const stats = [];
  for (const p of list) {
    const e = eng();
    let loaded = false;
    try { loaded = loadPreset(e, p) === true; } catch (err) { loaded = false; }
    if (!loaded) { failures.push(`J 实例「${p.id}」载入失败`); continue; }

    const ids = e.getPowerBusWireIds();
    const total = e.getWires().length;
    const selfConsistent = ids.size <= total && [...ids].every((id) => e.hasWire(id));
    if (selfConsistent) sane++; else failures.push(`J 实例「${p.id}」母线集合不自洽`);

    if (ids.size > 0) withHidden++;
    if (total - ids.size > 0) withKept++;
    stats.push(`     ${p.id.padEnd(20)} 母线 ${String(ids.size).padStart(3)} / 共 ${String(total).padStart(3)}  受控保留 ${String(total - ids.size).padStart(3)}`);
  }

  ck(`J1 全部 ${list.length} 个内置实例：母线集合 ⊆ 导线集 且 id 有效`, sane, list.length);
  ck(`J2 全部 ${list.length} 个实例都有电源母线线（有东西可隐藏）`, withHidden, list.length);
  ck(`J3 至少 ${list.length - 1} 个实例保留了受控线（判据不是"全藏"）`, withKept >= list.length - 1, true);
  ck(`J4 至少 1 个实例确实隐藏了线（判据不是"全留"）`, withHidden >= 1, true);
  lines.push('  各实例统计（母线 / 总数 / 受控保留）：');
  for (const s of stats) lines.push(s);
}

/* ============================ 汇总 ============================ */
const total = pass + failures.length;
lines.unshift(`qa_113_powerbus  「隐藏电源线」判据 = 电源母线（1.0.13）`);
lines.unshift('='.repeat(72));
lines.push('');
lines.push('='.repeat(72));
lines.push(`通过: ${pass}   失败: ${failures.length}   总计: ${total}`);
if (failures.length) {
  lines.push('');
  lines.push('失败明细：');
  for (const f of failures) lines.push('  - ' + f);
}
lines.push(failures.length ? 'POWERBUS_FAIL' : 'POWERBUS_PASS');
console.log(lines.join('\n'));

process.exit(failures.length ? 1 : 0);

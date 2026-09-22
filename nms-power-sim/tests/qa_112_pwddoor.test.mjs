#!/usr/bin/env node
/**
 * tests/qa_112_pwddoor.test.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 1.0.12 · 「简单密码门的应用（password_door）」独立验证套件
 *
 * 背景（用户报障）：
 *   「导入后与图对不上，图中是 3 个逆变器和 3 个自动开关，导入后是 4 个自动开关
 *     和 2 个逆变器，而且开关门反了。」
 *
 * 本套件的期望值**独立推导自需求与内核语义**，不照抄工程师的自测结论：
 *   · door 是反逻辑元件 —— 通电 = 关闭（拦截），断电 = 打开（通行）。
 *     见 engine.js: `const open = !powered.has(nodeKey(el.id,'in'))`。
 *   · 参考图语义：4 个墙壁开关组成密码「开-关-开-关」，三级自动开关串成与链，
 *     第②④位经逆变器取反，末级逆变器把「密码正确」反相成「门断电」。
 *   ⇒ 唯一开门组合 = w1 开 / w2 关 / w3 开 / w4 关（记作 1010），其余 15 种关门。
 *   ⇒ 元件清单必须与图一致：自动开关 3、能量逆变器 3、墙壁开关 4、电源 1、门 1，
 *     且**不得**出现状态灯（lamp / glow_floor）。
 *
 * 运行： node tests/qa_112_pwddoor.test.mjs
 * 通过： exit 0（结尾 PWDDOOR_PASS）；失败： exit 1
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/* ============================ 环境准备 ============================ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/** 临时工作区（系统 temp，自然消失，不在项目里留垃圾）。 */
const TMP = mkdtempSync(join(tmpdir(), 'qa112-'));

/** 源项目是浏览器 ES Module，包内无 package.json(type:module) —— 复制成 .mjs 再 import。 */
async function importAsMjs(jsPath, tag) {
  const dst = join(TMP, tag + '.mjs');
  writeFileSync(dst, readFileSync(jsPath, 'utf8'), 'utf8');
  return import(pathToFileURL(dst).href);
}
const engineMod = await importAsMjs(join(ROOT, 'js', 'engine.js'), 'engine');
const presetMod = await importAsMjs(join(ROOT, 'js', 'presets.js'), 'presets');
const { createEngine, FIXED_DT, TYPE_PORTS, DELAY_TYPES } = engineMod;
const { PRESETS, PRESET_BY_ID, loadPreset } = presetMod;

/* ============================ 断言记账 ============================ */
const results = { pass: 0, fail: 0, failures: [], notes: [] };
function check(name, cond, detail = '') {
  if (cond) { results.pass++; return true; }
  results.fail++;
  results.failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
  return false;
}
function note(s) { results.notes.push(s); }
function section(t) { note('\n──────── ' + t + ' ────────'); }

/* ============================ 常量与工具 ============================ */
const PID = 'password_door';
const W = ['w1', 'w2', 'w3', 'w4'];
/** 正确密码「开-关-开-关」—— 独立推导自参考图语义（非照抄实现）。 */
const CORRECT = { w1: true, w2: false, w3: true, w4: false };
const idOf = (k) => `${PID}_${k}`;
const ON = (b) => (b ? '开' : '关');
const OPEN = (b) => (b ? '打开' : '关闭');

function runFor(e, seconds, onTick) {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 1; i <= n; i++) {
    e.tick(FIXED_DT);
    if (onTick) onTick(e, i * FIXED_DT);
  }
  return e.getSimTime();
}

/** 取一份快照（元件缺失时返回 null，供反向验证的变体电路使用）。 */
function snap(e) {
  const g = (k) => e.getElementView(idOf(k));
  const door = g('door');
  const aA = g('aA'), aB = g('aB'), aC = g('aC'), invD = g('invD');
  const inv2 = g('inv2'), inv4 = g('inv4');
  return {
    doorOpen: door ? !!door.open : null,
    aA: aA ? !!aA.state.conducting : null,
    aB: aB ? !!aB.state.conducting : null,
    aC: aC ? !!aC.state.conducting : null,
    inv2: inv2 ? !!inv2.state.conducting : null,
    inv4: inv4 ? !!inv4.state.conducting : null,
    invD: invD ? !!invD.state.conducting : null,
  };
}

/** 用给定 preset 建引擎、按 combo 拨好 4 个墙壁开关。 */
function build(preset, combo) {
  const e = createEngine();
  loadPreset(e, preset);
  for (const k of W) e.setWallSwitch(idOf(k), combo[k]);
  return e;
}

/**
 * 【核心断言】16 组合真值表。
 * 期望：仅当 4 位全部与 CORRECT 一致时门打开，其余 15 种门关闭。
 * 采样点 8s —— 4 级延迟链（3×自动开关 + 末级逆变器）最多 4s 稳定，8s 足够避开上电瞬态。
 */
function truthTable(preset, seconds = 8) {
  const rows = [];
  for (let mask = 0; mask < 16; mask++) {
    const combo = { w1: !!(mask & 1), w2: !!(mask & 2), w3: !!(mask & 4), w4: !!(mask & 8) };
    const e = build(preset, combo);
    runFor(e, seconds);
    const s = snap(e);
    const wantOpen = W.every((k) => combo[k] === CORRECT[k]);
    rows.push({
      code: W.map((k) => (combo[k] ? '1' : '0')).join(''),
      combo, ...s, wantOpen, ok: s.doorOpen === wantOpen,
    });
  }
  return rows;
}
const fmtRow = (r) => `${r.code}  ${ON(r.combo.w1)}-${ON(r.combo.w2)}-${ON(r.combo.w3)}-${ON(r.combo.w4)}`
  + `  aA=${r.aA ? '通' : '断'} aB=${r.aB ? '通' : '断'} aC=${r.aC ? '通' : '断'}`
  + `  invD=${r.invD === null ? '—' : (r.invD ? '通' : '断')}`
  + `  门=${r.doorOpen === null ? '—' : OPEN(r.doorOpen)}`
  + `  期望门=${OPEN(r.wantOpen)}  ${r.ok ? 'PASS' : 'FAIL'}`;

/** 结构自检：孤立元件 / 悬空 ctrl / 非法端口 / 负坐标（不依赖技能脚本，纯本地校验）。 */
function structureAudit(preset) {
  const errs = [];
  const keys = new Set(preset.nodes.map((n) => n.key));
  const typeOf = new Map(preset.nodes.map((n) => [n.key, n.type]));
  const degree = new Map();
  const ctrlTouched = new Set();
  for (const l of preset.links) {
    const [ka, pa, kb, pb] = l;
    for (const [k, p] of [[ka, pa], [kb, pb]]) {
      if (!keys.has(k)) { errs.push(`导线引用了不存在的元件 key "${k}"`); continue; }
      const t = typeOf.get(k);
      if (!(TYPE_PORTS[t] || []).includes(p)) errs.push(`导线接到 ${k}(${t}) 的非法端口 "${p}"`);
      degree.set(k, (degree.get(k) || 0) + 1);
      if (p === 'ctrl') ctrlTouched.add(k);
    }
  }
  for (const n of preset.nodes) {
    if (n.type === 'player') continue;
    if (!degree.get(n.key)) errs.push(`元件 ${n.key}(${n.type}) 没有任何导线 —— 孤立元件`);
  }
  for (const n of preset.nodes) {
    if (DELAY_TYPES.includes(n.type) && !ctrlTouched.has(n.key)) {
      errs.push(`${n.key}(${n.type}) 的 ctrl 控制端悬空 —— 永远不会翻转`);
    }
  }
  for (const n of preset.nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errs.push(`元件 ${n.key} 坐标非法`);
    else if (n.x < 0 || n.y < 0) errs.push(`元件 ${n.key} 坐标为负 (${n.x},${n.y})`);
  }
  return errs;
}

/** 调技能自带验证器 sim.mjs 做离线仿真体检（--json 取机器可读报告）。 */
const SKILL_SIM = join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy', 'skills', 'nms-power-sim-circuit', 'scripts', 'sim.mjs',
);
function runSkillValidator(preset, seconds = 8) {
  if (!existsSync(SKILL_SIM)) return { skipped: true, reason: '技能验证器不存在: ' + SKILL_SIM };
  const file = join(TMP, `${preset.id}.json`);
  writeFileSync(file, JSON.stringify({ id: preset.id, nodes: preset.nodes, links: preset.links }, null, 2), 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [
      SKILL_SIM, file, '--seconds', String(seconds), '--json',
      '--engine', join(ROOT, 'js', 'engine.js'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = String(err.stdout || '');
    code = Number(err.status) || -1;
  }
  let rep = null;
  try { rep = JSON.parse(out); } catch { /* 解析失败时保留原文 */ }
  return { skipped: false, file, exitCode: code, raw: out, report: rep };
}

/* =========================================================================
 * 1. 图文一致性（本次修复的核心：元件数量 / 清单 / 拓扑）
 * ========================================================================= */
section('1. 图文一致性：元件数量与清单');
const PRESET = PRESET_BY_ID.password_door;
check('1.0 password_door 实例存在', !!PRESET);

const count = {};
for (const n of PRESET.nodes) count[n.type] = (count[n.type] || 0) + 1;
note(`元件构成: ${Object.entries(count).map(([k, v]) => `${k}×${v}`).join(', ')}（共 ${PRESET.nodes.length} 个）`);
note(`导线: ${PRESET.links.length} 根`);

check('1.1 自动开关 auto_switch 数量 == 3', count.auto_switch === 3, `实测 ${count.auto_switch}`);
check('1.2 能量逆变器 inverter 数量 == 3', count.inverter === 3, `实测 ${count.inverter}`);
check('1.3 墙壁开关 wall_switch 数量 == 4', count.wall_switch === 4, `实测 ${count.wall_switch}`);
check('1.4 普通电门 door 数量 == 1', count.door === 1, `实测 ${count.door}`);
check('1.5 电源 power 数量 == 1', count.power === 1, `实测 ${count.power}`);
check('1.6 元件总数 == 12（电源1+墙开4+自动开关3+逆变器3+门1）', PRESET.nodes.length === 12, `实测 ${PRESET.nodes.length}`);
check('1.7 不存在状态灯 lamp', !count.lamp, `实测 lamp×${count.lamp || 0}（参考图上没有状态灯）`);
check('1.8 不存在发光地板 glow_floor', !count.glow_floor, `实测 glow_floor×${count.glow_floor || 0}`);
check('1.9 导线总数 == 17', PRESET.links.length === 17, `实测 ${PRESET.links.length}`);

// 元件清单 parts 也要与图一致
const partOf = (name) => (PRESET.parts || []).find((p) => p.name === name);
check('1.10 parts「自动开关」qty == 3', partOf('自动开关') && partOf('自动开关').qty === 3,
  `实测 ${JSON.stringify(partOf('自动开关') || null)}`);
check('1.11 parts「能量逆变器」qty == 3', partOf('能量逆变器') && partOf('能量逆变器').qty === 3,
  `实测 ${JSON.stringify(partOf('能量逆变器') || null)}`);
check('1.12 parts「墙壁开关」qty == 4', partOf('墙壁开关') && partOf('墙壁开关').qty === 4,
  `实测 ${JSON.stringify(partOf('墙壁开关') || null)}`);
check('1.13 parts 里没有「输出端（灯柱）」条目', !partOf('输出端（灯柱）'),
  `实测 ${JSON.stringify(partOf('输出端（灯柱）') || null)}`);
check('1.14 parts 里没有任何含「灯」的条目（参考图无灯）',
  !(PRESET.parts || []).some((p) => /灯/.test(p.name)),
  (PRESET.parts || []).map((p) => `${p.name}×${p.qty}`).join('、'));
note(`parts 清单: ${(PRESET.parts || []).map((p) => `${p.name}×${p.qty}`).join('、')}`);

// 初始密码位必须是「开-关-开-关」
const initOf = (k) => (PRESET.nodes.find((n) => n.key === k) || {}).init;
const initOK = W.every((k) => {
  const want = CORRECT[k];
  const ini = initOf(k);
  return want === true ? !!(ini && ini.on) : !(ini && ini.on);
});
check('1.15 初始密码位 = 开-关-开-关（w1/w3 开，w2/w4 关）', initOK,
  W.map((k) => `${k}=${JSON.stringify(initOf(k) || null)}`).join(' '));

// 拓扑：工程师声明的 17 根导线，逐根比对（集合相等）
const EXPECT_LINKS = [
  ['power', 'out', 'w1', 'a'], ['power', 'out', 'w2', 'a'], ['power', 'out', 'w3', 'a'],
  ['power', 'out', 'w4', 'a'], ['power', 'out', 'inv2', 'a'], ['power', 'out', 'inv4', 'a'],
  ['power', 'out', 'invD', 'a'],
  ['w1', 'b', 'aA', 'a'], ['aA', 'b', 'aB', 'a'], ['aB', 'b', 'aC', 'a'], ['aC', 'b', 'invD', 'ctrl'],
  ['invD', 'b', 'door', 'in'],
  ['w2', 'b', 'inv2', 'ctrl'], ['inv2', 'b', 'aA', 'ctrl'], ['w3', 'b', 'aB', 'ctrl'],
  ['w4', 'b', 'inv4', 'ctrl'], ['inv4', 'b', 'aC', 'ctrl'],
];
const normLinks = (ls) => new Set(ls.map((l) => l.join('>')));
const gotL = normLinks(PRESET.links);
const expL = normLinks(EXPECT_LINKS);
const missL = [...expL].filter((x) => !gotL.has(x));
const extraL = [...gotL].filter((x) => !expL.has(x));
check('1.16 17 根导线与声明拓扑完全一致（电源母线7 + 与链4 + 门1 + 控制端5）',
  missL.length === 0 && extraL.length === 0,
  `缺失 [${missL.join(', ')}]；多余 [${extraL.join(', ')}]`);

// 结构自检：孤立元件 / 悬空 ctrl / 负坐标
const sErrs = structureAudit(PRESET);
check('1.17 结构自检 0 问题（无孤立元件 / 无悬空 ctrl / 无负坐标）', sErrs.length === 0, sErrs.join('；'));
note(`结构自检: ${sErrs.length ? sErrs.join('；') : '无问题'}`);

/* =========================================================================
 * 2. 独立真值表：16 种组合
 * ========================================================================= */
section('2. 16 组合真值表（采样 t=8s，避开上电瞬态）');
const rows = truthTable(PRESET, 8);
note('  code  w1-w2-w3-w4   与链          末级     实测    期望');
for (const r of rows) note('  ' + fmtRow(r));
const wrong = rows.filter((r) => !r.ok);
check('2.1 16 组合全部符合：仅 1010 门打开，其余 15 种门关闭', wrong.length === 0,
  `${wrong.length} 组不符: ${wrong.map((r) => r.code).join(',')}`);
const openCodes = rows.filter((r) => r.doorOpen).map((r) => r.code);
check('2.2 恰有 1 个组合开门，且它就是 1010', openCodes.length === 1 && openCodes[0] === '1010',
  `实测开门组合 [${openCodes.join(',')}]`);
// 采样点稳健性：8s 与 12s 的结论必须一致（证明采到的是稳态，不是碰巧）
{
  const rows12 = truthTable(PRESET, 12);
  const diff = rows.filter((r, i) => r.doorOpen !== rows12[i].doorOpen).map((r) => r.code);
  check('2.3 采样点稳健：t=8s 与 t=12s 结论完全一致（采到的是稳态）', diff.length === 0,
    `不一致的组合 [${diff.join(',')}]`);
}
const r1010 = rows.find((r) => r.code === '1010');
check('2.4 1010：三级与链 aA/aB/aC 全部导通', r1010.aA && r1010.aB && r1010.aC,
  `aA=${r1010.aA} aB=${r1010.aB} aC=${r1010.aC}`);
check('2.5 1010：末级逆变器 invD 切断 → 门断电 → 打开', r1010.invD === false && r1010.doorOpen === true,
  `invD=${r1010.invD} doorOpen=${r1010.doorOpen}`);
// 每一位拨错都必须让链断
for (const k of W) {
  const combo = Object.assign({}, CORRECT, { [k]: !CORRECT[k] });
  const code = W.map((x) => (combo[x] ? '1' : '0')).join('');
  const r = rows.find((x) => x.code === code);
  check(`2.6 只拨错 ${k}（${code}）→ 门关闭`, r && r.doorOpen === false, `实测门=${OPEN(r.doorOpen)}`);
}

/* =========================================================================
 * 3. 上电瞬态曲线（0–8s 逐秒）
 * ========================================================================= */
section('3. 上电瞬态（默认即正确密码 1010，0–8s 逐秒采样）');
{
  const e = createEngine();
  loadPreset(e, PRESET);
  const s0 = snap(e);
  const curve = [`t=0.0s  门=${OPEN(s0.doorOpen)}  aA=${s0.aA ? '通' : '断'} aB=${s0.aB ? '通' : '断'} aC=${s0.aC ? '通' : '断'}  invD=${s0.invD ? '通' : '断'}`];
  const samples = [];
  for (let sec = 1; sec <= 8; sec++) {
    runFor(e, 1);
    const s = snap(e);
    samples.push({ t: sec, ...s });
    curve.push(`t=${sec}.0s  门=${OPEN(s.doorOpen)}  aA=${s.aA ? '通' : '断'} aB=${s.aB ? '通' : '断'} aC=${s.aC ? '通' : '断'}  invD=${s.invD ? '通' : '断'}`);
  }
  note(curve.join('\n'));
  const shut = samples.filter((s) => !s.doorOpen).map((s) => `t=${s.t}s`);
  note(`瞬态小结: 上电后门在 [${shut.join(', ') || '无'}] 期间处于关闭，t≥4s 起恒为打开。`);
  // 硬断言只看「稳态」，避免把可优化的上电瞬态钉死成契约
  const steady = samples.filter((s) => s.t >= 4);
  check('3.1 稳态（t=4..8s）门恒为打开', steady.every((s) => s.doorOpen === true),
    steady.map((s) => `${s.t}s=${OPEN(s.doorOpen)}`).join(' '));
  check('3.2 8s 时门打开且 invD 已切断', samples[7].doorOpen === true && samples[7].invD === false,
    JSON.stringify(samples[7]));
  check('3.3 采样点必须避开瞬态：t=1s/2s 处门确实还没稳定（证明 8s 采样是必要的）',
    samples[0].doorOpen === false || samples[1].doorOpen === false,
    `t=1s=${OPEN(samples[0].doorOpen)} t=2s=${OPEN(samples[1].doorOpen)}`);
}

/* =========================================================================
 * 4. 动态交互
 * ========================================================================= */
section('4. 动态交互');
/** 建一个已稳态（正确密码、跑满 8s）的引擎。 */
function steady() {
  const e = build(PRESET, CORRECT);
  runFor(e, 8);
  return e;
}
/** 拨动后返回「门首次变成 SHUT 的时刻（秒）」；未变返回 null。 */
function timeToShut(e, seconds) {
  let hit = null;
  runFor(e, seconds, (eng, t) => {
    if (hit === null && snap(eng).doorOpen === false) hit = t;
  });
  return hit;
}
function timeToOpen(e, seconds) {
  let hit = null;
  runFor(e, seconds, (eng, t) => {
    if (hit === null && snap(eng).doorOpen === true) hit = t;
  });
  return hit;
}

// 4A：稳态下拨错 w2 → 门必须在 ≤5s 内关闭
{
  const e = steady();
  check('4.1 稳态基线：门打开', snap(e).doorOpen === true);
  e.setWallSwitch(idOf('w2'), true);
  const t = timeToShut(e, 5);
  check('4.2 拨错 w2（关→开）后门在 ≤5s 内关闭', t !== null && t <= 5, `首次关闭耗时 ${t === null ? '未关闭!' : t.toFixed(3) + 's'}`);
  check('4.3 拨错 w2 满 5s 后门仍保持关闭', snap(e).doorOpen === false);
  e.setWallSwitch(idOf('w2'), false); // 拨回正确
  const t2 = timeToOpen(e, 5);
  check('4.4 w2 拨回「关」后门在 ≤5s 内重新打开', t2 !== null && t2 <= 5, `重新打开耗时 ${t2 === null ? '未打开!' : t2.toFixed(3) + 's'}`);
  check('4.5 回正满 5s 后门保持打开', snap(e).doorOpen === true);
  note(`4A w2 拨错→关闭耗时 ${t === null ? '∞' : t.toFixed(2)}s；拨回→打开耗时 ${t2 === null ? '∞' : t2.toFixed(2)}s`);
}

// 4B：4 个开关各自单独拨错，都必须能独立关门（证明每一级都不是摆设）
for (const k of W) {
  const e = steady();
  const before = snap(e).doorOpen;
  e.setWallSwitch(idOf(k), !CORRECT[k]);
  const t = timeToShut(e, 5);
  check(`4.6 单独拨错 ${k}（${ON(CORRECT[k])}→${ON(!CORRECT[k])}）能把门关上（≤5s）`,
    before === true && t !== null && t <= 5,
    `拨前门=${OPEN(before)} 首次关闭耗时 ${t === null ? '未关闭!' : t.toFixed(3) + 's'}`);
  check(`4.7 单独拨错 ${k} 满 5s 后门保持关闭`, snap(e).doorOpen === false);
  note(`4B ${k} 单独拨错 → 关门耗时 ${t === null ? '∞' : t.toFixed(2)}s`);
}

// 4C：快速来回拨多次再回正 —— 不许锁死
{
  const e = steady();
  const seq = [];
  for (let i = 0; i < 6; i++) {
    e.setWallSwitch(idOf('w2'), true); runFor(e, 0.3); seq.push('错');
    e.setWallSwitch(idOf('w2'), false); runFor(e, 0.3); seq.push('对');
  }
  for (const k of W) e.setWallSwitch(idOf(k), CORRECT[k]); // 回正
  runFor(e, 8);
  check('4.8 快速来回拨 12 次（0.3s 间隔）后回正，门恢复打开（不锁死）', snap(e).doorOpen === true,
    `末态门=${OPEN(snap(e).doorOpen)}`);
  const s = snap(e);
  check('4.9 回正后链与末级也回到正确配置（aA/aB/aC 通、invD 断）',
    s.aA && s.aB && s.aC && s.invD === false, JSON.stringify(s));
  note(`4C 抖动序列 ${seq.join('→')} 后回正：门=${OPEN(s.doorOpen)}`);
}

/* =========================================================================
 * 5. 技能自带验证器体检（离线仿真 + 几何/结构健康检查）
 * ========================================================================= */
section('5. 技能验证器 sim.mjs 体检');
const vld = runSkillValidator(PRESET, 8);
if (vld.skipped) {
  note('技能验证器未跑：' + vld.reason);
  check('5.0 技能验证器可用', false, vld.reason);
} else if (!vld.report) {
  note('技能验证器输出无法解析（原文前 400 字）：\n' + String(vld.raw).slice(0, 400));
  check('5.0 技能验证器输出可解析', false, '无法解析 JSON 报告');
} else {
  const h = vld.report.health || { errors: [], warnings: [], notes: [] };
  note(`电路 JSON: ${vld.file}`);
  note(`引擎: ${vld.report.engine}`);
  note(`体检: 错误 ${h.errors.length} / 警告 ${h.warnings.length}${h.notes.length ? ' / 提示 ' + h.notes.length : ''}`);
  for (const e of h.errors) note('  ✗ ' + e);
  for (const w of h.warnings) note('  ! ' + w);
  for (const n of h.notes) note('  · ' + n);
  note(`元件 ${vld.report.elements} / 导线 ${vld.report.wires} / 仿真 ${vld.report.seconds}s`);
  check('5.1 体检 0 错误', h.errors.length === 0, h.errors.join('；'));
  check('5.2 体检 0 警告（含「ctrl 悬空」「包围盒明显重叠」「负坐标」）', h.warnings.length === 0, h.warnings.join('；'));
  check('5.3 验证器实收元件 12 个', vld.report.elements === 12, `实测 ${vld.report.elements}`);
  check('5.4 验证器实收导线 17 根（无一根被引擎丢弃）', vld.report.wires === 17, `实测 ${vld.report.wires}`);
  const dt = (vld.report.tracks || {})[idOf('door')];
  note(`验证器门状态时间线: ${(dt || []).map((p) => `${p.t}s→${p.state}`).join('  ')}`);
}

/* =========================================================================
 * 6. 反向验证：故意改坏，断言必须变红
 * ========================================================================= */
section('6. 反向验证（证明断言有牙齿）');
const clonePreset = (p) => structuredClone(p);

// 变体 A：删掉末级 invD，链末级（aC.b）直接接门 → 门逻辑应整体反转
{
  const v = clonePreset(PRESET);
  v.nodes = v.nodes.filter((n) => n.key !== 'invD');
  v.links = v.links.filter((l) => l[0] !== 'invD' && l[2] !== 'invD');
  v.links.push(['aC', 'b', 'door', 'in']);
  const rs = truthTable(v, 8);
  const bad = rs.filter((r) => !r.ok);
  const openC = rs.filter((r) => r.doorOpen).map((r) => r.code);
  check('6.1 变体A（删末级 invD，链尾直连门）→ 真值表被判 FAIL', bad.length > 0,
    `仍判 PASS = 断言没牙齿! 开门组合 [${openC.join(',')}]`);
  const r1010 = rs.find((r) => r.code === '1010');
  check('6.2 变体A 的 1010 组合门=关闭（正是用户抱怨的「门反了」）', r1010 && r1010.doorOpen === false,
    `实测 1010 门=${OPEN(r1010.doorOpen)}`);
  note(`变体A：不符 ${bad.length}/16 组，开门组合 [${openC.join(',')}]，1010 门=${OPEN(r1010.doorOpen)}`);
}

// 变体 B：aA.ctrl 改接 w2.b（第②位不取反）→ 真值表应变化
{
  const v = clonePreset(PRESET);
  const i = v.links.findIndex((l) => l[0] === 'inv2' && l[1] === 'b' && l[2] === 'aA' && l[3] === 'ctrl');
  check('6.3 变体B 基线：存在 inv2.b→aA.ctrl 这根取反线', i >= 0);
  if (i >= 0) v.links[i] = ['w2', 'b', 'aA', 'ctrl'];
  const rs = truthTable(v, 8);
  const bad = rs.filter((r) => !r.ok);
  const openC = rs.filter((r) => r.doorOpen).map((r) => r.code);
  check('6.4 变体B（aA.ctrl 改接 w2.b，不取反）→ 真值表被判 FAIL', bad.length > 0,
    `仍判 PASS = 断言没牙齿! 开门组合 [${openC.join(',')}]`);
  const r1010 = rs.find((r) => r.code === '1010');
  check('6.5 变体B 的 1010 组合不再开门', r1010 && r1010.doorOpen === false, `实测 1010 门=${OPEN(r1010.doorOpen)}`);
  note(`变体B：不符 ${bad.length}/16 组，开门组合 [${openC.join(',')}]，1010 门=${OPEN(r1010.doorOpen)}`);
}

// 变体 C（加码）：旁路 aB（aA.b 直连 aC.a）→ 第③位失效，真值表应变化
{
  const v = clonePreset(PRESET);
  v.links = v.links.filter((l) => !(l[0] === 'aA' && l[1] === 'b' && l[2] === 'aB' && l[3] === 'a')
    && !(l[0] === 'aB' && l[1] === 'b' && l[2] === 'aC' && l[3] === 'a'));
  v.links.push(['aA', 'b', 'aC', 'a']);
  const rs = truthTable(v, 8);
  const bad = rs.filter((r) => !r.ok);
  const openC = rs.filter((r) => r.doorOpen).map((r) => r.code);
  check('6.6 变体C（旁路 aB，w3 失效）→ 真值表被判 FAIL', bad.length > 0,
    `仍判 PASS = 断言没牙齿! 开门组合 [${openC.join(',')}]`);
  note(`变体C：不符 ${bad.length}/16 组，开门组合 [${openC.join(',')}]`);
}

/* =========================================================================
 * 7. 回归：其余 6 个实例未被连坐
 * ========================================================================= */
section('7. 回归：全部 7 个实例');
check('7.0 实例总数仍为 7（实例数没变 → 图鉴 12 卡 / 7 张实例卡不受影响）', PRESETS.length === 7, `实测 ${PRESETS.length}`);
note(`实例列表: ${PRESETS.map((p) => p.id).join(', ')}`);
for (const p of PRESETS) {
  let err = null;
  const e = createEngine();
  try {
    loadPreset(e, p);
    runFor(e, 5);
  } catch (ex) { err = ex; }
  check(`7.1 ${p.id} 载入 + 跑 5s 不抛异常`, !err, err ? String(err && err.message) : '');
  if (err) continue;
  const els = e.getElements();
  const wires = e.getWires();
  check(`7.2 ${p.id} 元件/导线非空`, els.length > 0 && wires.length > 0, `${els.length} 元件 / ${wires.length} 导线`);
  const sErrs2 = structureAudit(p);
  check(`7.3 ${p.id} 结构自检 0 问题`, sErrs2.length === 0, sErrs2.join('；'));
  // 关键观测值
  const obs = [];
  for (const el of els) {
    const v = e.getElementView(el.id);
    if (v.type === 'door') obs.push(`door=${v.open ? 'OPEN' : 'SHUT'}`);
    else if (v.type === 'lamp' || v.type === 'glow_floor') obs.push(`${el.id.replace(p.id + '_', '')}=${v.lit ? '亮' : '灭'}`);
    else if (v.type === 'solar_panel') obs.push(`solar=${v.supplying ? 'SUPPLY' : 'idle'}`);
    else if (DELAY_TYPES.includes(v.type)) obs.push(`${el.id.replace(p.id + '_', '')}=${v.state.conducting ? '通' : '断'}`);
  }
  const badState = els.filter((el) => {
    const v = e.getElementView(el.id);
    if (v.type === 'door') return typeof v.open !== 'boolean';
    if (v.type === 'lamp' || v.type === 'glow_floor') return typeof v.lit !== 'boolean';
    return false;
  });
  check(`7.4 ${p.id} 负载状态均为合法布尔值`, badState.length === 0);
  note(`  ${p.id}: ${els.length} 元件 / ${wires.length} 导线 | t=5s 观测: ${obs.join(' ')}`);
  if (p.id !== PID && existsSync(SKILL_SIM)) {
    const v2 = runSkillValidator(p, 5);
    if (!v2.skipped && v2.report) {
      const h2 = v2.report.health || { errors: [] };
      check(`7.5 ${p.id} 验证器体检 0 错误`, h2.errors.length === 0, h2.errors.join('；'));
      if (h2.warnings && h2.warnings.length) note(`    ${p.id} 验证器警告 ${h2.warnings.length} 条（既有，不阻断）: ${h2.warnings.join('；')}`);
    }
  }
}

/* =========================================================================
 * 7B. 其余 6 个实例的「行为级」回归（不止跑得动，还要跑得对）
 * ========================================================================= */
section('7B. 其余 6 个实例的行为级回归');
{
  // door_auto：无人 → 门通电关闭；玩家走近感应圈 → 1s 后断电打开；走远 → 再关上
  {
    const P = PRESET_BY_ID.door_auto;
    const e = createEngine(); loadPreset(e, P); runFor(e, 3);
    check('7B.1 door_auto 玩家在感应圈外 → 门关闭', e.getElementView('door_auto_door').open === false);
    e.setPlayerPos('door_auto_player', 430, 170); // 站到邻近开关上
    let t = null; runFor(e, 4, (en, tt) => { if (t === null && en.getElementView('door_auto_door').open) t = tt; });
    check('7B.2 door_auto 玩家走近 → ≤3s 内门打开', t !== null && t <= 3, `耗时 ${t === null ? '未打开!' : t.toFixed(3) + 's'}`);
    e.setPlayerPos('door_auto_player', 900, 600);
    let t2 = null; runFor(e, 4, (en, tt) => { if (t2 === null && !en.getElementView('door_auto_door').open) t2 = tt; });
    check('7B.3 door_auto 玩家走远 → ≤3s 内门重新关闭', t2 !== null && t2 <= 3, `耗时 ${t2 === null ? '未关闭!' : t2.toFixed(3) + 's'}`);
    note(`7B door_auto: 走近开门 ${t === null ? '∞' : t.toFixed(2)}s / 走远关门 ${t2 === null ? '∞' : t2.toFixed(2)}s`);
  }
  // marquee_button：未按 → 全灭；按一次 → 信号逐级传递，三灯轮流亮
  {
    const P = PRESET_BY_ID.marquee_button;
    const e = createEngine(); loadPreset(e, P); runFor(e, 2);
    const idle = ['l1', 'l2', 'l3'].map((k) => !!e.getElementView(`marquee_button_${k}`).state.lit);
    check('7B.4 marquee_button 未按按钮时三灯全灭', idle.every((x) => x === false), JSON.stringify(idle));
    e.triggerButton('marquee_button_btn');
    const seen = { l1: false, l2: false, l3: false };
    const masks = [];
    runFor(e, 14, (en) => {
      for (const k of ['l1', 'l2', 'l3']) if (en.getElementView(`marquee_button_${k}`).state.lit) seen[k] = true;
      const m = ['l1', 'l2', 'l3'].map((k) => (en.getElementView(`marquee_button_${k}`).state.lit ? '1' : '0')).join('');
      if (masks[masks.length - 1] !== m) masks.push(m);
    });
    check('7B.5 marquee_button 按一次后三灯都亮过（逐级传递有效）', seen.l1 && seen.l2 && seen.l3, JSON.stringify(seen));
    check('7B.6 marquee_button 灯态确实在轮转（相位变化 ≥6 次）', masks.length >= 6, `相位序列 ${masks.join(' ')}`);
    note(`7B marquee_button 相位序列: ${masks.join(' ')}`);
  }
  // waterfall_inverter：载入即自动循环（约 8s 一周期）
  {
    const P = PRESET_BY_ID.waterfall_inverter;
    const e = createEngine(); loadPreset(e, P);
    const seen = { l1: false, l2: false, l3: false };
    const masks = [];
    runFor(e, 18, (en) => {
      for (const k of ['l1', 'l2', 'l3']) if (en.getElementView(`waterfall_inverter_${k}`).state.lit) seen[k] = true;
      const m = ['l1', 'l2', 'l3'].map((k) => (en.getElementView(`waterfall_inverter_${k}`).state.lit ? '1' : '0')).join('');
      if (masks[masks.length - 1] !== m) masks.push(m);
    });
    check('7B.7 waterfall_inverter 载入即自动跑，三灯都亮过', seen.l1 && seen.l2 && seen.l3, JSON.stringify(seen));
    check('7B.8 waterfall_inverter 相位循环（变化 ≥6 次，且出现全灭与全亮相位）',
      masks.length >= 6 && masks.includes('000') && masks.includes('111'), `相位序列 ${masks.join(' ')}`);
    note(`7B waterfall_inverter 相位序列: ${masks.join(' ')}`);
  }
  // two_way：XOR —— 一开一关 → 灯亮；都开 / 都关 → 灯灭
  {
    const P = PRESET_BY_ID.two_way;
    const litAfter = (a, b) => {
      const e = createEngine(); loadPreset(e, P);
      e.setWallSwitch('two_way_w1', a); e.setWallSwitch('two_way_w2', b);
      runFor(e, 5);
      return !!e.getElementView('two_way_lamp').state.lit;
    };
    check('7B.9 two_way 1/0 → 灯亮', litAfter(true, false) === true);
    check('7B.10 two_way 0/1 → 灯亮', litAfter(false, true) === true);
    check('7B.11 two_way 1/1 → 灯灭（XOR）', litAfter(true, true) === false);
    check('7B.12 two_way 0/0 → 灯灭（XOR）', litAfter(false, false) === false);
    note('7B two_way XOR 表: 1/0=亮 0/1=亮 1/1=灭 0/0=灭');
  }
  // strobe：合上墙壁开关后持续频闪（半周期 ≈1s）
  {
    const P = PRESET_BY_ID.strobe;
    const e = createEngine(); loadPreset(e, P); runFor(e, 3);
    check('7B.13 strobe 墙壁开关断开时灯灭', e.getElementView('strobe_lamp').state.lit === false);
    e.setWallSwitch('strobe_wall', true);
    let flips = 0; let prev = !!e.getElementView('strobe_lamp').state.lit;
    runFor(e, 12, (en) => { const c = !!en.getElementView('strobe_lamp').state.lit; if (c !== prev) { flips++; prev = c; } });
    check('7B.14 strobe 合上后 12s 内闪烁（翻转 ≥8 次）', flips >= 8, `实测翻转 ${flips} 次`);
    note(`7B strobe: 12s 内翻转 ${flips} 次`);
  }
  // solar_day_night：白天供电 / 夜间断电，且切换即时（无 1 秒延迟）
  {
    const P = PRESET_BY_ID.solar_day_night;
    const e = createEngine(); loadPreset(e, P); runFor(e, 1);
    check('7B.15 solar 白天（08:00）灯亮', e.getElementView('solar_day_night_lamp').state.lit === true);
    e.setTimeOfDay(22); e.tick(FIXED_DT);
    check('7B.16 solar 拖到 22:00 → 灯立即熄灭（无 1 秒延迟）', e.getElementView('solar_day_night_lamp').state.lit === false);
    e.setTimeOfDay(12); e.tick(FIXED_DT);
    check('7B.17 solar 拖回 12:00 → 灯立即点亮', e.getElementView('solar_day_night_lamp').state.lit === true);
    note('7B solar_day_night: 08:00=亮 22:00=灭 12:00=亮（即时切换）');
  }
}

/* =========================================================================
 * 8. 桌面壳源码同步（renderer 副本与源码逐字节一致）
 * ========================================================================= */
section('8. 桌面壳 renderer 与源码一致性（MD5）');
{
  const DESK = resolve(ROOT, '..', 'nms-power-sim-desktop', 'renderer', 'js');
  for (const f of ['presets.js', 'engine.js', 'catalog.js']) {
    const a = join(ROOT, 'js', f);
    const b = join(DESK, f);
    if (!existsSync(b)) { note(`  ${f}: 桌面壳副本不存在（${b}）—— 未比对`); check(`8.${f} 存在`, false, b); continue; }
    const ha = createHash('md5').update(readFileSync(a)).digest('hex');
    const hb = createHash('md5').update(readFileSync(b)).digest('hex');
    check(`8.${f} renderer 与源码 MD5 一致`, ha === hb, `源码 ${ha}(${statSync(a).size}B) vs renderer ${hb}(${statSync(b).size}B)`);
    note(`  ${f}: ${ha} ${ha === hb ? '(一致)' : '(不一致!)'}  字节 ${statSync(a).size}/${statSync(b).size}`);
  }
  const pkg = resolve(ROOT, '..', 'nms-power-sim-desktop', 'package.json');
  if (existsSync(pkg)) {
    const v = JSON.parse(readFileSync(pkg, 'utf8')).version;
    check('8.9 桌面壳版本号 == 1.0.12', v === '1.0.12', `实测 ${v}`);
    note(`  nms-power-sim-desktop/package.json version = ${v}`);
  } else {
    note('  桌面壳 package.json 不存在 —— 未核对版本号');
  }
}

/* =========================================================================
 * 汇总
 * ========================================================================= */
console.log('\n=== qa_112_pwddoor 结果 ===');
console.log(`通过 ${results.pass}  失败 ${results.fail}`);
for (const n of results.notes) console.log(n);
if (results.failures.length) {
  console.log('\n[失败明细]');
  for (const f of results.failures) console.log('  ✗ ' + f);
}
console.log(results.fail === 0 ? '\nPWDDOOR_PASS' : '\nPWDDOOR_FAIL');
process.exit(results.fail === 0 ? 0 : 1);

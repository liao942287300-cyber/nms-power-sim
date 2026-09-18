#!/usr/bin/env node
/**
 * tests/qa2_engine_changes_107.mjs — QA Edward 独立终验 1.0.7 · 引擎变更清单机制单测
 * 独立于工程师自测，直接 import js/engine.js 验证 changesLog / getChangesSince 契约：
 *   C1  初始态：getChangesSince(-1) → full=true（从未处理过 → 全量）
 *   C2  addElement：revision 自增、变更集 els 收录该 id、full=false
 *   C3  moveElement 变值：revision 自增、els 收录；同值写回：revision 不变、无新变更
 *   C4  addWire / removeWire：wires 收录；removeElement：els 收录
 *   C5  reset() → full=true（整表失效）
 *   C6  setWireStyle('curve') → full=true
 *   C7  deserialize → full=true
 *   C8  日志裁剪 + stale-base 回退：2100 次变值 move 后，过旧基线 → full=true；
 *       新鲜基线（≥ base）仍可增量聚合
 * 运行： node tests/qa2_engine_changes_107.mjs（无需浏览器）
 */
import { createEngine } from '../js/engine.js';

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}

const e = createEngine();

/* C1 初始态 */
let ch = e.getChangesSince(-1);
ok('C1 getChangesSince(-1) → full=true', ch.full === true, JSON.stringify({ full: ch.full, to: ch.to }));

/* C2 addElement */
let rev0 = e.getRevision();
const lampEl = e.addElement('lamp', { x: 100, y: 100 });
const lamp = lampEl && lampEl.id;
ok('C2pre addElement 返回元件（含 id 字符串）', typeof lamp === 'string' && !!lamp, String(lamp));
let rev1 = e.getRevision();
ok('C2 addElement revision 自增', rev1 > rev0, `${rev0}→${rev1}`);
ch = e.getChangesSince(rev0);
ok('C2a els 收录新元件', !ch.full && ch.els.has(lamp) && ch.wires.size === 0, `els=${[...ch.els]}`);

/* C3 moveElement 变值 / 同值 */
rev0 = e.getRevision();
e.moveElement(lamp, 140, 120);
let rev2 = e.getRevision();
ok('C3 变值 moveElement revision 自增', rev2 === rev0 + 1, `${rev0}→${rev2}`);
ch = e.getChangesSince(rev1);
ok('C3a els 收录被移动元件', !ch.full && ch.els.has(lamp), `els=${[...ch.els]}`);
e.moveElement(lamp, 140, 120);
ok('C3b 同值写回 revision 不变（不触发重建）', e.getRevision() === rev2, `rev=${e.getRevision()}`);
ch = e.getChangesSince(rev2);
ok('C3c 同值写回后无新增变更', !ch.full && ch.els.size === 0 && ch.wires.size === 0,
  `els=${[...ch.els]} wires=${[...ch.wires]}`);

/* C4 wire 增删 + removeElement */
const btnEl = e.addElement('button', { x: 300, y: 100 });
const btn = btnEl && btnEl.id;
rev0 = e.getRevision();
const wObj = e.addWire(btn, 'a', lamp, 'in');
const w = wObj && wObj.id;
ok('C4 addWire 成功', !!w);
ok('C4a addWire wires 收录', e.getChangesSince(rev0).wires.has(w), `wires=${[...e.getChangesSince(rev0).wires]}`);
rev0 = e.getRevision();
e.removeWire(w);
ok('C4b removeWire wires 收录', !e.getChangesSince(rev0).full && e.getChangesSince(rev0).wires.has(w));
rev0 = e.getRevision();
e.removeElement(btn);
ok('C4c removeElement els 收录', !e.getChangesSince(rev0).full && e.getChangesSince(rev0).els.has(btn));

/* C5 reset → full */
e.moveElement(lamp, 200, 200);
e.reset();
ok('C5 reset() 后 getChangesSince(0) → full=true', e.getChangesSince(0).full === true);

/* C6 setWireStyle → full */
const s1 = e.addElement('solar', { x: 0, y: 0 });
const l1 = e.addElement('lamp', { x: 400, y: 0 });
e.addWire(s1, 'out', l1, 'a');
e.getChangesSince(e.getRevision()); // 消费至当前
rev0 = e.getRevision();
ok('C6 setWireStyle("curve") 返回 true', e.setWireStyle('curve') === true);
ch = e.getChangesSince(rev0);
ok('C6a 走线样式切换 → full=true', ch.full === true);

/* C7 deserialize → full */
e.setWireStyle('straight');
e.getChangesSince(e.getRevision());
rev0 = e.getRevision();
const snap = e.serialize();
ok('C7 deserialize(serialize()) 成功', e.deserialize(snap) === true);
ok('C7a deserialize → full=true', e.getChangesSince(rev0).full === true);

/* C8 日志裁剪 + stale-base 回退 full */
// 重建一个小电路，然后 2100 次变值 move（> 2000 触发裁剪，最旧一半被丢弃）
e.reset();
const aEl = e.addElement('solar_panel', { x: 10, y: 10 });
const bEl = e.addElement('lamp', { x: 500, y: 10 });
const a = aEl && aEl.id, b = bEl && bEl.id;
e.addWire(a, 'out', b, 'in');
e.getChangesSince(e.getRevision());
const staleRev = e.getRevision(); // 记录一个将变「过旧」的基线
ok('C8pre staleRev 已记录', staleRev >= 0, `staleRev=${staleRev}`);
let flip = false;
const midRev = (() => { let r = 0; for (let i = 0; i < 2100; i++) { flip = !flip; e.moveElement(a, flip ? 20 : 10, 10); if (i === 1200) r = e.getRevision(); } return r; })();
const chStale = e.getChangesSince(staleRev);
ok('C8 过旧基线 → full=true（stale-base 回退）', chStale.full === true,
  `staleRev=${staleRev} now=${e.getRevision()}`);
const chFresh = e.getChangesSince(midRev);
ok('C8a 新鲜基线仍可增量（full=false 且 els 收录 a）',
  chFresh.full === false && chFresh.els.has(a), `full=${chFresh.full} els=${[...chFresh.els]}`);
const chNow = e.getChangesSince(e.getRevision());
ok('C8b 当前基线 → 空增量', chNow.full === false && chNow.els.size === 0 && chNow.wires.size === 0);
// 越界基线（大于当前 revision）也必须回退 full
ok('C8c 越界基线（rev > 当前）→ full=true', e.getChangesSince(e.getRevision() + 5).full === true);

console.log(`\n===== 结果 =====`);
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
console.log(R.fail === 0 ? 'QA2_ENGINE_CHANGES_PASS' : 'QA2_ENGINE_CHANGES_FAILED');
process.exit(R.fail === 0 ? 0 : 1);

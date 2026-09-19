import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENGINE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim/js/engine.js';
const NEW = 'C:/Users/liao9/Desktop/无人深空素材/moj-scroll-screen.json';
const OLD = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.backup-20260919.json';
const REPORT = 'C:/Users/liao9/WorkBuddy/我的工作1/qa_moj_opt_report.txt';

const { createEngine } = await import(pathToFileURL(ENGINE).href);

// ---------- helpers ----------
const R = 5, C = 32, P = 18; // 5 rows, 32 screen cols, 18-wide cyclic pattern period
function ascii(m) { return m.map(r => r.map(b => b ? '#' : '.').join('')).join('\n'); }
function getMatrix(e) {
  const views = e.getElementViews();
  const m = Array.from({ length: R }, () => Array(C).fill(false));
  for (const v of views) {
    if (v.type === 'lamp') {
      const mm = /^lamp_r(\d+)c(\d+)$/.exec(v.id);
      if (mm) { const r = +mm[1], c = +mm[2]; m[r][c] = !!(v.state && v.state.lit); }
    }
  }
  return m;
}
function loadAndSim(text) {
  const e = createEngine();
  const ok = e.deserialize(text);
  e.triggerButton('scroll_btn');
  const snaps = []; const litTimes = [];
  for (let sec = 0; sec <= 80; sec++) {
    const m = getMatrix(e);
    snaps[sec] = m;
    if (m.some(row => row.some(Boolean))) litTimes.push(sec);
    for (let i = 0; i < 60; i++) e.tick(1 / 60);
  }
  return { e, ok, snaps, litTimes };
}
function eq(a, b) { for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (a[r][c] !== b[r][c]) return false; return true; }
// 18-wide cyclic pattern reconstruction: screen[c] = P[(c - t) mod 18]  =>  P[k] = screen[(k + t) mod 18] exactly.
function reconT(snap, t) {
  const T = Array.from({ length: R }, () => Array(P).fill(false));
  for (let r = 0; r < R; r++) for (let k = 0; k < P; k++) T[r][k] = snap[r][(k + t) % P];
  return T;
}
function tShift(T, s) { const o = Array.from({ length: R }, () => Array(P).fill(false)); for (let r = 0; r < R; r++) for (let k = 0; k < P; k++) o[r][k] = T[r][(k - s + P) % P]; return o; }
function tMirror(T) { const o = Array.from({ length: R }, () => Array(P).fill(false)); for (let r = 0; r < R; r++) for (let k = 0; k < P; k++) o[r][k] = T[r][P - 1 - k]; return o; }
function mirror5(b) { const o = Array.from({ length: 5 }, () => Array(5).fill(false)); for (let r = 0; r < 5; r++) for (let k = 0; k < 5; k++) o[r][k] = b[r][4 - k]; return o; }
function blockAt(T, off) { const b = Array.from({ length: 5 }, () => Array(5).fill(false)); for (let r = 0; r < 5; r++) for (let k = 0; k < 5; k++) b[r][k] = T[r][(off + k) % P]; return b; }
function diff(a, b, rows, cols) { let n = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (a[r][c] !== b[r][c]) n++; return n; }

const results = [];
const log = (s) => results.push(s);
function section(t) { log('\n========== ' + t + ' =========='); }

const newText = readFileSync(NEW, 'utf8');
const oldText = readFileSync(OLD, 'utf8');
const newJson = JSON.parse(newText);
const oldJson = JSON.parse(oldText);
const N = loadAndSim(newText);
const O = loadAndSim(oldText);

// ========== ITEM 1: import integrity ==========
section('ITEM 1: 导入完整性 (NEW file)');
const newBytes = statSync(NEW).size;
const bomOk = Buffer.from(newText, 'utf8')[0] === 0x7b;
log('new json parse OK; elements=' + newJson.elements.length + ' wires=' + newJson.wires.length);
log('new deserialize()=' + N.ok + ' loadedEls=' + N.e.getElements().length + ' loadedWires=' + N.e.getWires().length);
const dupElCnt = newJson.elements.length !== N.e.getElements().length;
const dupWireCnt = newJson.wires.length !== N.e.getWires().length;
log('element count file==engine: ' + (!dupElCnt) + (dupElCnt ? ' MISMATCH(silent drop)' : ''));
log('wire count file==engine: ' + (!dupWireCnt) + (dupWireCnt ? ' MISMATCH(silent drop)' : ''));
const elIds = newJson.elements.map(x => x.id);
const elIdSet = new Set(elIds);
const dupElIds = elIds.length - elIdSet.size;
const wireIds = newJson.wires.map(x => x.id).filter(Boolean);
const dupWireIds = wireIds.length - new Set(wireIds).size;
log('duplicate element ids: ' + dupElIds + (dupElIds ? ' FAIL' : ' OK'));
log('duplicate wire ids: ' + dupWireIds + (dupWireIds ? ' FAIL' : ' OK'));
const connected = new Set();
let badEp = 0;
for (const w of newJson.wires) for (const ep of [w.a, w.b]) { if (!ep || !elIdSet.has(ep.el)) badEp++; else connected.add(ep.el); }
log('wire endpoints referencing missing element ids: ' + badEp + (badEp ? ' FAIL' : ' OK'));
const isolated = elIds.filter(id => !connected.has(id));
log('isolated elements: ' + isolated.length + (isolated.length ? ' FAIL -> ' + JSON.stringify(isolated.slice(0, 20)) : ' OK'));
const item1 = (!dupElCnt && !dupWireCnt && dupElIds === 0 && dupWireIds === 0 && badEp === 0 && isolated.length === 0 && bomOk) ? 'PASS' : 'FAIL';
log('ITEM 1 RESULT: ' + item1);

// ========== ITEM 2: mirror proof (18-period reconstruction) ==========
section('ITEM 2: 镜像已修 (新 == mirror(旧) 允许 18 列循环平移)');
// sanity: reconT must be time-independent
const TN40 = reconT(N.snaps[40], 40), TN50 = reconT(N.snaps[50], 50);
log('reconT time-independence TN40==TN50: ' + (diff(TN40, TN50, R, P) === 0) + ' (diff=' + diff(TN40, TN50, R, P) + ')');
const TO40 = reconT(O.snaps[40], 40), TO50 = reconT(O.snaps[50], 50);
log('reconT time-independence TO40==TO50: ' + (diff(TO40, TO50, R, P) === 0));
const TN = TN40, TO = TO40;
let bestS = -1, mis2 = 1e9;
for (let s = 0; s < P; s++) { const m = diff(TN, tShift(tMirror(TO), s), R, P); if (m < mis2) { mis2 = m; bestS = s; } }
log('TN vs mirror(TO) best cyclic 18-shift=' + bestS + ' mismatches=' + mis2 + '/90');
let misTO = 1e9, bestS_TO = -1;
for (let s = 0; s < P; s++) { const m = diff(TN, tShift(TO, s), R, P); if (m < misTO) { misTO = m; bestS_TO = s; } }
log('TN vs TO best cyclic 18-shift=' + bestS_TO + ' mismatches=' + misTO + '/90 (must be >0 => new != old)');
log('NEW 18-wide pattern:\n' + ascii(TN));
log('OLD 18-wide pattern:\n' + ascii(TO));
log('mirror(OLD) 18-wide pattern:\n' + ascii(tMirror(TO)));
const item2 = (mis2 <= 0 && misTO > 0) ? 'PASS' : (mis2 <= 3 && misTO > 0 ? 'PASS(近似)' : 'FAIL');
log('ITEM 2 RESULT: ' + item2 + ' (new==mirror(old) mis=' + mis2 + ', new!=old mis=' + misTO + ')');

// ========== ITEM 3: glyph orientation (structural, font-independent for J) ==========
section('ITEM 3: 字形朝向 (手写 M/O/J 正向 5x5 模板 + J 结构判定)');
// forward J signature: bottom-LEFT hook (row4 or row3, col0/1 lit) AND right vertical stroke (col4 lit in upper rows)
function hookL(b) { return b[4][0] || b[4][1] || b[3][0] || b[3][1]; }
function strokeR(b) { return b[0][4] || b[1][4] || b[2][4] || b[3][4]; }
// forward J: right-side vertical stroke (col4 lit in >=1 upper row) AND a bottom-LEFT hook,
// with NO bottom-right hook. Mirrored J has the vertical on the left and hook on the right.
function jForward(b) {
  let rightVert = 0, leftVert = 0;
  for (let r = 0; r < 4; r++) { if (b[r][4]) rightVert++; if (b[r][0]) leftVert++; }
  const bl = b[4][0] || b[4][1];   // bottom-left hook
  const br = b[4][3] || b[4][4];   // bottom-right hook (mirrored)
  return rightVert >= 1 && bl && !br;
}
// J is the only left-right-ASYMMETRIC letter (M and O are symmetric). Locate it as the
// columns where the 18-wide pattern differs from its own mirror.
function jColumns(T) {
  const cols = [];
  for (let k = 0; k < P; k++) { let d = 0; for (let r = 0; r < R; r++) if (T[r][k] !== T[r][P - 1 - k]) d++; if (d > 0) cols.push(k); }
  return cols;
}
const TNnat = tShift(TN, 4), TOnat = tShift(TO, 4); // undo reconT +4 phase
log('NATURAL NEW pattern (phase 0, readable):\n' + ascii(TNnat));
log('NATURAL OLD pattern (phase 0):\n' + ascii(TOnat));
const jcN = jColumns(TNnat), jcO = jColumns(TOnat);
log('cols where NEW differs from its own mirror: ' + JSON.stringify(jcN));
log('cols where OLD differs from its own mirror: ' + JSON.stringify(jcO));
// analyze the 3 natural 5-wide letter blocks (off 0,6,12); the most mirror-asymmetric is the J
function mirrorDiff(b) { return diff(b, mirror5(b), 5, 5); }
function blockInfo(T, off) { const b = blockAt(T, off); return { off, block: b, mdiff: mirrorDiff(b), fwd: jForward(b) }; }
for (const label of ['NEW', 'OLD']) {
  const T = label === 'NEW' ? TNnat : TOnat;
  const arr = [0, 6, 12].map(o => blockInfo(T, o));
  for (const x of arr) log('  ' + label + ' off' + x.off + ' mirrorDiff=' + x.mdiff + '/25 forward=' + x.fwd + ':\n' + x.block.map(r => '    ' + r.map(z => z ? '#' : '.').join('')).join('\n'));
  const j = arr.reduce((a, b) => a.mdiff > b.mdiff ? a : b);
  log('  ' + label + ' => J candidate off' + j.off + ' (max mirrorDiff=' + j.mdiff + ', forward=' + j.fwd + ')');
}
const newJ = [0, 6, 12].map(o => blockInfo(TNnat, o)).reduce((a, b) => a.mdiff > b.mdiff ? a : b);
const oldJ = [0, 6, 12].map(o => blockInfo(TOnat, o)).reduce((a, b) => a.mdiff > b.mdiff ? a : b);
// consistency with item2: NEW==mirror(OLD) => newJ block must equal mirror(oldJ block) up to 18-cyclic shift
let jCons = 99; for (let s = 0; s < P; s++) { const m = diff(newJ.block, tShift(mirror5(oldJ.block), s), R, 5); if (m < jCons) jCons = m; }
log('newJ == mirror(oldJ) up to 18-shift? mis=' + jCons + ' (consistency w/ item2)');
const jFwd = newJ.fwd, oldJFwd = oldJ.fwd;
const item3 = (jFwd && !oldJFwd) ? 'PASS' : 'FAIL';
log('ITEM 3 RESULT: ' + item3 + ' (NEW J forward=' + jFwd + ', OLD J forward(mirrored)=' + oldJFwd + ', pattern mirror verified in ITEM2 mis=' + jCons + ')');

// ========== ITEM 4: function unchanged ==========
section('ITEM 4: 功能不变 (NEW, 并与 OLD 对比)');
// a) scroll right 1 col/sec on 32-wide screen, excluding the single wrap-seam column (c=0).
// screen[t+1][c] == screen[t][(c-1) mod 32] holds for c>=1 (only c=0 is the 18-cycle wrap seam).
let scrollMis = 0, scrollN = 0; const badCols = new Set();
for (let t = 30; t <= 55; t++) for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) { scrollN++; if (N.snaps[t + 1][r][c] !== N.snaps[t][r][(c - 1 + C) % C]) { scrollMis++; badCols.add(c); } }
log('a) scroll right 1col/s (cols1..31): mismatches=' + scrollMis + '/' + scrollN + ' badCols=' + JSON.stringify([...badCols]) + (scrollMis === 0 ? ' PASS' : ' FAIL'));
// b) period 18s (temporal, 32-wide)
let perOk = true; for (let t = 30; t <= 50; t++) if (!eq(N.snaps[t + 18], N.snaps[t])) perOk = false;
log('b) period 18s: ' + perOk + (perOk ? ' PASS' : ' FAIL'));
// c) first light
const flN = N.litTimes[0], flO = O.litTimes[0];
log('c) first lit NEW=' + flN + 's OLD=' + flO + 's; need 4..6: ' + (flN >= 4 && flN <= 6 ? 'PASS' : 'FAIL'));
// d) stable within 60s
let stableAt = -1; for (let t = 0; t <= 60; t++) { if (eq(N.snaps[t + 18], N.snaps[t]) && eq(N.snaps[t + 19], N.snaps[t + 1])) { stableAt = t; break; } }
log('d) stable loop at t=' + stableAt + 's (<=60): ' + (stableAt >= 0 && stableAt <= 60 ? 'PASS' : ' FAIL'));
// e) every lamp lights in 80s
const litCount = Array.from({ length: R }, () => Array(C).fill(0));
for (let t = 0; t <= 80; t++) for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (N.snaps[t][r][c]) litCount[r][c]++;
let minLit = 1e9, neverLit = []; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { minLit = Math.min(minLit, litCount[r][c]); if (litCount[r][c] === 0) neverLit.push('r' + r + 'c' + c); }
log('e) every lamp lit in 80s: minLit=' + minLit + ' neverLit=' + neverLit.length + (neverLit.length ? JSON.stringify(neverLit.slice(0, 20)) : '') + (neverLit.length === 0 ? ' PASS' : ' FAIL'));
// function-unchanged cross check: OLD also scrolls right 1col/s (cols1..31)
let oldScrollMis = 0; for (let t = 30; t <= 55; t++) for (let r = 0; r < R; r++) for (let c = 1; c < C; c++) if (O.snaps[t + 1][r][c] !== O.snaps[t][r][(c - 1 + C) % C]) oldScrollMis++;
log('cross: OLD scrolls right 1col/s (mis=' + oldScrollMis + '/4160); NEW==OLD scroll dir & 18s period: ' + (scrollMis === 0 && oldScrollMis === 0 && perOk ? 'SAME' : 'CHECK'));
const item4 = (scrollMis === 0 && perOk && flN >= 4 && flN <= 6 && stableAt >= 0 && stableAt <= 60 && neverLit.length === 0) ? 'PASS' : 'FAIL';
log('ITEM 4 RESULT: ' + item4 + (flN !== flO ? ' (note: first-light NEW=' + flN + ' OLD=' + flO + ', 1s diff, both in 4-6)' : ''));

// ========== ITEM 5: reduction ==========
section('ITEM 5: 精简属实');
log('NEW: elements=' + newJson.elements.length + ' wires=' + newJson.wires.length + ' bytes=' + newBytes);
log('OLD: elements=' + oldJson.elements.length + ' wires=' + oldJson.wires.length + ' bytes=' + statSync(OLD).size);
log('wire reduction: ' + oldJson.wires.length + ' -> ' + newJson.wires.length + ' (delta ' + (newJson.wires.length - oldJson.wires.length) + ')');
const item5 = (newJson.wires.length === 480 && oldJson.wires.length === 620) ? 'PASS' : 'NOTE';

// ========== ITEM 6: encoding ==========
section('ITEM 6: 编码与格式');
const keys = ['version', 'simTime', 'timeOfDay', 'dayCycle', 'wireStyle', 'idSeq', 'wireSeq', 'desc', 'elements', 'wires'];
const miss = keys.filter(k => !(k in newJson));
log('first byte = 0x' + Buffer.from(newText, 'utf8')[0].toString(16) + (bomOk ? ' ({) no BOM OK' : ' FAIL'));
log('missing top-level keys: ' + (miss.length ? JSON.stringify(miss) + ' FAIL' : 'none OK'));
const item6 = (bomOk && miss.length === 0) ? 'PASS' : 'FAIL';

section('SUMMARY');
log('ITEM1 导入完整性: ' + item1);
log('ITEM2 镜像已修: ' + item2);
log('ITEM3 字形朝向(J正向): ' + item3);
log('ITEM4 功能不变: ' + item4);
log('ITEM5 精简属实: ' + item5 + ' (NEW 480 / OLD 620)');
log('ITEM6 编码格式: ' + item6);

writeFileSync(REPORT, results.join('\n'), 'utf8');
writeFileSync('C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim/tests/_qa_done.txt', 'done');

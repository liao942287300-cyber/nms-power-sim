import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENGINE = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim/js/engine.js';
const NEW = 'C:/Users/liao9/Desktop/无人深空素材/moj-scroll-screen.json';
const OLD = 'C:/Users/liao9/WorkBuddy/我的工作1/moj-scroll-screen.backup-20260919.json';
const OUT = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim/tests/_dump.txt';

const { createEngine } = await import(pathToFileURL(ENGINE).href);

function ascii(m) {
  return m.map(r => r.map(b => b ? '#' : '.').join('')).join('\n');
}
function getMatrix(e) {
  const views = e.getElementViews();
  const m = Array.from({length: 5}, () => Array(32).fill(false));
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
  const snaps = [];
  const litTimes = [];
  for (let sec = 0; sec <= 80; sec++) {
    const m = getMatrix(e);
    snaps[sec] = m;
    const anyLit = m.some(row => row.some(Boolean));
    if (anyLit) litTimes.push(sec);
    for (let i = 0; i < 60; i++) e.tick(1 / 60);
  }
  return { e, ok, snaps, litTimes };
}
function info(path) {
  const buf = readFileSync(path, 'utf8');
  const st = statSync(path);
  const first3 = [...Buffer.from(buf, 'utf8').slice(0, 3)].map(b => b.toString(16)).join(',');
  return { bytes: st.size, first3, head: buf.slice(0, 1) };
}

const lines = [];
lines.push('=== FILE INFO ===');
lines.push('NEW ' + JSON.stringify(info(NEW)));
lines.push('OLD ' + JSON.stringify(info(OLD)));

const newText = readFileSync(NEW, 'utf8');
const oldText = readFileSync(OLD, 'utf8');

const newJson = JSON.parse(newText);
const oldJson = JSON.parse(oldText);
lines.push('NEW json elements=' + newJson.elements.length + ' wires=' + newJson.wires.length);
lines.push('OLD json elements=' + oldJson.elements.length + ' wires=' + oldJson.wires.length);

const N = loadAndSim(newText);
const O = loadAndSim(oldText);
lines.push('NEW deserialize=' + N.ok + ' loadedEls=' + N.e.getElements().length + ' loadedWires=' + N.e.getWires().length);
lines.push('OLD deserialize=' + O.ok + ' loadedEls=' + O.e.getElements().length + ' loadedWires=' + O.e.getWires().length);
lines.push('NEW firstLitSec=' + JSON.stringify(N.litTimes.slice(0, 3)));
lines.push('OLD firstLitSec=' + JSON.stringify(O.litTimes.slice(0, 3)));

lines.push('\n=== NEW snapshot sec 40 ===');
lines.push(ascii(N.snaps[40]));
lines.push('\n=== OLD snapshot sec 40 ===');
lines.push(ascii(O.snaps[40]));

lines.push('\n=== NEW scroll sequence sec 38..46 ===');
for (let s = 38; s <= 46; s++) {
  lines.push('--- NEW sec ' + s + ' ---');
  lines.push(ascii(N.snaps[s]));
}
lines.push('\n=== OLD scroll sequence sec 38..46 ===');
for (let s = 38; s <= 46; s++) {
  lines.push('--- OLD sec ' + s + ' ---');
  lines.push(ascii(O.snaps[s]));
}

writeFileSync(OUT, lines.join('\n'), 'utf8');
writeFileSync('C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim/tests/_dump_done.txt', 'done');

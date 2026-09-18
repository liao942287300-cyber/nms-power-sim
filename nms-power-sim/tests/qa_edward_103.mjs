#!/usr/bin/env node
/**
 * tests/qa_edward_103.mjs — QA Edward 独立回归脚本（1.0.3：刚体组移动 + 撤销/重做）
 * 断言全部自行设计、自行计数，与 browser.smoke.mjs 相互独立。
 * 运行前置：http.server 8900 + headless Edge CDP 9222（全新 user-data-dir）。
 * 可选参数：R1 R2 R3（缺省全跑）。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';
const TMP = 'C:/Users/liao9/AppData/Local/Temp';

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
function eq(name, a, b) { return ok(name, Object.is(a, b), `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`); }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
}
async function connect(url) { const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new CDP(ws); }

let page;
const exceptions = [];
async function js(expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const mv = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: o.button ?? 'none', buttons: o.buttons ?? 0, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const down = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: o.button ?? 'left', buttons: o.buttons ?? 1, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const up = (x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: o.button ?? 'left', buttons: 0, clickCount: 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
async function click(x, y, o = {}) { await mv(x, y, o); await down(x, y, o); await sleep(40); await up(x, y, o); await sleep(120); }
async function drag(from, to, steps = 10, o = {}) {
  await mv(from.x, from.y, o); await down(from.x, from.y, o);
  for (let i = 1; i <= steps; i++) { await mv(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { ...o, buttons: o.buttons ?? 1 }); await sleep(12); }
  await up(to.x, to.y, o); await sleep(140);
}
const kd = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
const ku = (k, code, vk, mod = 0) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod });
async function press(k, code, vk, mod = 0) { await kd(k, code, vk, mod); await ku(k, code, vk, mod); await sleep(150); }
const CTRL_Z = () => press('z', 'KeyZ', 90, 2);
const CTRL_Y = () => press('y', 'KeyY', 89, 2);
const ESC = () => press('Escape', 'Escape', 27);
const DEL = () => press('Delete', 'Delete', 46);
async function wheel(x, y, dy) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', pointerType: 'mouse' }); await sleep(40); }

async function readBoard() {
  return js(`
    const b=document.getElementById('board');const r=b.getBoundingClientRect();
    const vg=b.querySelector('g.viewport');let k=1,tx=0,ty=0;
    if(vg){const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)\\s*scale\\(([-\\d.eE+]+)\\)/.exec(vg.getAttribute('transform')||'');if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
    const els=[...b.querySelectorAll('.element')].map(g=>{const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      return {id:g.getAttribute('data-el'),type:(g.getAttribute('class').match(/element-([a-z_]+)/)||[])[1],x:m?+m[1]:0,y:m?+m[2]:0};});
    const sel=[...b.querySelectorAll('.sel-box')].map(s=>s.closest('[data-el]').getAttribute('data-el')).sort();
    const wires=[...b.querySelectorAll('path.wire')].map(w=>w.getAttribute('d'));
    const ports=[...b.querySelectorAll('.port')].map(p=>{const g=p.closest('.element');
      const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      const dot=p.querySelector('.port-dot');
      return {el:p.getAttribute('data-el'),port:p.getAttribute('data-portname'),wx:+m[1]+ +dot.getAttribute('cx'),wy:+m[2]+ +dot.getAttribute('cy')};});
    return {rect:{l:r.left,t:r.top,w:r.width,h:r.height},view:{k,tx,ty},els,sel,wires,ports,
      insp:(document.getElementById('inspector-props')||{}).textContent||'',
      status:[...document.querySelectorAll('#inspector-status .status-row')].map(x=>({id:(x.querySelector('.sr-id')||{}).textContent,st:(x.querySelector('.sr-state')||{}).textContent})),
      tLabel:document.getElementById('time-label').textContent,
      undoDis:document.getElementById('btn-undo')?document.getElementById('btn-undo').disabled:null,
      redoDis:document.getElementById('btn-redo')?document.getElementById('btn-redo').disabled:null};
  `);
}
const w2c = (st, x, y) => ({ x: st.rect.l + st.view.tx + x * st.view.k, y: st.rect.t + st.view.ty + y * st.view.k });
/** 画布可视区中心对应的世界坐标（任意视口下保证屏幕点落在画布内） */
const centerWorld = (st, ox = 0, oy = 0) => ({ x: (st.rect.w / 2 - st.view.tx) / st.view.k + ox, y: (st.rect.h / 2 - st.view.ty) / st.view.k + oy });
const posOf = (st, id) => { const e = st.els.find((x) => x.id === id); return e ? { x: e.x, y: e.y } : null; };
const stateOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).st;
/** 状态面板有 ~120ms 节流：轮询等待目标状态出现，不弱化断言 */
async function waitForState(id, want, timeout = 2500) {
  const t0 = Date.now();
  for (;;) {
    const st = await readBoard();
    if (stateOf(st, id) === want) return { okv: true, st };
    if (Date.now() - t0 > timeout) return { okv: false, st };
    await sleep(120);
  }
}

async function importJSON(obj, tag) {
  const file = `${TMP}/qa_edward_${tag}.json`;
  fs.writeFileSync(file, JSON.stringify(obj));
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(500);
}
const clearCanvas = async () => { await js(`document.getElementById('btn-clear').click();return 1;`); await sleep(250); };
const setView = async (n) => { await js(`document.querySelector('.nav-btn[data-view="${n}"]').click();return 1;`); await sleep(300); };

/* 非网格对齐三元件组 + 网格外元件（用于刚体性验证） */
const R1_CIRCUIT = {
  elements: [
    { id: 'p', type: 'power', x: 121.5, y: 130.25 },
    { id: 's1', type: 'wall_switch', x: 373.5, y: 129.5 },
    { id: 'l', type: 'lamp', x: 601.25, y: 288.75 },
    { id: 's2', type: 'wall_switch', x: 456, y: 456 },
  ],
  wires: [
    { id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 's1', port: 'a' } },
    { id: 'wb', a: { el: 's1', port: 'b' }, b: { el: 'l', port: 'in' } },
  ],
  timeOfDay: 8, dayCycle: false,
};
const snap24 = (v) => Math.round(v / 24) * 24;

/* ====================== R1 刚体组移动（独立断言） ====================== */
async function r1Rigid() {
  console.log('\n===== R1 刚体组移动（含非网格对齐元件） =====');
  await setView('lab'); await clearCanvas();
  await importJSON(R1_CIRCUIT, 'r1');
  let st = await readBoard();
  // R1.0 导入保留非网格原始坐标
  ok('R1.0 导入保留非网格坐标 p(121.5,130.25)', posOf(st, 'p').x === 121.5 && posOf(st, 'p').y === 130.25, JSON.stringify(posOf(st, 'p')));
  ok('R1.0 导入保留非网格坐标 s1(373.5,129.5)', posOf(st, 's1').x === 373.5 && posOf(st, 's1').y === 129.5, JSON.stringify(posOf(st, 's1')));
  ok('R1.0 导入保留非网格坐标 l(601.25,288.75)', posOf(st, 'l').x === 601.25 && posOf(st, 'l').y === 288.75, JSON.stringify(posOf(st, 'l')));

  // 框选前三个（世界 (20,20)-(700,340) 完全包含 p/s1/l，排除 s2(456,456)）
  await drag(w2c(st, 20, 20), w2c(st, 700, 340), 12);
  st = await readBoard();
  eq('R1.1 框选命中 3 个', st.sel.length, 3);
  ok('R1.1 成员恰为 l/p/s1', JSON.stringify(st.sel) === JSON.stringify(['l', 'p', 's1']), JSON.stringify(st.sel));

  // 以 s1 为锚点拖 (+77.5,+51.25)：统一增量 = snap(锚点新位) - 锚点原位
  const pos0 = {}; for (const e of st.els) pos0[e.id] = { x: e.x, y: e.y };
  const wire0 = st.wires.slice();
  await drag(w2c(st, pos0.s1.x, pos0.s1.y), w2c(st, pos0.s1.x + 77.5, pos0.s1.y + 51.25), 12);
  st = await readBoard();
  const pos1 = {}; for (const e of st.els) pos1[e.id] = { x: e.x, y: e.y };
  const ids = ['p', 's1', 'l'];
  const deltas = ids.map((id) => ({ id, dx: pos1[id].x - pos0[id].x, dy: pos1[id].y - pos0[id].y }));
  // 期望增量（按 board.js 实现独立推演）：gx = snap(锚点原位+77.5) - 锚点原位
  const gxE = snap24(pos0.s1.x + 77.5) - pos0.s1.x;
  const gyE = snap24(pos0.s1.y + 51.25) - pos0.s1.y;
  ok(`R1.2 全组统一增量 = 锚点吸附增量 (${gxE},${gyE})`, deltas.every((d) => d.dx === gxE && d.dy === gyE), JSON.stringify(deltas));
  // 两两相对坐标逐对相等（原始像素值，非网格等价值）
  let relOk = true, relBad = '';
  for (let i = 0; i < ids.length && relOk; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    if (pos1[a].x - pos1[b].x !== pos0[a].x - pos0[b].x || pos1[a].y - pos1[b].y !== pos0[a].y - pos0[b].y) {
      relOk = false; relBad = `${a}-${b}: (${pos1[a].x - pos1[b].x},${pos1[a].y - pos1[b].y}) ≠ (${pos0[a].x - pos0[b].x},${pos0[a].y - pos0[b].y})`; break;
    }
  }
  ok('R1.2 组内两两相对坐标移动前后像素级相等', relOk, relBad);
  ok('R1.2 组外 s2 未动', pos1.s2.x === pos0.s2.x && pos1.s2.y === pos0.s2.y, `${pos0.s2.x},${pos0.s2.y} → ${pos1.s2.x},${pos1.s2.y}`);
  // 导线端点跟随统一增量
  const pt = (d) => { const t = d.trim().split(/\s+/); return { x: +t[1], y: +t[2] }; };
  const wA0 = pt(wire0[0]), wA1 = pt(st.wires[0]);
  ok('R1.2 导线端点位移 = 统一增量', wA1.x - wA0.x === gxE && wA1.y - wA0.y === gyE, `(${wA0.x},${wA0.y}) → (${wA1.x},${wA1.y}) 增量(${wA1.x - wA0.x},${wA1.y - wA0.y})`);
  eq('R1.2 导线数量仍 2', st.wires.length, 2);

  // R1.3 单元件拖动仍吸附 24 网格（旧行为不变）
  await ESC();
  const s2p = posOf(st, 's2');
  await click(w2c(st, s2p.x, s2p.y).x, w2c(st, s2p.x, s2p.y).y);
  await drag(w2c(st, s2p.x, s2p.y), w2c(st, s2p.x + 30, s2p.y + 30), 8);
  st = await readBoard();
  const s2n = posOf(st, 's2');
  ok('R1.3 单元件拖动后坐标为 24 网格整数倍', s2n.x % 24 === 0 && s2n.y % 24 === 0, JSON.stringify(s2n));

  // R1.4 网格对齐组拖动：增量仍为网格整数倍（与旧版等价行为）
  await clearCanvas();
  await importJSON({ elements: [{ id: 'a', type: 'lamp', x: 120, y: 120 }, { id: 'b', type: 'lamp', x: 360, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 'r1g');
  st = await readBoard();
  await drag(w2c(st, 20, 20), w2c(st, 450, 240), 10);
  st = await readBoard();
  eq('R1.4 网格组框选 2 个', st.sel.length, 2);
  const a0 = posOf(st, 'a');
  await drag(w2c(st, a0.x, a0.y), w2c(st, a0.x + 50, a0.y + 40), 10);
  st = await readBoard();
  const a1 = posOf(st, 'a'), b1 = posOf(st, 'b');
  ok('R1.4 网格组拖动增量一致且为 24 倍数', (a1.x - a0.x) === (b1.x - 360) && (a1.y - a0.y) === (b1.y - 120) && (a1.x - a0.x) % 24 === 0 && (a1.y - a0.y) % 24 === 0,
    `a:${a0.x},${a0.y}→${a1.x},${a1.y} b→${b1.x},${b1.y}`);
}

/* ====================== R2 撤销 / 重做（独立断言） ====================== */
async function r2UndoRedo() {
  console.log('\n===== R2 撤销 / 重做 =====');
  await setView('lab'); await clearCanvas();
  await importJSON(R1_CIRCUIT, 'r2');

  // R2.0 初始按钮态：均禁用（导入重置历史）
  let st = await readBoard();
  ok('R2.0 导入后撤销/重做按钮均禁用', st.undoDis === true && st.redoDis === true);

  // R2.1 放置→撤销消失→重做回来
  await js(`document.querySelector('.palette-item[data-type="lamp"]').click();return 1;`); await sleep(150);
  await click(w2c(st, 700, 500).x, w2c(st, 700, 500).y); await sleep(200);
  st = await readBoard();
  eq('R2.1 放置后元件 5 个', st.els.length, 5);
  ok('R2.1 放置后撤销可用/重做禁用', st.undoDis === false && st.redoDis === true);
  await CTRL_Z(); st = await readBoard();
  eq('R2.1 Ctrl+Z 撤销放置 → 元件 4 个', st.els.length, 4);
  await CTRL_Y(); st = await readBoard();
  eq('R2.1 Ctrl+Y 重做放置 → 元件 5 个', st.els.length, 5);

  // R2.2 拖动非网格元件→撤销还原原始坐标→重做
  const p0 = posOf(st, 'p');
  await click(w2c(st, p0.x, p0.y).x, w2c(st, p0.x, p0.y).y);
  await drag(w2c(st, p0.x, p0.y), w2c(st, p0.x + 96, p0.y + 48), 10);
  st = await readBoard();
  const p1 = posOf(st, 'p');
  ok('R2.2 单拖 p 已吸附到网格', p1.x % 24 === 0 && p1.y % 24 === 0, JSON.stringify(p1));
  await CTRL_Z(); st = await readBoard();
  ok('R2.2 撤销后 p 还原为非网格原始坐标', posOf(st, 'p').x === p0.x && posOf(st, 'p').y === p0.y, `${posOf(st, 'p').x},${posOf(st, 'p').y} 期望 ${p0.x},${p0.y}`);
  await CTRL_SHIFT_Z(); st = await readBoard();
  ok('R2.2 Ctrl+Shift+Z 重做后位置与拖动后一致', posOf(st, 'p').x === p1.x && posOf(st, 'p').y === p1.y, JSON.stringify(posOf(st, 'p')));
  // 复位：撤销回拖动前
  await CTRL_Z(); await sleep(150);

  // R2.3 批量删除→撤销全回来（含级联导线）→重做再删
  await drag(w2c(st, 20, 20), w2c(st, 700, 340), 12); st = await readBoard();
  eq('R2.3 框选 3 个', st.sel.length, 3);
  eq('R2.3 删除前导线 2 根', st.wires.length, 2);
  await DEL(); await sleep(200); st = await readBoard();
  eq('R2.3 批量删除后元件 2 个', st.els.length, 2);
  eq('R2.3 级联后导线 0 根', st.wires.length, 0);
  await CTRL_Z(); st = await readBoard();
  eq('R2.3 撤销后元件 5 个（含放置的灯）', st.els.length, 5);
  eq('R2.3 撤销后导线 2 根（级联恢复）', st.wires.length, 2);
  await CTRL_Z(); st = await readBoard();
  ok('R2.3 再撤销一次回到拖动前位置', posOf(st, 'p').x === p0.x && posOf(st, 'p').y === p0.y, `p=${posOf(st, 'p').x},${posOf(st, 'p').y} 期望 ${p0.x},${p0.y}`);

  // R2.4 连线→撤销
  st = await readBoard();
  const po = st.ports.find((x) => x.el === 'p' && x.port === 'out');
  const s2a = st.ports.find((x) => x.el === 's2' && x.port === 'a');
  await drag(w2c(st, po.wx, po.wy), w2c(st, s2a.wx, s2a.wy), 10);
  st = await readBoard();
  eq('R2.4 拉线后导线 3 根', st.wires.length, 3);
  await CTRL_Z(); st = await readBoard();
  eq('R2.4 撤销后导线 2 根', st.wires.length, 2);

  // R2.5 simTime 随快照回退（先暂停引擎排除 rAF 连续推进；断言相对量，避免依赖此前累计时长）
  await js(`document.getElementById('btn-run').click();return 1;`); await sleep(150); // 暂停
  st = await readBoard();
  const t0 = parseFloat((st.tLabel.match(/t = ([\d.]+)/) || [])[1]);
  await js(`document.getElementById('btn-step').click();return 1;`); await sleep(150);
  st = await readBoard();
  const t1 = parseFloat((st.tLabel.match(/t = ([\d.]+)/) || [])[1]);
  ok('R2.5 单步后 t 恰好 +1.00', Math.abs(t1 - t0 - 1) < 0.005, `t0=${t0} t1=${t1}`);
  await js(`document.querySelector('.palette-item[data-type="door"]').click();return 1;`); await sleep(150);
  await click(w2c(st, 824, 600).x, w2c(st, 824, 600).y); await sleep(200);
  await js(`document.getElementById('btn-step').click();return 1;`); await sleep(150);
  st = await readBoard();
  const t2 = parseFloat((st.tLabel.match(/t = ([\d.]+)/) || [])[1]);
  ok('R2.5 再单步后 t 又 +1.00', Math.abs(t2 - t1 - 1) < 0.005, `t1=${t1} t2=${t2}`);
  await CTRL_Z(); st = await readBoard();
  const t3 = parseFloat((st.tLabel.match(/t = ([\d.]+)/) || [])[1]);
  ok('R2.5 撤销后 simTime 随快照回退到放置前时刻', Math.abs(t3 - t1) < 0.005, `t3=${t3} 期望≈${t1}`);
  await CTRL_Y(); await sleep(150);
  await js(`document.getElementById('btn-run').click();return 1;`); await sleep(150); // 恢复运行

  // R2.6 历史 51 步上限丢最旧（先清空画布：基座 0 元件；经图鉴「试用」放置，与画布坐标/视口无关）
  await clearCanvas();
  st = await readBoard();
  eq('R2.6 清空后基座 0 元件', st.els.length, 0);
  for (let i = 0; i < 51; i++) {
    await js(`document.querySelector('#catalog-root .el-card[data-type="lamp"] .btn').click();return 1;`);
    if (i % 10 === 0) await sleep(80);
  }
  st = await readBoard();
  eq('R2.6 连放 51 个元件成功', st.els.length, 51);
  for (let i = 0; i < 51; i++) { await CTRL_Z(); if (i % 10 === 0) await sleep(60); }
  st = await readBoard();
  // 栈推演：[snap(清空前6元件), P0..P50] 共 52 条 → 截断 50 → [P1..P50]；
  // 弹尽 50 条后终点 = P1（1 个元件）——清空前状态与 P0 均已被上限丢弃，无法复活。
  eq('R2.6 撤销 51 次后剩 1 个元件（P0 与清空前最旧快照均被上限丢弃）', st.els.length, 1);
  eq('R2.6 撤销栈空 → 撤销按钮禁用', st.undoDis, true);
  ok('R2.6 撤销栈空后重做仍可用', st.redoDis === false);

  // R2.7 导入 JSON 后 Ctrl+Z 不跨文档
  await importJSON({ elements: [{ id: 'x1', type: 'lamp', x: 240, y: 240 }], wires: [], timeOfDay: 8, dayCycle: false }, 'r2imp');
  st = await readBoard();
  eq('R2.7 导入后 1 个元件', st.els.length, 1);
  ok('R2.7 导入后撤销按钮禁用（历史重置）', st.undoDis === true);
  await CTRL_Z(); st = await readBoard();
  eq('R2.7 导入后 Ctrl+Z 无效（不跨文档）', st.els.length, 1);

  // R2.8 清空画布仅一步可撤销
  await clearCanvas();
  st = await readBoard();
  eq('R2.8 清空后 0 元件', st.els.length, 0);
  await CTRL_Z(); st = await readBoard();
  eq('R2.8 撤销清空 → 1 元件恢复', st.els.length, 1);
  await CTRL_Z(); st = await readBoard();
  eq('R2.8 再撤销无效（仅此一步可撤销）', st.els.length, 1);
  ok('R2.8 撤销按钮已禁用', st.undoDis === true);

  // R2.9 模态输入框聚焦 Ctrl+Z 无效
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').focus();return 1;`);
  await CTRL_Z(); st = await readBoard();
  eq('R2.9 输入框聚焦时 Ctrl+Z 不影响画布', st.els.length, 1);
  await ESC();
  ok('R2.9 Esc 关闭命名模态', await js(`return document.getElementById('name-modal').hidden;`));

  // R2.10 撤销后 viewport 不动（放置点取画布可视区中心附近，任意视口下均在屏内）
  st = await readBoard();
  await wheel(st.rect.l + 500, st.rect.t + 300, -120); // 缩放
  st = await readBoard();
  const vBefore = { ...st.view };
  const spot = centerWorld(st, 150, 0); // 中心偏右，避开 x1(240,240)
  await js(`document.querySelector('.palette-item[data-type="lamp"]').click();return 1;`); await sleep(120);
  await click(w2c(st, spot.x, spot.y).x, w2c(st, spot.x, spot.y).y); await sleep(200);
  st = await readBoard();
  eq('R2.10 放置成功（2 元件）', st.els.length, 2);
  await CTRL_Z(); await sleep(200);
  st = await readBoard();
  eq('R2.10 撤销后 1 元件', st.els.length, 1);
  ok('R2.10 撤销后 viewport 不动', st.view.k === vBefore.k && st.view.tx === vBefore.tx && st.view.ty === vBefore.ty,
    `before=${JSON.stringify(vBefore)} after=${JSON.stringify(st.view)}`);

  // R2.11 工具栏按钮禁用态随栈变化
  ok('R2.11 放置撤销后：撤销禁用/重做可用', st.undoDis === true && st.redoDis === false);
  await CTRL_Y(); st = await readBoard();
  ok('R2.11 重做后：撤销可用/重做禁用', st.undoDis === false && st.redoDis === true);
  eq('R2.11 重做后 2 元件', st.els.length, 2);
  await js(`document.getElementById('btn-undo').click();return 1;`); await sleep(200);
  st = await readBoard();
  ok('R2.11 工具栏 ↩ 按钮等效 Ctrl+Z', st.undoDis === true && st.els.length === 1, `els=${st.els.length} undoDis=${st.undoDis}`);
  await js(`document.getElementById('btn-redo').click();return 1;`); await sleep(200);
  st = await readBoard();
  ok('R2.11 工具栏 ↪ 按钮等效 Ctrl+Y', st.redoDis === true && st.els.length === 2, `els=${st.els.length} redoDis=${st.redoDis}`);
}
// Ctrl+Shift+Z
const CTRL_SHIFT_Z = () => press('z', 'KeyZ', 90, 10);

/* ====================== R3 交互矩阵回归（1.0.2 基线要点） ====================== */
async function r3Matrix() {
  console.log('\n===== R3 交互矩阵回归 =====');
  await setView('lab'); await clearCanvas();
  await importJSON(R1_CIRCUIT, 'r3');
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(300); // 视口归位，确保框选区域在屏内
  let st = await readBoard();
  // 建立选择集
  await drag(w2c(st, 20, 20), w2c(st, 700, 340), 12);
  st = await readBoard();
  eq('R3.1 框选 3 个', st.sel.length, 3);
  // 空格平移不破坏选择集/不动元件
  const posA = {}; for (const e of st.els) posA[e.id] = { x: e.x, y: e.y };
  await kd(' ', 'Space', 32);
  await drag({ x: st.rect.l + 400, y: st.rect.t + 300 }, { x: st.rect.l + 510, y: st.rect.t + 250 }, 10);
  st = await readBoard();
  ok('R3.2 空格拖拽平移视图且选择集保持', st.sel.length === 3 && (Math.abs(st.view.tx) > 30 || Math.abs(st.view.ty) > 0), `sel=${st.sel.length} view=${JSON.stringify(st.view)}`);
  const posB = {}; for (const e of st.els) posB[e.id] = { x: e.x, y: e.y };
  ok('R3.2 平移不移动元件', Object.keys(posA).every((id) => posA[id].x === posB[id].x && posA[id].y === posB[id].y));
  await ku(' ', 'Space', 32); await sleep(150);
  // 滚轮缩放选择集保持
  await wheel(st.rect.l + 500, st.rect.t + 300, -140);
  st = await readBoard();
  eq('R3.3 缩放后选择集保持 3 个', st.sel.length, 3);
  // 多选点击电源开关（轮询等待节流面板）
  const pNow = posOf(st, 'p');
  await click(w2c(st, pNow.x, pNow.y).x, w2c(st, pNow.x, pNow.y).y);
  const w1 = await waitForState('p', '已关断');
  ok('R3.4 多选中点击电源 → 已关断', w1.okv, stateOf(w1.st, 'p'));
  await click(w2c(st, pNow.x, pNow.y).x, w2c(st, pNow.x, pNow.y).y);
  const w2 = await waitForState('p', '持续供电');
  ok('R3.4 再点击 → 恢复供电', w2.okv, stateOf(w2.st, 'p'));
  eq('R3.4 电源操作后选择集仍 3 个', (await readBoard()).sel.length, 3);
  // 撤销不跨入「运行态操作」：电源开关不进历史（撤销栈此时为 0——前面操作均未 push）
  st = await readBoard();
  ok('R3.5 运行态开关操作未进撤销历史（撤销禁用）', st.undoDis === true, `undoDis=${st.undoDis}`);
  // 端口拉线 + 右键删线
  st = await readBoard();
  const po = st.ports.find((x) => x.el === 'p' && x.port === 'out');
  const s2a = st.ports.find((x) => x.el === 's2' && x.port === 'a');
  await drag(w2c(st, po.wx, po.wy), w2c(st, s2a.wx, s2a.wy), 10);
  st = await readBoard();
  eq('R3.6 端口拉线 → 3 根导线', st.wires.length, 3);
  // 拉线创建后可撤销（连线进历史）
  await CTRL_Z(); st = await readBoard();
  eq('R3.6 撤销拉线 → 2 根', st.wires.length, 2);
  // 右键选中导线 → Delete 删线
  const wireMid = st.wires[0];
  const nums = wireMid.trim().split(/\s+/).filter((x) => !isNaN(+x));
  const midW = { x: (+nums[0] + +nums[nums.length - 2]) / 2, y: (+nums[1] + +nums[nums.length - 1]) / 2 };
  const mc = w2c(st, midW.x, midW.y);
  await click(mc.x, mc.y, { button: 'right', buttons: 2 });
  await sleep(200);
  await DEL(); st = await readBoard();
  eq('R3.7 右键+Delete 删线（2→1）', st.wires.length, 1);
  await CTRL_Z(); st = await readBoard();
  eq('R3.7 撤销删线恢复（1→2）', st.wires.length, 2);
  // 实例库往返冒烟（确认 onBeforeChange 接线未破坏 1.0.2 功能）
  await js(`localStorage.removeItem('nmsPowerSimLibrary.v1');return 1;`);
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').value='QA103冒烟';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(300);
  eq('R3.8 保存实例入库 1 条', await js(`return JSON.parse(localStorage.getItem('nmsPowerSimLibrary.v1')||'[]').length;`), 1);
  await clearCanvas();
  await js(`document.getElementById('btn-library').click();return 1;`); await sleep(450);
  await js(`[...document.querySelectorAll('#library-list .lib-ops .btn')].find(b=>b.textContent==='载入').click();return 1;`);
  await sleep(700);
  st = await readBoard();
  eq('R3.8 载入实例恢复 4 元件', st.els.length, 4);
  await js(`localStorage.removeItem('nmsPowerSimLibrary.v1');return 1;`);
}

/* ====================== 主流程 ====================== */
const ver = await (await fetch(DEBUG + '/json/version')).json();
const browser = await connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
try {
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 1000, windowState: 'normal' } });
} catch (e) { console.log('· setWindowBounds 失败（忽略）: ' + e.message); }
const list = await (await fetch(DEBUG + '/json/list')).json();
page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
page.on((m) => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('DOM.enable');
const loaded = new Promise((res) => page.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
await page.send('Page.navigate', { url: APP });
await Promise.race([loaded, sleep(8000)]); await sleep(1500);

const sections = process.argv.slice(2);
for (const [name, fn] of [['R1', r1Rigid], ['R2', r2UndoRedo], ['R3', r3Matrix]]) {
  if (sections.length && !sections.includes(name)) continue;
  try { await fn(); } catch (e) { R.fail++; R.failures.push(`[${name}] 抛异常: ${e.message}`); console.log(`[FAIL] [${name}] 抛异常: ${e.message}`); }
}
try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {}

console.log('\n===== 结果 =====');
console.log(`通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) R.failures.forEach((f) => console.log('FAIL:: ' + f));
console.log(R.fail === 0 ? 'QA_EDWARD_PASS' : 'QA_EDWARD_FAILED');
process.exit(R.fail === 0 ? 0 : 1);

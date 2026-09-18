#!/usr/bin/env node
/**
 * tests/qa_eng_drag_107.mjs — 工程师 1.0.7 增量结构更新 · 拖动专项机制自证
 * 前置：http.server 8900（cwd=nms-power-sim）+ headless Edge CDP 9222（同 browser.smoke）。
 *
 * 机制计数自证（svg.__nmsRenderStats = { rebuilds, incremental }）：
 *   D1 大电路导入：376/620 上画布，机制计数器可见（导入走 full 重建 ≥1 次）。
 *   D2 单元件拖拽（带导线）：rebuilds 增量 = 0；incremental 增量 > 0；
 *      元件 transform 更新、关联导线 path d 更新、未拖元件 transform 不变、
 *      非关联导线 d 不变（≤6 条变更，绝非全量 620 条重写）。
 *   D3 长拖拽（≈48 帧窗口）：拖动全期间 rebuilds 增量 = 0（零全量重建），
 *      incremental 逐帧增量生效（Δ ≥ 5）；帧级耗时数字由 profile_interact 提供。
 *   D4 框选批量拖拽：rebuilds 增量 = 0，整组位移一致。
 *   D5 元件放置（palette + 画布点击）：el-add 增量建节点，rebuilds 增量 = 0。
 *   D6 端口拉线 + 右键删除导线：wire-add / wire-remove 增量，rebuilds 增量 = 0。
 *   D7 走线样式切换（直线↔曲线）：走 full 重建（rebuilds 增量 ≥1），几何正确。
 *   D8 全程无页面异常。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const MOJ = path.join(WORKSPACE, 'moj-scroll-screen.json');
const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}

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
const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button ?? 'left', buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, pointerType: 'mouse', modifiers: o.modifiers ?? 0 });
const keyDown = (k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function click(x, y) {
  await mouse('mouseMoved', x, y, { buttons: 0 });
  await mouse('mousePressed', x, y, { buttons: 1 });
  await sleep(30);
  await mouse('mouseReleased', x, y, { buttons: 0 });
  await sleep(120);
}
async function drag(from, to, steps = 12, stepMs = 10) {
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
  await mouse('mousePressed', from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1 });
    await sleep(stepMs);
  }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  await sleep(120);
}

/* ---- 机制计数 / 画布状态 ---- */
const readStats = () => js(`
  const s=document.getElementById('board') && document.getElementById('board').__nmsRenderStats;
  return s ? { rebuilds:s.rebuilds, incremental:s.incremental } : null;`);
const READ_BOARD = `
  const board=document.getElementById('board');const r=board.getBoundingClientRect();
  const vg=board.querySelector('g.viewport');let k=1,tx=0,ty=0;
  if(vg){const t=vg.getAttribute('transform')||'';const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)\\s*scale\\(([-\\d.]+)\\)/.exec(t);if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
  const els=[...board.querySelectorAll('.element')].map(g=>{
    const m=/translate\\(([-\\d.]+)[ ,]([-=\\d.]+)\\)/.exec(g.getAttribute('transform')||'');
    return {id:g.getAttribute('data-el'),x:m?+m[1]:0,y:m?+m[2]:0};});
  return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},view:{k,tx,ty},els};`;
const boardState = () => js(READ_BOARD);
const w2c = (st, x, y) => ({ x: st.rect.left + st.view.tx + x * st.view.k, y: st.rect.top + st.view.ty + y * st.view.k });
const wireCount = () => js(`return document.querySelectorAll('#board path.wire').length;`);
const wireDs = () => js(`return [...document.querySelectorAll('#board path.wire')].map(p=>p.getAttribute('d'));`);
/** 有 transform 变化的元件数（对照两份 boardState）。 */
const movedEls = (a, b) => {
  const map = new Map(a.els.map((e) => [e.id, e]));
  let n = 0;
  for (const e of b.els) { const p = map.get(e.id); if (p && (p.x !== e.x || p.y !== e.y)) n++; }
  return n;
};
const diffCount = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

/** 空格+拖拽平移一次（与 qa_edward_105_big 同款，带方向反馈校正）。 */
async function panBy(dx, dy) {
  const before = (await boardState()).view;
  const st = await boardState();
  const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
  await keyDown(' ', 'Space', 32); await sleep(80);
  await drag({ x: cx, y: cy }, { x: cx + dx, y: cy + dy }, 10);
  await keyUp(' ', 'Space', 32); await sleep(250);
  const after = (await boardState()).view;
  return { dx: after.tx - before.tx, dy: after.ty - before.ty };
}
async function panToView(tx, ty) {
  let flipX = false, flipY = false;
  for (let i = 0; i < 5; i++) {
    const v = (await boardState()).view;
    const dx = tx - v.tx, dy = ty - v.ty;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return true;
    const ix = flipX ? -dx : dx, iy = flipY ? -dy : dy;
    const got = await panBy(ix, iy);
    if (Math.abs(got.dx) > 1) flipX = Math.sign(got.dx) !== Math.sign(ix);
    if (Math.abs(got.dy) > 1) flipY = Math.sign(got.dy) !== Math.sign(iy);
  }
  const v = (await boardState()).view;
  return Math.abs(v.tx - tx) < 6 && Math.abs(v.ty - ty) < 6;
}
/** 滚轮放大 n 档（供端口级精度操作用）；anchor 可指定缩放锚点（默认画布中心）。 */
async function zoomIn(n, anchor = null) {
  const st = await boardState();
  const cx = anchor ? anchor.x : st.rect.left + st.rect.width / 2;
  const cy = anchor ? anchor.y : st.rect.top + st.rect.height / 2;
  for (let i = 0; i < n; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120, button: 'none', pointerType: 'mouse' });
    await sleep(40);
  }
  await sleep(250);
}

async function importMoj() {
  const file = 'C:/Users/liao9/AppData/Local/Temp/qa107_moj.json';
  fs.copyFileSync(MOJ, file);
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(900);
}

/** 在画布中心附近找一个不与任何元件/端口重叠的屏幕点（放置用）。
 *  以画布中心为基准在 ±200px 盒内网格扫描，保证放大后元件仍留在画布视口内；
 *  ref/minDist 可选：要求与参考点距离 ≥ minDist（为 D6 找相距足够远的两个点）。 */
async function findFreeSpot(offsetIndex = 0, ref = null, minDist = 0) {
  return js(`
    const board=document.getElementById('board');const r=board.getBoundingClientRect();
    const cx0=r.left+r.width/2, cy0=r.top+r.height/2;
    const ref=${ref ? JSON.stringify(ref) : 'null'};const minDist=${minDist};
    for(let attempt=0;attempt<90;attempt++){
      const i=attempt+${offsetIndex}*11;
      const x=cx0-200+((i%9)*44), y=cy0-200+Math.floor(i/9)*44;
      if(ref && Math.hypot(x-ref.x,y-ref.y)<minDist) continue;
      const under=document.elementFromPoint(x,y);
      if(!under || !under.closest('[data-el],[data-port]')) return {x,y};
    } return null;`);
}

/** 屏幕点微调吸附：在 ±10px 网格内找一个 elementFromPoint 命中指定元件端口的点。 */
async function snapToPort(elId, sx, sy) {
  return js(`
    const want=${JSON.stringify(elId)};const sx=${sx},sy=${sy};
    for(let dy=-10;dy<=10;dy+=2){for(let dx=-10;dx<=10;dx+=2){
      const under=document.elementFromPoint(sx+dx,sy+dy);
      const p=under&&under.closest?under.closest('[data-port]'):null;
      if(p&&p.getAttribute('data-el')===want) return {x:sx+dx,y:sy+dy,found:true};
    }}
    return {found:false};`);
}

/** 读元件两个端口的屏幕坐标（世界端口位置 → 视口映射）：见 D6 内联实现。 */

async function main() {
  const ver = await (await fetch(`${DEBUG}/json/version`)).json();
  console.log('  · CDP 端点：' + ver.Browser);
  const created = await (await fetch(`${DEBUG}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const list = await (await fetch(`${DEBUG}/json/list`)).json();
  const tab = created || list.find((t) => t.type === 'page');
  page = await connect(tab.webSocketDebuggerUrl);
  page.on((m) => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(2000);

  /* ---- D1 导入 + 机制计数器可见 ---- */
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  await importMoj();
  let st = await boardState();
  ok('D1 大电路导入：元件 376', st.els.length === 376, `实际 ${st.els.length}`);
  ok('D1a 导线 620 全部渲染', (await wireCount()) === 620);
  const s0 = await readStats();
  ok('D1b 机制计数器 svg.__nmsRenderStats 可见', !!s0, JSON.stringify(s0));
  ok('D1c 导入走 full 重建（rebuilds ≥ 1）', !!s0 && s0.rebuilds >= 1, JSON.stringify(s0));
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(400);
  await panToView(-15, 40);

  /* ---- D2 单元件拖拽（带导线）：增量路径，零全量重建 ---- */
  st = await boardState();
  const lamp0 = st.els.find((e) => e.id === 'lamp_r0c0');
  ok('D2pre lamp_r0c0 存在', !!lamp0);
  const c0 = w2c(st, lamp0.x, lamp0.y);
  const statsBefore = await readStats();
  const dsBefore = await wireDs();
  const elsBefore = st;
  const tD2 = Date.now();
  await drag(c0, { x: c0.x + 48, y: c0.y + 36 }, 14);
  const dD2ms = Date.now() - tD2;
  const statsAfter = await readStats();
  const dsAfter = await wireDs();
  st = await boardState();
  const lamp0b = st.els.find((e) => e.id === 'lamp_r0c0');
  const dRebuilds2 = statsAfter.rebuilds - statsBefore.rebuilds;
  ok('D2 拖拽期间 rebuilds 增量 = 0（零全量重建）', dRebuilds2 === 0,
    `Δrebuilds=${dRebuilds2} stats=${JSON.stringify(statsAfter)}`);
  ok('D2a incremental 增量 > 0（走了增量结构更新）',
    statsAfter.incremental - statsBefore.incremental > 0,
    `Δincremental=${statsAfter.incremental - statsBefore.incremental}`);
  ok('D2b 元件位置已更新', lamp0b.x !== lamp0.x || lamp0b.y !== lamp0.y,
    `(${lamp0.x},${lamp0.y})→(${lamp0b.x},${lamp0b.y})`);
  ok('D2c 仅拖拽元件位移（其他元件 transform 不变）', movedEls(elsBefore, st) === 1,
    `moved=${movedEls(elsBefore, st)}`);
  const nChanged = diffCount(dsBefore, dsAfter);
  ok('D2d 关联导线 d 已更新且无关节点不重写（1 ≤ 变更 ≤ 6）', nChanged >= 1 && nChanged <= 6,
    `Δd=${nChanged}/620`);
  ok('D2e 结构规模不变（376/620）', st.els.length === 376 && dsAfter.length === 620,
    `els=${st.els.length} wires=${dsAfter.length}`);
  ok('D2f 拖拽耗时 < 1.5s（14 步手势）', dD2ms < 1500, `${dD2ms}ms`);

  /* ---- D3 长拖拽（拖动全期间 rebuilds 增量 = 0，逐帧增量生效） ---- */
  const c1 = w2c(st, lamp0b.x, lamp0b.y);
  const statsBefore3 = await readStats();
  // 50 步、16ms/步 ≈ 800ms 拖拽窗口（≈48 帧），结束后以机制计数器为真相
  await drag(c1, { x: c1.x + 60, y: c1.y + 40 }, 50, 16);
  const statsAfter3 = await readStats();
  // 拖拽已结束，改为统计「拖拽窗口内」重建：计数器即真相
  const dRebuilds3 = statsAfter3.rebuilds - statsBefore3.rebuilds;
  ok('D3 50 步长拖拽 rebuilds 增量 = 0', dRebuilds3 === 0,
    `Δrebuilds=${dRebuilds3} stats=${JSON.stringify(statsAfter3)}`);
  ok('D3a 长拖拽 incremental 增量 ≥ 5（逐帧增量生效）',
    statsAfter3.incremental - statsBefore3.incremental >= 5,
    `Δincremental=${statsAfter3.incremental - statsBefore3.incremental}`);

  /* ---- D4 框选批量拖拽 ---- */
  await js(`const b=document.activeElement;b&&b.blur&&b.blur();return 1;`);
  await keyDown('Escape', 'Escape', 27); await keyUp('Escape', 'Escape', 27); await sleep(150);
  st = await boardState();
  const statsBefore4 = await readStats();
  await drag(w2c(st, 64, 60), w2c(st, 640, 430));
  const nSel = await js(`return document.querySelectorAll('#board .sel-box').length;`);
  ok('D4 框选命中 ≥ 40', nSel >= 40, `实际 ${nSel}`);
  const pick = ['lamp_r0c0', 'lamp_r2c5', 'lamp_r4c10'];
  const posOf = (s, id) => { const e = s.els.find((x) => x.id === id); return e ? { x: e.x, y: e.y } : null; };
  const before4 = {}; for (const id of pick) before4[id] = posOf(st, id);
  await drag(w2c(st, 340, 244), w2c(st, 388, 292));
  const statsAfter4 = await readStats();
  st = await boardState();
  const deltas = pick.map((id) => { const p = posOf(st, id); const b = before4[id]; return { dx: p.x - b.x, dy: p.y - b.y }; });
  ok('D4a 组拖整组位移一致（非零）',
    deltas.every((d) => Math.abs(d.dx - deltas[0].dx) < 0.01 && Math.abs(d.dy - deltas[0].dy) < 0.01)
      && (deltas[0].dx !== 0 || deltas[0].dy !== 0), JSON.stringify(deltas));
  ok('D4b 组拖期间 rebuilds 增量 = 0',
    statsAfter4.rebuilds - statsBefore4.rebuilds === 0,
    `Δrebuilds=${statsAfter4.rebuilds - statsBefore4.rebuilds}`);

  /* ---- D5 元件放置：el-add 增量建节点 ---- */
  const statsBefore5 = await readStats();
  const elsBefore5 = st.els.length;
  await js(`document.querySelector('.palette-item[data-type="lamp"]').click();return 1;`); await sleep(150);
  const spot1 = await findFreeSpot(0);
  ok('D5pre 找到空闲放置点 1', !!spot1, JSON.stringify(spot1));
  await click(spot1.x, spot1.y); await sleep(200);
  // 第二盏灯与第一盏相距 ≥ 300 屏幕像素，保证端口互不遮挡
  const spot2 = await findFreeSpot(1, spot1, 300);
  await js(`document.querySelector('.palette-item[data-type="lamp"]').click();return 1;`); await sleep(150);
  ok('D5pre2 找到空闲放置点 2（距点 1 ≥ 300px）', !!spot2, JSON.stringify(spot2));
  await click(spot2.x, spot2.y); await sleep(200);
  st = await boardState();
  const statsAfter5 = await readStats();
  ok('D5 放置 2 灯：元件数 +2', st.els.length === elsBefore5 + 2, `${elsBefore5}→${st.els.length}`);
  ok('D5a 放置走增量（rebuilds 增量 = 0）', statsAfter5.rebuilds - statsBefore5.rebuilds === 0,
    `Δrebuilds=${statsAfter5.rebuilds - statsBefore5.rebuilds}`);
  ok('D5b incremental 增量 ≥ 2', statsAfter5.incremental - statsBefore5.incremental >= 2,
    `Δincremental=${statsAfter5.incremental - statsBefore5.incremental}`);

  /* ---- D6 端口拉线 + 右键删除导线：wire-add / wire-remove 增量 ---- */
  // 放大获得端口命中精度（port-hit r=12 世界单位），再平移使两灯居中于画布
  const midAnchor = { x: (spot1.x + spot2.x) / 2, y: (spot1.y + spot2.y) / 2 };
  await zoomIn(3, midAnchor);
  st = await boardState();
  // 新增的两盏灯 = 画布上 id 最新的两个 .element（data-el 由引擎生成 lamp_<seq>）
  const newIds = await js(`
    const ids=[...document.querySelectorAll('#board .element')].map(g=>g.getAttribute('data-el'));
    return ids.slice(-2);`);
  ok('D6pre 取到两个新放置灯 id', newIds.length === 2, JSON.stringify(newIds));
  const readElemW = async (id) => js(`
    const g=document.querySelector('[data-el="${id}"]');
    const m=/translate\\(([-\\d.]+)[ ,]([-\\d.]+)\\)/.exec(g.getAttribute('transform'));
    return {wx:+m[1],wy:+m[2],ports:[...g.querySelectorAll('.port-dot')].map(d=>({x:+d.getAttribute('cx'),y:+d.getAttribute('cy')}))};`);
  // 平移：让两灯的世界中点落在画布中心（拖拽平移不改结构，机制计数不受影响）
  const wA0 = await readElemW(newIds[0]);
  const wB0 = await readElemW(newIds[1]);
  const M = { wx: (wA0.wx + wB0.wx) / 2, wy: (wA0.wy + wB0.wy) / 2 };
  await panToView(st.rect.width / 2 - M.wx * st.view.k, st.rect.height / 2 - M.wy * st.view.k);
  st = await boardState();
  const pA = await readElemW(newIds[0]);
  const pB = await readElemW(newIds[1]);
  // 从 A 距 B 最近的端口拉到 B 距 A 最近的端口
  const nearA = pA.ports.reduce((b, p) => (Math.hypot(pA.wx + p.x - pB.wx, pA.wy + p.y - pB.wy) < Math.hypot(pA.wx + b.x - pB.wx, pA.wy + b.y - pB.wy) ? p : b));
  const nearB = pB.ports.reduce((b, p) => (Math.hypot(pB.wx + p.x - pA.wx, pB.wy + p.y - pA.wy) < Math.hypot(pB.wx + b.x - pA.wx, pB.wy + b.y - pA.wy) ? p : b));
  const from0 = w2c(st, pA.wx + nearA.x, pA.wy + nearA.y);
  const to0 = w2c(st, pB.wx + nearB.x, pB.wy + nearB.y);
  // 端口命中校验 + 微调吸附（确保手势起点/终点确实落在端口热区上）
  const from = await snapToPort(newIds[0], from0.x, from0.y);
  const to = await snapToPort(newIds[1], to0.x, to0.y);
  ok('D6pre 起点/终点均命中端口热区', !!from && from.found && !!to && to.found,
    `from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
  const wiresBefore6 = await wireCount();
  const statsBefore6 = await readStats();
  await drag(from, to, 10);
  const wiresAfter6 = await wireCount();
  const statsAfter6 = await readStats();
  ok('D6 拉线成功：导线数 +1', wiresAfter6 === wiresBefore6 + 1, `${wiresBefore6}→${wiresAfter6}`);
  ok('D6a wire-add 走增量（rebuilds 增量 = 0）', statsAfter6.rebuilds - statsBefore6.rebuilds === 0,
    `Δrebuilds=${statsAfter6.rebuilds - statsBefore6.rebuilds}`);
  // 右键选中导线 → Delete 删除
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  await mouse('mouseMoved', mid.x, mid.y, { buttons: 2 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await sleep(40);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'right', buttons: 0, pointerType: 'mouse' });
  await sleep(200);
  const statsBefore6b = await readStats();
  await keyDown('Delete', 'Delete', 46); await keyUp('Delete', 'Delete', 46); await sleep(250);
  const wiresAfter6b = await wireCount();
  const statsAfter6b = await readStats();
  ok('D6b Delete 删除导线：导线数还原', wiresAfter6b === wiresBefore6, `${wiresAfter6}→${wiresAfter6b}`);
  ok('D6c wire-remove 走增量（rebuilds 增量 = 0）', statsAfter6b.rebuilds - statsBefore6b.rebuilds === 0,
    `Δrebuilds=${statsAfter6b.rebuilds - statsBefore6b.rebuilds}`);

  /* ---- D7 走线样式切换：full 重建口径（正确性优先） ---- */
  const statsBefore7 = await readStats();
  await js(`const b=document.querySelector('.wire-style-btn[data-style="curve"]');b&&b.click();return 1;`); await sleep(300);
  const statsMid7 = await readStats();
  const hasCurveD = await js(`return [...document.querySelectorAll('#board path.wire')].some(p=>(p.getAttribute('d')||'').indexOf('C')>=0);`);
  ok('D7 曲线模式：full 重建（rebuilds 增量 ≥ 1）', statsMid7.rebuilds - statsBefore7.rebuilds >= 1,
    `Δrebuilds=${statsMid7.rebuilds - statsBefore7.rebuilds}`);
  ok('D7a 曲线几何生效（path d 含三次贝塞尔 C 指令）', hasCurveD === true);
  await js(`const b=document.querySelector('.wire-style-btn[data-style="straight"]');b&&b.click();return 1;`); await sleep(300);
  const statsAfter7 = await readStats();
  ok('D7b 切回直线：再次 full 重建（rebuilds 增量 ≥ 2 累计）', statsAfter7.rebuilds - statsBefore7.rebuilds >= 2,
    `Δrebuilds=${statsAfter7.rebuilds - statsBefore7.rebuilds}`);
  const straightBack = await js(`return [...document.querySelectorAll('#board path.wire')].every(p=>(p.getAttribute('d')||'').indexOf('C')<0);`);
  ok('D7c 直线几何还原', straightBack === true);

  /* ---- D8 全程无页面异常 ---- */
  ok('D8 全程无页面异常', exceptions.length === 0, exceptions.slice(0, 3).join('|'));

  try { await fetch(`${DEBUG}/json/close/${tab.id}`); } catch { /* ignore */ }
}

main().then(() => {
  console.log(`\n===== 结果 =====`);
  console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
  if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
  console.log(R.fail === 0 ? 'QA_107_DRAG_PASS' : 'QA_107_DRAG_FAILED');
  process.exit(R.fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('DRAG_107_ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});

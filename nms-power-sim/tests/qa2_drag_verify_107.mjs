#!/usr/bin/env node
/**
 * tests/qa2_drag_verify_107.mjs — QA Edward 独立终验 1.0.7 · 增量渲染机制自证（独立实现）
 * 前置：http.server 8900（cwd=项目父目录）+ headless Edge CDP 9222。
 *
 * 与工程师 qa_eng_drag_107.mjs 独立：测试对象/断言口径自行推导。
 *   V1  导入 moj-scroll-screen.json：376 元件 / 620 导线，机制计数器可见，导入 ≥1 次 full 重建。
 *   V2  单元件拖拽（从 JSON 邻接表独立选取度数 2~4 的元件）：
 *       Δrebuilds=0、Δincremental>0、恰好该元件的邻接导线 d 被重写（620 条中精确匹配
 *       变更索引集合 = 邻接导线索引集合）、其余 375 个元件 transform 全部不变。
 *   V3  零位移「拖拽」（按下即抬起）：Δrebuilds=0 且 Δincremental=0（同值写回不触发渲染）。
 *   V4  框选批量拖拽：Δrebuilds=0，整组位移一致，导线总数不变。
 *   V5  直线↔曲线切换：走 full 重建（Δrebuilds ≥ 1），曲线 d 含 C 指令、切回后还原。
 *   V6  全程无页面异常、导线数始终 620。
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

/* ---- 从 JSON 独立构建邻接表（不依赖页面内引擎） ---- */
const moj = JSON.parse(fs.readFileSync(MOJ, 'utf8'));
const adj = new Map(); // elId -> Set(wireIndex)
moj.wires.forEach((w, i) => {
  for (const end of [w.a, w.b]) {
    if (!adj.has(end.el)) adj.set(end.el, new Set());
    adj.get(end.el).add(i);
  }
});
// 选取度数 2~4 的元件（排除工程师用过的 lamp_r0c0，保持独立性）
const CANDIDATES = moj.elements.filter((e) => {
  const d = (adj.get(e.id) || new Set()).size;
  return d >= 2 && d <= 4 && e.id !== 'lamp_r0c0';
}).map((e) => e.id);

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
async function drag(from, to, steps = 12, stepMs = 10, modifiers = 0) {
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, modifiers });
  await mouse('mousePressed', from.x, from.y, { buttons: 1, modifiers });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1, modifiers });
    await sleep(stepMs);
  }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0, modifiers });
  await sleep(150);
}

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
const wireDs = () => js(`return [...document.querySelectorAll('#board path.wire')].map(p=>p.getAttribute('d'));`);
const wireCount = () => js(`return document.querySelectorAll('#board path.wire').length;`);
const diffIdx = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
async function panBy(dx, dy) {
  const before = (await boardState()).view;
  // 1.0.9：空格不再是平移修饰键——优先「空白处左键拖动 = 平移」；
  // 密集电路（376 元件）无可拖动空白时回退「中键拖动 = 平移」（1.0.9 保留该手势）。
  const bp = await js(`const b=document.getElementById('board');const r=b.getBoundingClientRect();
    for(let fy=0.12;fy<=0.94;fy+=0.06)for(let fx=0.08;fx<=0.94;fx+=0.06){const x=r.left+r.width*fx,y=r.top+r.height*fy;
    const el=document.elementFromPoint(x,y);if(el&&!(el.closest&&el.closest('[data-el]'))&&(el===b||b.contains(el)))return {x,y};}
    return null;`);
  if (bp) {
    await drag(bp, { x: bp.x + dx, y: bp.y + dy }, 10);
  } else {
    const st = await boardState();
    const cx = st.rect.left + st.rect.width / 2, cy = st.rect.top + st.rect.height / 2;
    await mouse('mouseMoved', cx, cy, { buttons: 0, button: 'middle' });
    await mouse('mousePressed', cx, cy, { buttons: 4, button: 'middle' });
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', cx + dx * i / 10, cy + dy * i / 10, { buttons: 4, button: 'middle' }); await sleep(10); }
    await mouse('mouseReleased', cx + dx, cy + dy, { buttons: 0, button: 'middle' });
  }
  await sleep(220);
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
async function importMoj() {
  const file = 'C:/Users/liao9/AppData/Local/Temp/qa2_107_moj.json';
  fs.copyFileSync(MOJ, file);
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [file], nodeId });
  await sleep(900);
}

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

  /* ---- V1 导入 ---- */
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  await importMoj();
  let st = await boardState();
  ok('V1 导入元件 376', st.els.length === 376, `实际 ${st.els.length}`);
  ok('V1a 导线 620', (await wireCount()) === 620);
  const s0 = await readStats();
  ok('V1b 机制计数器可见', !!s0, JSON.stringify(s0));
  ok('V1c 导入 ≥1 次 full 重建', !!s0 && s0.rebuilds >= 1);
  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(400);
  await panToView(-15, 40);
  st = await boardState();

  /* ---- V2 单元件拖拽：精确邻接导线集合重写 ---- */
  const diag = { candCount: CANDIDATES.length, candHead: CANDIDATES.slice(0, 8), panRet: [], views: [] };
  // 先扫当前视口；找不到则平移到候选群中心再扫（最多 3 轮）
  const margin = 60;
  let targetId = null;
  for (let attempt = 0; attempt < 3 && !targetId; attempt++) {
    st = await boardState();
    for (const id of CANDIDATES) {
      const p = st.els.find((x) => x.id === id);
      if (!p) continue;
      const c = w2c(st, p.x, p.y);
      if (c.x > st.rect.left + margin && c.x < st.rect.left + st.rect.width - margin
        && c.y > st.rect.top + margin && c.y < st.rect.top + st.rect.height - margin) { targetId = id; break; }
    }
    diag.views.push(JSON.stringify(st.view));
    if (!targetId) {
      const p0 = st.els.find((x) => x.id === CANDIDATES[0]);
      if (!p0) break;
      diag.panRet.push(await panToView(st.rect.width / 2 - p0.x * st.view.k, st.rect.height / 2 - p0.y * st.view.k));
    }
  }
  st = await boardState();
  ok('V2pre 找到可见候选元件（度数 1~6）', !!targetId, `target=${targetId} diag=${JSON.stringify(diag)}`);
  if (!targetId) throw new Error('无可见候选元件，无法继续 V2');
  const expectIdx = [...(adj.get(targetId) || new Set())];
  const elPos = st.els.find((x) => x.id === targetId);
  const c0 = w2c(st, elPos.x, elPos.y);
  const statsBefore = await readStats();
  const dsBefore = await wireDs();
  const elsBefore = st.els;
  await drag(c0, { x: c0.x + 56, y: c0.y + 40 }, 14);
  const statsAfter = await readStats();
  const dsAfter = await wireDs();
  st = await boardState();
  const dRebuilds = statsAfter.rebuilds - statsBefore.rebuilds;
  const dInc = statsAfter.incremental - statsBefore.incremental;
  ok('V2 拖拽 Δrebuilds=0（零全量重建）', dRebuilds === 0, `Δrebuilds=${dRebuilds} stats=${JSON.stringify(statsAfter)}`);
  ok('V2a Δincremental>0（走了增量路径）', dInc > 0, `Δincremental=${dInc}`);
  const changedIdx = diffIdx(dsBefore, dsAfter);
  ok('V2b 620 条中仅邻接导线 d 被重写（索引集合精确匹配）',
    JSON.stringify(changedIdx.slice().sort((a, b) => a - b)) === JSON.stringify(expectIdx.slice().sort((a, b) => a - b)),
    `changed=[${changedIdx}] expected(度${expectIdx.length})=[${expectIdx}]`);
  // 其余元件 transform 全部不变：恰好 1 个位移（被拖元件）
  const beforeMap = new Map(elsBefore.map((e) => [e.id, e]));
  const moved = st.els.filter((e) => { const p = beforeMap.get(e.id); return p && (p.x !== e.x || p.y !== e.y); });
  ok('V2c 恰好 1 个元件位移（其余 375 transform 不变）', moved.length === 1 && moved[0].id === targetId,
    `moved=${moved.map((m) => m.id).join(',')}`);
  ok('V2d 结构规模不变 376/620', st.els.length === 376 && dsAfter.length === 620);

  /* ---- V3 零位移按下-抬起：同值写回不触发任何渲染 ---- */
  const sb3 = await readStats();
  const st3 = await boardState();
  const pos3 = st3.els.find((x) => x.id === targetId);
  const c3 = w2c(st3, pos3.x, pos3.y);
  await drag(c3, c3, 3, 10); // 原地按下抬起
  const sa3 = await readStats();
  ok('V3 零位移手势 Δrebuilds=0 且 Δincremental=0',
    sa3.rebuilds - sb3.rebuilds === 0 && sa3.incremental - sb3.incremental === 0,
    `Δrebuilds=${sa3.rebuilds - sb3.rebuilds} Δinc=${sa3.incremental - sb3.incremental}`);

  /* ---- V4 框选批量拖拽 ---- */
  await keyDown('Escape', 'Escape', 27); await keyUp('Escape', 'Escape', 27); await sleep(150);
  st = await boardState();
  const sb4 = await readStats();
  await drag(w2c(st, 64, 60), w2c(st, 640, 430), 12, 10, 2); // 1.0.9：框选需 Ctrl(modifiers=2)
  const nSel = await js(`return document.querySelectorAll('#board .sel-box').length;`);
  ok('V4 框选命中 ≥ 40', nSel >= 40, `实际 ${nSel}`);
  const selIds = await js(`return [...document.querySelectorAll('#board .sel-box')].map(g=>{const h=g.closest('[data-el]');return h?h.getAttribute('data-el'):null;}).filter(Boolean);`);
  const before4 = new Map(st.els.map((e) => [e.id, e]));
  await drag(w2c(st, 340, 244), w2c(st, 388, 292));
  const sa4 = await readStats();
  st = await boardState();
  ok('V4a 框选拖拽 Δrebuilds=0', sa4.rebuilds - sb4.rebuilds === 0, `Δ=${sa4.rebuilds - sb4.rebuilds}`);
  const deltas = selIds.map((id) => { const p = st.els.find((e) => e.id === id); const b = before4.get(id); return p && b ? { dx: p.x - b.x, dy: p.y - b.y } : null; });
  ok('V4b 整组位移一致且非零',
    deltas.length === nSel && deltas.every((d) => d) &&
    deltas.every((d) => Math.abs(d.dx - deltas[0].dx) < 0.01 && Math.abs(d.dy - deltas[0].dy) < 0.01) &&
    (deltas[0].dx !== 0 || deltas[0].dy !== 0), JSON.stringify(deltas.slice(0, 3)));
  ok('V4c 组拖后导线数仍 620', (await wireCount()) === 620);

  /* ---- V5 直线↔曲线切换：full 重建口径 ---- */
  const sb5 = await readStats();
  await js(`const b=document.querySelector('.wire-style-btn[data-style="curve"]');b&&b.click();return 1;`); await sleep(350);
  const sm5 = await readStats();
  const hasCurve = await js(`return [...document.querySelectorAll('#board path.wire')].some(p=>(p.getAttribute('d')||'').indexOf('C')>=0);`);
  ok('V5 切曲线走 full 重建（Δrebuilds ≥ 1）', sm5.rebuilds - sb5.rebuilds >= 1, `Δ=${sm5.rebuilds - sb5.rebuilds}`);
  ok('V5a 曲线几何生效（d 含 C）', hasCurve === true);
  await js(`const b=document.querySelector('.wire-style-btn[data-style="straight"]');b&&b.click();return 1;`); await sleep(350);
  const sa5 = await readStats();
  const allStraight = await js(`return [...document.querySelectorAll('#board path.wire')].every(p=>(p.getAttribute('d')||'').indexOf('C')<0);`);
  ok('V5b 切回直线再次 full 重建（累计 ≥ 2）', sa5.rebuilds - sb5.rebuilds >= 2, `Δ=${sa5.rebuilds - sb5.rebuilds}`);
  ok('V5c 直线几何还原', allStraight === true);
  ok('V5d 全程导线数 620', (await wireCount()) === 620);

  /* ---- V6 无异常 ---- */
  ok('V6 全程无页面异常', exceptions.length === 0, exceptions.slice(0, 3).join('|'));

  try { await fetch(`${DEBUG}/json/close/${tab.id}`); } catch { /* ignore */ }
}

main().then(() => {
  console.log(`\n===== 结果 =====`);
  console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
  if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
  console.log(R.fail === 0 ? 'QA2_DRAG_VERIFY_PASS' : 'QA2_DRAG_VERIFY_FAILED');
  process.exit(R.fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('QA2_DRAG_VERIFY_ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});

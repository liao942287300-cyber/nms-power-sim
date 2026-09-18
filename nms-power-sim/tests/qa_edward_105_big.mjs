#!/usr/bin/env node
/**
 * tests/qa_edward_105_big.mjs — QA Edward 1.0.5 大电路浏览器专项（交互不回归 + 帧稳定）
 * 前置：http.server 8900（cwd=nms-power-sim）+ headless Edge CDP 9222（同 browser.smoke）。
 *
 * 验证（导入 moj-scroll-screen.json 376 元件 / 620 导线）：
 *   B1 大电路导入渲染：376/620 全部上画布，无页面异常。
 *   B2 运行中帧稳定性：rAF 采样 300 帧（中位 ≤20ms、无 >100ms 帧）+ longtask 主线程长任务 ≤5。
 *   B3 UI 点 START（平移视图至按钮处真实点击）：灯阵数秒内开始点亮。
 *   B4 UI 级滚动验证：稳态后相邻秒画面右移 1 列、隔 18 秒画面一致（DOM lit 属性读取）。
 *   B5 框选批量移动（平移视图至灯阵区）：命中 ≥40、整组位移一致、框外不动。
 *   B6 Ctrl+Z 撤销：位置逐一精确还原、结构完整。
 *   B7 实例库：保存大电路（count=376）→ 清空 → 载入恢复 376/620（大 JSON 流畅）。
 *
 * 说明：#btn-fit 受 MIN_K=0.25 限制，3600+px 世界无法整幅入画布，
 *       按钮与灯阵需通过「空格+拖拽平移」分别纳入视口后再做鼠标交互。
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
async function drag(from, to, steps = 12) {
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
  await mouse('mousePressed', from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { buttons: 1 });
    await sleep(10);
  }
  await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  await sleep(120);
}
async function pressCtrlZ() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
  await sleep(200);
}
async function pressEscape() {
  await keyDown('Escape', 'Escape', 27); await keyUp('Escape', 'Escape', 27);
  await sleep(150);
}

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
const selBoxCount = () => js(`return document.querySelectorAll('#board .sel-box').length;`);
/** 从 DOM 读整幅灯阵（亮 = 图标矩形填充 #ffd23f）。返回 5×32 布尔阵。 */
const readGrid = () => js(`
  const g=[];for(let r=0;r<5;r++){const row=[];for(let c=0;c<32;c++){
    const el=document.querySelector('[data-el="lamp_r'+r+'c'+c+'"]');
    row.push(!!el && !!el.querySelector('rect[fill="#ffd23f"]'));}
    g.push(row);}return g;`);
const litCount = (g) => g.flat().filter(Boolean).length;
const gridEq = (a, b) => a.every((row, r) => row.every((v, c) => v === b[r][c]));

/** 空格+拖拽平移一次，返回视图实际位移（用于方向反馈校正）。 */
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
/** 平移视图至目标 (tx,ty)（带方向反馈校正，最多 5 轮）。 */
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
  const file = 'C:/Users/liao9/AppData/Local/Temp/qa105_moj.json';
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

  /* ---- B1 导入 ---- */
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click();return 1;`); await sleep(300);
  await importMoj();
  let st = await boardState();
  ok('B1 大电路导入：元件 376', st.els.length === 376, `实际 ${st.els.length}`);
  ok('B1a 导线 620 全部渲染', (await js(`return document.querySelectorAll('#board path.wire').length;`)) === 620);
  ok('B1b 无页面异常', exceptions.length === 0, exceptions.slice(0, 2).join('|'));

  await js(`document.getElementById('btn-fit').click();return 1;`); await sleep(400);

  /* ---- B2 帧稳定性（运行中 idle 大电路） ---- */
  const m = await js(`return new Promise(res=>{
    const longtasks=[];let o=null;
    try{o=new PerformanceObserver(l=>{for(const e of l.getEntries())longtasks.push(e.duration);});o.observe({entryTypes:['longtask']});}catch(e){}
    const ds=[];let last=null,n=0;
    function step(t){if(last===null){last=t;requestAnimationFrame(step);return;}
      const d=t-last;last=t;if(d>0&&d<1000)ds.push(d);
      if(++n>=301){if(o)o.disconnect();res({ds,longtasks});}else requestAnimationFrame(step);}
    requestAnimationFrame(step);});`);
  const sorted = [...m.ds].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  ok('B2 帧中位间隔 ≤ 20ms（不掉帧）', median <= 20, `median=${median.toFixed(1)}ms`);
  ok('B2a 无 >100ms 卡顿帧', max <= 100, `max=${max.toFixed(1)}ms`);
  ok('B2b 主线程长任务（>50ms）≤ 5（300 帧窗口）', m.longtasks.length <= 5, `longtask=${m.longtasks.length}`);

  /* ---- B3 平移到 START 按钮并点击 ---- */
  st = await boardState();
  ok('B3a fit 后 k=0.25（世界大于画布，需平移）', st.view.k === 0.25, `k=${st.view.k}`);
  const panOk1 = await panToView(-20, -220);
  st = await boardState();
  const btn = st.els.find((e) => e.id === 'scroll_btn');
  const btnC = btn ? w2c(st, btn.x, btn.y) : null;
  const btnVisible = btnC && btnC.x >= st.rect.left && btnC.x <= st.rect.left + st.rect.width && btnC.y >= st.rect.top && btnC.y <= st.rect.top + st.rect.height;
  ok('B3b 平移后 START 按钮进入视口', panOk1 && btnVisible, `pan=${panOk1} btnScreen=${JSON.stringify(btnC)}`);
  ok('B3c 点 START 前全灭', litCount(await readGrid()) === 0);
  await click(btnC.x, btnC.y);
  const T0 = Date.now();
  let lit0 = 0;
  for (let i = 0; i < 40 && lit0 === 0; i++) { await sleep(500); lit0 = litCount(await readGrid()); }
  ok('B3d 点 START 后 ≤20s 屏幕开始点亮', lit0 > 0, `首亮于 ${((Date.now() - T0) / 1000).toFixed(1)}s，亮 ${lit0}`);

  /* ---- B4 UI 级滚动（稳态后；DOM 属性读取，与视口无关） ---- */
  const target = T0 + 50000; // 等 ~50s 进入稳态（Node 侧实测 35s）
  const waitMs = target - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  const g1 = await readGrid();
  await sleep(1000);
  const g2 = await readGrid();
  await sleep(1000);
  const g3 = await readGrid();
  const shiftOk = (a, b) => a.every((row, r) => row.every((v, c) => c === 0 || b[r][c] === a[r][c - 1]));
  ok('B4 稳态画面 1 列/秒 右移（UI 级，秒 1→2）', litCount(g1) > 0 && shiftOk(g1, g2), `亮 ${litCount(g1)}`);
  ok('B4a 稳态画面 1 列/秒 右移（UI 级，秒 2→3）', shiftOk(g2, g3), '');
  // 对齐仿真时钟：浏览器 rAF 帧间隔抖动会使仿真时间与墙钟漂移，
  // 不能用固定 sleep(18s)——改为轮询画面变化，数满 18 次流步后比对（18 拍周期）。
  const gridKey = (g) => g.map((row) => row.map((v) => (v ? 1 : 0)).join('')).join('|');
  let lastKey = gridKey(g3), changes = 0, g18 = null;
  for (let guard = 0; guard < 400 && changes < 18; guard++) {
    await sleep(250);
    const g = await readGrid();
    const k = gridKey(g);
    if (k !== lastKey) { changes++; lastKey = k; if (changes === 18) g18 = g; }
  }
  ok('B4b 仿真时钟 18 次流步后画面与 g3 一致（周期）', !!g18 && gridEq(g3, g18),
    `changes=${changes} g18=${g18 ? 'ok' : 'null'}`);

  /* ---- B5 框选批量移动（平移回灯阵区） ---- */
  const panOk2 = await panToView(-15, 40);
  ok('B5 平移至灯阵区', panOk2, '');
  st = await boardState();
  await pressEscape();
  const lampC0 = st.els.find((e) => e.id === 'lamp_r0c0');
  ok('B5a 灯阵起点位于视口内', (() => { const p = w2c(st, 64, 60); return p.x >= st.rect.left && p.y >= st.rect.top && p.x <= st.rect.left + st.rect.width && p.y <= st.rect.top + st.rect.height; })(),
    JSON.stringify(lampC0 ? w2c(st, lampC0.x, lampC0.y) : null));
  await drag(w2c(st, 64, 60), w2c(st, 640, 430));
  const nSel = await selBoxCount();
  ok('B5b 框选命中 ≥40 个（55 灯 + 相连导线）', nSel >= 40, `实际 ${nSel}`);
  const pickIds = ['lamp_r0c0', 'lamp_r2c5', 'lamp_r4c10', 'lamp_r0c20'];
  const posOf = (s, id) => { const e = s.els.find((x) => x.id === id); return e ? { x: e.x, y: e.y } : null; };
  const before = {}; for (const id of pickIds) before[id] = posOf(st, id);
  // 从选中组内一点（lamp_r2c5 中心 340,244）拖动 +48,+48
  await drag(w2c(st, 340, 244), w2c(st, 388, 292));
  st = await boardState();
  const deltas = pickIds.slice(0, 3).map((id) => { const p = posOf(st, id); return { dx: p.x - before[id].x, dy: p.y - before[id].y }; });
  const consistent = deltas.every((d) => Math.abs(d.dx - deltas[0].dx) < 0.01 && Math.abs(d.dy - deltas[0].dy) < 0.01) && (deltas[0].dx !== 0 || deltas[0].dy !== 0);
  ok('B5c 选中组整组位移一致（非零）', consistent, JSON.stringify(deltas));
  const w2Still = posOf(st, 'lamp_r0c20');
  ok('B5d 框外 lamp_r0c20 未动', w2Still.x === before['lamp_r0c20'].x && w2Still.y === before['lamp_r0c20'].y);

  /* ---- B6 Ctrl+Z 撤销 ---- */
  ok('B6 撤销按钮可用', (await js(`return !document.getElementById('btn-undo').disabled;`)) === true);
  await pressCtrlZ();
  st = await boardState();
  const restored = pickIds.slice(0, 3).every((id) => { const p = posOf(st, id); return p.x === before[id].x && p.y === before[id].y; });
  ok('B6a Ctrl+Z 后位置逐一精确还原', restored);
  ok('B6b 结构完整（仍 376 元件）', st.els.length === 376, `实际 ${st.els.length}`);

  /* ---- B7 实例库 ---- */
  await js(`localStorage.removeItem('nmsPowerSimLibrary.v1');return 1;`);
  const tSave = Date.now();
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(300);
  await js(`document.getElementById('name-input').value='QA105大电路';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(500);
  const lib = JSON.parse(await js(`return localStorage.getItem('nmsPowerSimLibrary.v1')||'[]';`));
  ok('B7 实例保存成功（1 条）', lib.length === 1, JSON.stringify(lib.map((x) => x.name)));
  ok('B7a count=376 且数据完整', lib[0] && lib[0].count === 376 && lib[0].data.elements.length === 376 && lib[0].data.wires.length === 620,
    lib[0] ? `count=${lib[0].count}` : '无条目');
  ok('B7b 保存耗时 < 2s（大对象无卡顿）', Date.now() - tSave < 2000, `${Date.now() - tSave}ms`);
  await js(`document.getElementById('btn-clear').click();return 1;`); await sleep(400);
  st = await boardState();
  ok('B7c 清空画布', st.els.length === 0);
  const tLoad = Date.now();
  await js(`document.getElementById('btn-library').click();return 1;`); await sleep(400);
  await js(`const it=document.querySelector('#library-list .lib-item');const b=[...it.querySelectorAll('.lib-ops .btn')].find(x=>x.textContent==='载入');b.click();return 1;`);
  await sleep(800);
  st = await boardState();
  ok('B7d 实例载入恢复 376/620', st.els.length === 376 && (await js(`return document.querySelectorAll('#board path.wire').length;`)) === 620,
    `els=${st.els.length} 耗时${Date.now() - tLoad}ms`);
  ok('B7e 载入耗时 < 2s（大 JSON 流畅）', Date.now() - tLoad < 2000, `${Date.now() - tLoad}ms`);

  ok('B8 全程无页面异常', exceptions.length === 0, exceptions.slice(0, 3).join('|'));

  try { await fetch(`${DEBUG}/json/close/${tab.id}`); } catch { /* ignore */ }
}

main().then(() => {
  console.log(`\n===== 结果 =====`);
  console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
  if (R.failures.length) { console.log('  失败明细：'); R.failures.forEach((f) => console.log('   [FAIL] ' + f)); }
  console.log(R.fail === 0 ? 'QA_105_BIG_PASS' : 'QA_105_BIG_FAILED');
  process.exit(R.fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('BIG_VERIFY_ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});

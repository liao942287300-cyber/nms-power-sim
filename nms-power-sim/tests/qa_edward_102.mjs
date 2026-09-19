#!/usr/bin/env node
/**
 * tests/qa_edward_102.mjs — QA Edward 独立回归脚本（1.0.2：框选批量移动 + 实例库）
 * 与 browser.smoke.mjs 相互独立：断言全部自行设计、自行计数。
 * 运行前置：http.server 8900 + headless Edge CDP 9222（全新 user-data-dir）。
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
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else for (const h of this.handlers) h(m);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  return new CDP(ws);
}

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
async function click(x, y, o = {}) {
  await mv(x, y, o); await down(x, y, o); await sleep(40); await up(x, y, o); await sleep(120);
}
async function drag(from, to, steps = 10, o = {}) {
  await mv(from.x, from.y, o); await down(from.x, from.y, o);
  for (let i = 1; i <= steps; i++) { await mv(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { ...o, buttons: o.buttons ?? 1 }); await sleep(12); }
  await up(to.x, to.y, o); await sleep(120);
}
async function shiftClick(x, y) { await click(x, y, { modifiers: 8 }); }
const kd = (k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const ku = (k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function press(k, code, vk) { await kd(k, code, vk); await ku(k, code, vk); await sleep(120); }
const DEL = () => press('Delete', 'Delete', 46);
const ESC = () => press('Escape', 'Escape', 27);
async function wheel(x, y, dy) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', pointerType: 'mouse' }); await sleep(40); }

/* ---- 页面状态读取（自行实现） ---- */
async function readBoard() {
  return js(`
    const b=document.getElementById('board');const r=b.getBoundingClientRect();
    const vg=b.querySelector('g.viewport');let k=1,tx=0,ty=0;
    if(vg){const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)\\s*scale\\(([-\\d.eE+]+)\\)/.exec(vg.getAttribute('transform')||'');if(m){tx=+m[1];ty=+m[2];k=+m[3];}}
    const els=[...b.querySelectorAll('.element')].map(g=>{const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      return {id:g.getAttribute('data-el'),type:(g.getAttribute('class').match(/element-([a-z_]+)/)||[])[1],x:m?+m[1]:0,y:m?+m[2]:0};});
    const sel=[...b.querySelectorAll('.sel-box')].map(s=>s.closest('[data-el]').getAttribute('data-el')).sort();
    const marquee=!!b.querySelector('.marquee-box');
    const wires=[...b.querySelectorAll('path.wire')].map(w=>w.getAttribute('d'));
    const ports=[...b.querySelectorAll('.port')].map(p=>{const g=p.closest('.element');
      const m=/translate\\(([-\\d.eE+]+)[ ,]([-\\d.eE+]+)\\)/.exec(g.getAttribute('transform')||'');
      const dot=p.querySelector('.port-dot');
      return {el:p.getAttribute('data-el'),port:p.getAttribute('data-portname'),wx:+m[1]+ +dot.getAttribute('cx'),wy:+m[2]+ +dot.getAttribute('cy')};});
    return {rect:{l:r.left,t:r.top},view:{k,tx,ty},els,sel,marquee,wires,ports,
      insp:(document.getElementById('inspector-props')||{}).textContent||'',
      status:[...document.querySelectorAll('#inspector-status .status-row')].map(x=>({id:(x.querySelector('.sr-id')||{}).textContent,st:(x.querySelector('.sr-state')||{}).textContent}))};
  `);
}
const w2c = (st, x, y) => ({ x: st.rect.l + st.view.tx + x * st.view.k, y: st.rect.t + st.view.ty + y * st.view.k });
const stateOf = (st, id) => (st.status.find((s) => s.id === '#' + id) || {}).st;

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
const libRaw = () => js(`const v=localStorage.getItem('nmsPowerSimLibrary.v1');return v===null?null:JSON.parse(v);`);

/* ====================== E1 框选批量移动（独立断言） ====================== */
const E1_CIRCUIT = {
  elements: [
    { id: 'p', type: 'power', x: 120, y: 120 },
    { id: 's1', type: 'wall_switch', x: 360, y: 120 },
    { id: 'l', type: 'lamp', x: 600, y: 120 },
    { id: 's2', type: 'wall_switch', x: 360, y: 360 },
  ],
  wires: [
    { id: 'wa', a: { el: 'p', port: 'out' }, b: { el: 's1', port: 'a' } },
    { id: 'wb', a: { el: 's1', port: 'b' }, b: { el: 'l', port: 'in' } },
  ],
  timeOfDay: 8, dayCycle: false,
};

async function e1Marquee() {
  console.log('\n===== E1 框选批量移动（独立验证） =====');
  await js(`document.getElementById('btn-run').click();return 1;`); // 确保运行态
  await sleep(150);
  await setView('lab'); await clearCanvas();
  await importJSON(E1_CIRCUIT, 'e1');
  let st = await readBoard();
  eq('E1-0 预置电路就位（4 元件）', st.els.length, 4);
  eq('E1-0 预置电路就位（2 导线）', st.wires.length, 2);

  // E1.1 左→右框选：世界 (10,10)-(760,240) → 完全包含 p/s1/l，排除 s2
  await drag(w2c(st, 10, 10), w2c(st, 760, 240), 12, { modifiers: 2 }); // 1.0.9：框选需 Ctrl
  st = await readBoard();
  eq('E1.1 左→右框选命中数=3', st.sel.length, 3);
  ok('E1.1 命中成员恰为 l/p/s1（s2 不在内）', JSON.stringify(st.sel) === JSON.stringify(['l', 'p', 's1']), JSON.stringify(st.sel));
  ok('E1.1 检查器出现「已选中 3」', st.insp.includes('已选中 3'), st.insp.slice(0, 30));

  // E1.2 整组移动：拖 s1 中心 (+72,+96)；组内位移严格一致、组外不动、导线端点跟随
  const pos0 = {}; for (const e of st.els) pos0[e.id] = { x: e.x, y: e.y };
  const wire0 = st.wires.map((d) => d);
  await drag(w2c(st, pos0.s1.x, pos0.s1.y), w2c(st, pos0.s1.x + 72, pos0.s1.y + 96), 12);
  st = await readBoard();
  const pos1 = {}; for (const e of st.els) pos1[e.id] = { x: e.x, y: e.y };
  const grp = ['p', 's1', 'l'].map((id) => ({ id, dx: pos1[id].x - pos0[id].x, dy: pos1[id].y - pos0[id].y }));
  ok('E1.2 组内三元件位移严格一致 (+72,+96)', grp.every((g) => g.dx === 72 && g.dy === 96), JSON.stringify(grp));
  ok('E1.2 组外 s2 未动', pos1.s2.x === pos0.s2.x && pos1.s2.y === pos0.s2.y, `${pos0.s2.x},${pos0.s2.y} → ${pos1.s2.x},${pos1.s2.y}`);
  eq('E1.2 导线数量仍为 2', st.wires.length, 2);
  // 导线端点跟随：wa 第一端点属于 p.out，位移后新端点 = 旧端点 + (72,96)
  const pt = (d) => { const t = d.trim().split(/\s+/); return { x: +t[1], y: +t[2] }; };
  const oldA = pt(wire0[0]), newA = pt(st.wires[0]);
  ok('E1.2 导线端点跟随元件新坐标（端点位移=组位移）', Math.abs(newA.x - (oldA.x + 72)) < 0.01 && Math.abs(newA.y - (oldA.y + 96)) < 0.01,
    `(${oldA.x},${oldA.y}) → (${newA.x},${newA.y})`);
  ok('E1.2 位移后仍为 24 网格整数倍', Object.values(pos1).every((p) => p.x % 24 === 0 && p.y % 24 === 0));

  // E1.3 Shift 加选/减选
  await shiftClick(w2c(st, pos1.s2.x, pos1.s2.y).x, w2c(st, pos1.s2.x, pos1.s2.y).y);
  st = await readBoard();
  eq('E1.3 Shift+点击加选 s2 → 4 个', st.sel.length, 4);
  await shiftClick(w2c(st, pos1.s2.x, pos1.s2.y).x, w2c(st, pos1.s2.x, pos1.s2.y).y);
  st = await readBoard();
  eq('E1.3 再次 Shift+点击减选 → 3 个', st.sel.length, 3);

  // E1.4 点击已选中元件：保持选择集
  await click(w2c(st, pos1.s1.x, pos1.s1.y).x, w2c(st, pos1.s1.x, pos1.s1.y).y);
  st = await readBoard();
  eq('E1.4 点击已选中元件后选择集仍为 3', st.sel.length, 3);
  ok('E1.4 检查器切到被点元件属性（墙壁开关）', st.insp.includes('墙壁开关'), st.insp.slice(0, 24));

  // E1.5 Esc 清除
  await ESC();
  eq('E1.5 Esc 后选择集为空', (await readBoard()).sel.length, 0);

  // E1.6 右→左相交即选中：框 (180,60)-(560,300) 从右往左，只与 s1(330..390,87..147) 相交…
  // 重新布两点：l1(120,120) l2(360,120)，框世界 (200,40)-(480,200) 只与 l2 相交（l1 右缘 140 < 200）
  await clearCanvas();
  await importJSON({ elements: [{ id: 'l1', type: 'lamp', x: 120, y: 120 }, { id: 'l2', type: 'lamp', x: 360, y: 120 }], wires: [], timeOfDay: 8, dayCycle: false }, 'e1rl');
  st = await readBoard();
  await drag(w2c(st, 480, 200), w2c(st, 200, 40), 10, { modifiers: 2 });
  st = await readBoard();
  eq('E1.6 右→左相交框选命中数=1', st.sel.length, 1);
  ok('E1.6 命中的是 l2（部分相交即选中）', JSON.stringify(st.sel) === JSON.stringify(['l2']), JSON.stringify(st.sel));
  // 左→右半包含框：框 (200,100)-(400,200) 纵向切过 l2（87..153 未完全落入）→ 0 个
  await ESC();
  await drag(w2c(st, 200, 100), w2c(st, 400, 200), 10, { modifiers: 2 });
  st = await readBoard();
  eq('E1.6 左→右半包含框（l2 未完全落入）命中 0 个', st.sel.length, 0);

  // E1.7 Delete 批量删除 + 级联
  await clearCanvas();
  await importJSON(E1_CIRCUIT, 'e1del');
  st = await readBoard();
  await drag(w2c(st, 10, 10), w2c(st, 760, 240), 12, { modifiers: 2 }); // 1.0.9：框选需 Ctrl
  st = await readBoard();
  eq('E1.7 框选 3 个后 Delete', st.sel.length, 3);
  await DEL();
  st = await readBoard();
  eq('E1.7 元件 4 → 1', st.els.length, 1);
  eq('E1.7 相连导线级联 2 → 0', st.wires.length, 0);
  eq('E1.7 选择集清空', st.sel.length, 0);
  ok('E1.7 幸存元件是 s2', st.els.length === 1 && st.els[0].id === 's2', JSON.stringify(st.els.map((e) => e.id)));
}

/* ====================== E8 框选手势冲突回归（独立断言） ====================== */
async function e8Conflicts() {
  console.log('\n===== E8 框选 × 平移/缩放/拉线/右键/开关 冲突回归 =====');
  await clearCanvas();
  await importJSON(E1_CIRCUIT, 'e8');
  let st = await readBoard();
  // 建立选择集 p/s1/l
  await drag(w2c(st, 10, 10), w2c(st, 760, 240), 12, { modifiers: 2 }); // 1.0.9：框选需 Ctrl
  st = await readBoard();
  eq('E8-0 建立选择集 3 个', st.sel.length, 3);
  const posA = {}; for (const e of st.els) posA[e.id] = { x: e.x, y: e.y };
  const viewA = { ...st.view };

  // E8.1 空白处拖动 → 平移而非框选（1.0.9：空格已不再是平移修饰键）；选择集保持；元件不动
  const bp8 = await js(`const b=document.getElementById('board');const r=b.getBoundingClientRect();
    for(let fy=0.15;fy<=0.9;fy+=0.08)for(let fx=0.12;fx<=0.9;fx+=0.08){const x=r.left+r.width*fx,y=r.top+r.height*fy;
    const el=document.elementFromPoint(x,y);if(el&&!(el.closest&&el.closest('[data-el]'))&&(el===b||b.contains(el)))return {x,y};}return null;`);
  ok('E8.1 找到空白平移起点', !!bp8, JSON.stringify(bp8));
  await drag(bp8, { x: bp8.x + 110, y: bp8.y - 50 }, 10);
  st = await readBoard();
  ok('E8.1 空白拖动期间视图发生平移', Math.abs(st.view.tx - viewA.tx) > 30 || Math.abs(st.view.ty - viewA.ty) > 30,
    `t0=(${viewA.tx},${viewA.ty}) t1=(${st.view.tx},${st.view.ty})`);
  eq('E8.1 平移后选择集保持 3 个', st.sel.length, 3);
  const posB = {}; for (const e of st.els) posB[e.id] = { x: e.x, y: e.y };
  ok('E8.1 平移不移动任何元件', Object.keys(posA).every((id) => posA[id].x === posB[id].x && posA[id].y === posB[id].y));
  await sleep(150);

  // E8.2 滚轮缩放：选择集保持
  const kA = st.view.k;
  await wheel(st.rect.l + 500, st.rect.t + 300, -160);
  st = await readBoard();
  ok('E8.2 滚轮缩放生效', Math.abs(st.view.k - kA) > 0.02, `k ${kA.toFixed(3)}→${st.view.k.toFixed(3)}`);
  eq('E8.2 缩放后选择集保持 3 个', st.sel.length, 3);

  // E8.3 多选状态下点击电源本体 → 电源关断且选择集保持
  const pNow = st.els.find((e) => e.id === 'p');
  await click(w2c(st, pNow.x, pNow.y).x, w2c(st, pNow.x, pNow.y).y);
  await sleep(300);
  st = await readBoard();
  eq('E8.3 多选中点击电源 → 状态行显示「已关断」', stateOf(st, 'p'), '已关断');
  eq('E8.3 点击电源后选择集仍 3 个', st.sel.length, 3);
  // 恢复供电，保证 E8.4 场景有电
  await click(w2c(st, pNow.x, pNow.y).x, w2c(st, pNow.x, pNow.y).y);
  await sleep(300);
  st = await readBoard();
  eq('E8.3 再次点击电源 → 恢复「持续供电」', stateOf(st, 'p'), '持续供电');
  eq('E8.3 恢复后选择集仍 3 个', st.sel.length, 3);

  // E8.4 多选状态下点击墙开关 s1 → 状态翻转（接通）
  // s1 在回路 p→s1→l 中：合闸后灯应亮
  const s1Now = st.els.find((e) => e.id === 's1');
  const lBefore = stateOf(st, 'l');
  await click(w2c(st, s1Now.x, s1Now.y).x, w2c(st, s1Now.x, s1Now.y).y);
  await sleep(400);
  st = await readBoard();
  eq('E8.4 多选中点击墙开关 s1 → 灯点亮（单击触发未被吞）', stateOf(st, 'l'), '点亮');
  ok('E8.4 触发后选择集仍保持 3 个', st.sel.length === 3, JSON.stringify(st.sel));
  // 再点一次灭灯（复位场景）
  await click(w2c(st, s1Now.x, s1Now.y).x, w2c(st, s1Now.x, s1Now.y).y);
  await sleep(300);
  st = await readBoard();
  ok('E8.4 再次点击墙开关 → 灯熄灭（可逆）', stateOf(st, 'l') === '熄灭', stateOf(st, 'l'));

  // E8.5 端口拉线与框选互斥：从 p.out 端口按下拖到 s2.a → 建线而非框选
  const po = st.ports.find((x) => x.el === 'p' && x.port === 'out');
  const s2a = st.ports.find((x) => x.el === 's2' && x.port === 'a');
  await drag(w2c(st, po.wx, po.wy), w2c(st, s2a.wx, s2a.wy), 10);
  st = await readBoard();
  eq('E8.5 端口拖拽建立新导线（共 3 根）', st.wires.length, 3);
  eq('E8.5 拉线手势未产生框选（选择集为空=拉线清除了选择）', st.sel.length, 0);

  // E8.6 右键导线 → 导线选中（元件选择集清空）→ Delete 只删导线
  st = await readBoard();
  const wireMid = st.wires[0];
  const nums = wireMid.trim().split(/\s+/).filter((x) => !isNaN(+x));
  const midW = { x: (+nums[0] + +nums[nums.length - 2]) / 2, y: (+nums[1] + +nums[nums.length - 1]) / 2 };
  const mc = w2c(st, midW.x, midW.y);
  await click(mc.x, mc.y, { button: 'right', buttons: 2 });
  await sleep(200);
  st = await readBoard();
  ok('E8.6 右键后检查器显示导线信息', st.insp.includes('导线'), st.insp.slice(0, 20));
  eq('E8.6 右键后元件 sel-box 清空', st.sel.length, 0);
  await DEL();
  st = await readBoard();
  eq('E8.6 Delete 删除右键选中的导线（3→2）', st.wires.length, 2);
  eq('E8.6 元件数量不变（4）', st.els.length, 4);
}

/* ====================== E2 实例库（独立断言） ====================== */
async function e2Library() {
  console.log('\n===== E2 实例库（独立验证） =====');
  await setView('lab'); await clearCanvas();
  await js(`localStorage.removeItem('nmsPowerSimLibrary.v1');return 1;`);
  // 曲线走线 + 夜晚 22:00 + 关昼夜循环
  await importJSON({
    elements: [{ id: 'p', type: 'power', x: 120, y: 120 }, { id: 'sp', type: 'solar_panel', x: 360, y: 120 }, { id: 'l', type: 'lamp', x: 600, y: 120 }],
    wires: [{ id: 'w1', a: { el: 'p', port: 'out' }, b: { el: 'l', port: 'in' } }],
    timeOfDay: 22, dayCycle: false,
  }, 'e2a');
  await js(`const b=document.querySelector('.wire-style-btn[data-style="curve"]');b.click();return 1;`); await sleep(200);
  // 昼夜开关显式关闭（importJSON 的 change 事件可能未触发 app 监听）
  await js(`const c=document.getElementById('day-cycle');if(c.checked){c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));}return 1;`);

  // E2.1 保存（unicode 名）→ 原始 localStorage 核对
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').value='  QA独立实例α  ';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(300);
  let raw = await js(`return localStorage.getItem('nmsPowerSimLibrary.v1');`);
  let lib = JSON.parse(raw);
  eq('E2.1 库内 1 条', lib.length, 1);
  ok('E2.1 名称被 trim（无首尾空格）', lib[0].name === 'QA独立实例α', lib[0].name);
  ok('E2.1 字段齐全 name/savedAt/count/data', ['name', 'savedAt', 'count', 'data'].every((k) => k in lib[0]), Object.keys(lib[0]).join(','));
  ok('E2.1 savedAt 可解析为日期', !Number.isNaN(new Date(lib[0].savedAt).getTime()), lib[0].savedAt);
  eq('E2.1 count=3', lib[0].count, 3);
  eq('E2.1 data.elements=3', lib[0].data.elements.length, 3);
  eq('E2.1 data.wires=1', lib[0].data.wires.length, 1);
  eq('E2.1 data.wireStyle=curve', lib[0].data.wireStyle, 'curve');
  eq('E2.1 data.timeOfDay=22（昼夜时刻随实例保存）', lib[0].data.timeOfDay, 22);
  eq('E2.1 data.dayCycle=false', lib[0].data.dayCycle, false);
  const savedAt1 = lib[0].savedAt;

  // E2.2 重名 → 覆盖确认 → 确定覆盖
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').value='QA独立实例α';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(300);
  ok('E2.2 重名弹出覆盖确认模态', await js(`return !document.getElementById('confirm-modal').hidden;`));
  await js(`document.getElementById('confirm-modal-ok').click();return 1;`); await sleep(300);
  lib = await libRaw();
  eq('E2.2 覆盖后仍 1 条', lib.length, 1);
  ok('E2.2 savedAt 已更新（覆盖成功）', lib[0].savedAt >= savedAt1, `${savedAt1} → ${lib[0].savedAt}`);

  // E2.3 重名 → 取消覆盖 → 自动序号后缀
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').value='QA独立实例α';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(300);
  await js(`document.getElementById('confirm-modal-cancel').click();return 1;`); await sleep(300);
  lib = await libRaw();
  eq('E2.3 拒绝覆盖后 2 条', lib.length, 2);
  ok('E2.3 自动后缀 -2 存在', lib.some((x) => x.name === 'QA独立实例α-2'), JSON.stringify(lib.map((x) => x.name)));

  // E2.4 刷新页面 → 持久化 + 面板展示
  const exBefore = exceptions.length;
  await page.send('Page.reload', { ignoreCache: true }); await sleep(2500);
  lib = await libRaw();
  eq('E2.4 刷新后仍 2 条', lib.length, 2);
  await setView('lab');
  await js(`document.getElementById('btn-library').click();return 1;`); await sleep(450);
  eq('E2.4 面板条目数=2', await js(`return document.querySelectorAll('#library-list .lib-item').length;`), 2);

  // E2.5 清空画布 → 载入 α → 全量还原（元件/导线/wireStyle/昼夜时刻）
  await clearCanvas();
  ok('E2.5 清空后画布为空', (await js(`return document.querySelectorAll('#board .element').length;`)) === 0);
  await js(`const it=[...document.querySelectorAll('#library-list .lib-item')].find(x=>x.querySelector('.lib-name').textContent==='QA独立实例α');
    [...it.querySelectorAll('.lib-ops .btn')].find(b=>b.textContent==='载入').click();return 1;`);
  await sleep(700);
  const clock = await js(`return document.getElementById('clock-label').textContent;`);
  ok('E2.5 载入后时钟为夜晚 🌙（22:00 还原）', clock.includes('夜晚'), clock);
  const tr = await js(`return +document.getElementById('time-range').value;`);
  ok('E2.5 时刻滑块≈22', Math.abs(tr - 22) < 0.6, String(tr));
  eq('E2.5 昼夜循环勾选=false 还原', await js(`return document.getElementById('day-cycle').checked;`), false);
  eq('E2.5 走线样式按钮=curve 还原', await js(`const b=document.querySelector('.wire-style-btn.is-active');return b?b.dataset.style:null;`), 'curve');
  const stL = await readBoard();
  eq('E2.5 元件 3 个还原', stL.els.length, 3);
  eq('E2.5 导线 1 根还原', stL.wires.length, 1);
  ok('E2.5 元件 id 与保存时一致', ['p', 'sp', 'l'].every((id) => stL.els.some((e) => e.id === id)), JSON.stringify(stL.els.map((e) => e.id)));
  const wt = await js(`const w=document.querySelector('#board path.wire');return (w.getAttribute('d')||'').includes('C');`);
  ok('E2.5 导线实际按曲线渲染（d 含 C 命令）', wt === true);
  ok('E2.5 labTitle 含实例名', (await js(`return document.getElementById('lab-title').textContent;`)).includes('QA独立实例α'));

  // E2.6 面板「覆盖」：改画布后覆盖 α-2
  await clearCanvas();
  await importJSON({ elements: [{ id: 'only', type: 'door', x: 200, y: 200 }], wires: [], timeOfDay: 9, dayCycle: true }, 'e2ovr');
  await js(`const it=[...document.querySelectorAll('#library-list .lib-item')].find(x=>x.querySelector('.lib-name').textContent==='QA独立实例α-2');
    [...it.querySelectorAll('.lib-ops .btn')].find(b=>b.textContent==='覆盖').click();return 1;`); await sleep(300);
  lib = await libRaw();
  const e2 = lib.find((x) => x.name === 'QA独立实例α-2');
  ok('E2.6 覆盖后 α-2 count=1（元件为 door）', e2 && e2.count === 1 && e2.data.elements[0].type === 'door', JSON.stringify(e2 && e2.data.elements));

  // E2.7 面板「删除」：取消不删；确定删除
  await js(`const it=[...document.querySelectorAll('#library-list .lib-item')].find(x=>x.querySelector('.lib-name').textContent==='QA独立实例α-2');
    [...it.querySelectorAll('.lib-ops .btn')].find(b=>b.textContent==='删除').click();return 1;`); await sleep(250);
  await js(`document.getElementById('confirm-modal-cancel').click();return 1;`); await sleep(250);
  eq('E2.7 取消删除后仍 2 条', (await libRaw()).length, 2);
  await js(`const it=[...document.querySelectorAll('#library-list .lib-item')].find(x=>x.querySelector('.lib-name').textContent==='QA独立实例α-2');
    [...it.querySelectorAll('.lib-ops .btn')].find(b=>b.textContent==='删除').click();return 1;`); await sleep(250);
  ok('E2.7 删除有二次确认', await js(`return !document.getElementById('confirm-modal').hidden;`));
  await js(`document.getElementById('confirm-modal-ok').click();return 1;`); await sleep(250);
  eq('E2.7 确认后剩 1 条且为 α', (await libRaw())[0].name, 'QA独立实例α');

  // E2.8 空名拦截 + Esc 关闭模态
  await js(`document.getElementById('btn-save-instance').click();return 1;`); await sleep(250);
  await js(`document.getElementById('name-input').value='   ';return 1;`);
  await js(`document.getElementById('name-modal-ok').click();return 1;`); await sleep(200);
  ok('E2.8 纯空格名被拦（模态未关且有错误提示）',
    await js(`return !document.getElementById('name-modal').hidden && document.getElementById('name-error').textContent.length>0;`));
  await ESC();
  ok('E2.8 Esc 关闭命名模态', await js(`return document.getElementById('name-modal').hidden;`));
  eq('E2.8 空名未写入库', (await libRaw()).length, 1);

  // E2.9 内置预设不进实例库
  const libBefore = (await libRaw()).length;
  await setView('presets');
  await js(`[...document.querySelectorAll('#preset-root .preset-card .btn.primary')][1].scrollIntoView({block:'center'});return 1;`); await sleep(200);
  await js(`[...document.querySelectorAll('#preset-root .preset-card .btn.primary')][1].click();return 1;`); await sleep(700);
  eq('E2.9 载入内置预设后实例库条目数不变', (await libRaw()).length, libBefore);
  ok('E2.9 库内无预设标题', (await libRaw()).every((x) => !/双控|流水|频闪|密码|门自动|走马|太阳能/.test(x.name)), JSON.stringify((await libRaw()).map((x) => x.name)));

  ok('E2 全程无未捕获异常', exceptions.length === exBefore, JSON.stringify(exceptions.slice(exBefore)).slice(0, 200));
}

/* ====================== E3 7 内置预设回归（轻量独立） ====================== */
async function e3Presets() {
  console.log('\n===== E3 七个内置预设载入回归 =====');
  for (let i = 0; i < 7; i++) {
    await setView('presets');
    await js(`const b=[...document.querySelectorAll('#preset-root .preset-card .btn.primary')][${i}];b.scrollIntoView({block:'center'});b.click();return 1;`);
    await sleep(800);
    const d = await js(`
      return {n:document.querySelectorAll('#board .element').length,
        t:document.getElementById('lab-title').textContent,
        err:window.__qaErr||0};`);
    ok(`E3 预设${i + 1} 载入有元件且标题更新（${d.n} 个）`, d.n > 0 && d.t.includes('仿真实验室 ·'), `n=${d.n} title=${d.t}`);
  }
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
for (const [name, fn] of [['E1', e1Marquee], ['E8', e8Conflicts], ['E2', e2Library], ['E3', e3Presets]]) {
  if (sections.length && !sections.includes(name)) continue;
  try { await fn(); } catch (e) { R.fail++; R.failures.push(`[${name}] 抛异常: ${e.message}`); console.log(`[FAIL] [${name}] 抛异常: ${e.message}`); }
}
try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {}

console.log('\n===== 结果 =====');
console.log(`通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
if (R.failures.length) R.failures.forEach((f) => console.log('FAIL:: ' + f));
console.log(R.fail === 0 ? 'QA_EDWARD_PASS' : 'QA_EDWARD_FAILED');
process.exit(R.fail === 0 ? 0 : 1);

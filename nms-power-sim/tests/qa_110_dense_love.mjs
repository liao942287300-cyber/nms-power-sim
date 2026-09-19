#!/usr/bin/env node
/**
 * tests/qa_110_dense_love.mjs — 1.0.10 密集灯阵最严苛个案：LOVE 灯阵（43 盏，列距 42 < 泛光外径 48）
 *
 * 方法（原子取样，避免「读坐标 → 截图」两步之间灯态/重渲染漂移）：
 *   暂停仿真 → 一次 Runtime.evaluate 内完成：
 *     序列化 board SVG → data URL → canvas → getImageData
 *     同时读出每盏灯「本体矩形」的屏幕中心与 lit 状态 → 就地取色 → 返回
 * 判据：
 *   D1 相邻双亮中间是局部极小值（不糊成一根亮条）
 *   D2 亮/灭本体亮度比 ≥ 5（真机密集场景）
 *   D3 灭态本体保持中性（三通道极差 ≤ 30）
 */
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const DEBUG = process.env.QA_CDP || 'http://127.0.0.1:9222';
const APP = process.env.QA_URL || 'http://127.0.0.1:8900/index.html';
const CIRCUIT = 'C:/Users/liao9/WorkBuddy/我的工作1/nms-power-sim-desktop/circuits/love-marquee.json';
const SHOT = 'C:/Users/liao9/WorkBuddy/我的工作1/_qa110_love.png';

const R = { pass: 0, fail: 0, failures: [], notes: [] };
const ok = (n, c, d = '') => { if (c) R.pass++; else { R.fail++; R.failures.push(n + (d ? ' :: ' + d : '')); } console.log(`${c ? ' ✓' : ' ✗'} ${n}${d ? ' :: ' + d : ''}`); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else for (const h of this.handlers) h(m); }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
}
const connect = async (url) => { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')); }); return new CDP(ws); };

let page;
const js = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const lum = (r, g, b) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

(async () => {
  const list = await (await fetch(DEBUG + '/json/list')).json();
  const target = list.find((t) => t.type === 'page' && String(t.url || '').includes('127.0.0.1:8900')) || list.find((t) => t.type === 'page');
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  if (!String(target.url || '').includes('127.0.0.1:8900')) { await page.send('Page.navigate', { url: APP }); await sleep(2500); } else await sleep(400);
  await js(`document.querySelector('.nav-btn[data-view="lab"]').click()`);
  await sleep(600);

  const obj = JSON.parse(fs.readFileSync(CIRCUIT, 'utf8'));
  const tmpJson = 'C:/Users/liao9/AppData/Local/Temp/qa110_love.json';
  fs.writeFileSync(tmpJson, JSON.stringify(obj));
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { files: [tmpJson], nodeId });
  await sleep(900);
  ok('LOVE 已导入（67 元件）', (await js(`return document.querySelectorAll('#board .element').length`)) === 67);

  await js(`document.getElementById('btn-fit').click()`);
  await sleep(400);
  for (let i = 0; i < 12; i++) await js(`document.getElementById('btn-step').click()`);
  await sleep(300);
  await js(`if (!document.getElementById('btn-run').classList.contains('is-paused')) document.getElementById('btn-run').click()`);
  await sleep(400);
  ok('仿真已暂停（状态冻结）', (await js(`return document.getElementById('sim-state').textContent`)) === '已暂停');

  // ===== 原子取样：一次 eval 内完成「序列化 board → canvas → 逐灯取色」 =====
  const res = await js(`return (async()=>{
    const board = document.getElementById('board');
    const xml = new XMLSerializer().serializeToString(board);
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('svg load fail')); i.src = url; });
    const r0 = board.getBoundingClientRect();
    const cv = document.createElement('canvas');
    cv.width = Math.round(r0.width); cv.height = Math.round(r0.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#080d11'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const out = [];
    for (const el of board.querySelectorAll('.element-lamp')) {
      const lit = !!el.querySelector('rect[fill="#ffd23f"]');
      const body = el.querySelector(lit ? 'rect[fill="#ffd23f"]' : 'rect[fill="#2a3641"]');
      if (!body) continue;
      const rb = body.getBoundingClientRect();
      const cx = Math.round(rb.left - r0.left + rb.width / 2);
      const cy = Math.round(rb.top - r0.top + rb.height / 2);
      const d = ctx.getImageData(cx, cy, 1, 1).data;
      out.push({ id: el.getAttribute('data-el'), lit, x: cx, y: cy, px: [d[0], d[1], d[2]] });
    }
    return { w: cv.width, h: cv.height, lamps: out };
  })()`);
  const lamps = res.lamps;
  ok('取样 43 盏', lamps.length === 43, '实际 ' + lamps.length);

  const lumOf = (s) => lum(s.px[0], s.px[1], s.px[2]);
  const spread = (s) => Math.max(...s.px) - Math.min(...s.px);
  const litS = lamps.filter((s) => s.lit);
  const offS = lamps.filter((s) => !s.lit);
  R.notes.push(`亮 ${litS.length} / 灭 ${offS.length}`);

  // D2 亮/灭本体亮度比
  const mean = (a) => a.reduce((s, x) => s + lumOf(x), 0) / a.length;
  const mL = mean(litS), mO = mean(offS);
  R.notes.push(`平均亮度：亮 ${mL.toFixed(4)} vs 灭 ${mO.toFixed(4)}`);
  ok('D2 密集场景亮/灭本体亮度比 ≥ 5', mL / Math.max(mO, 1e-6) >= 5, `${(mL / Math.max(mO, 1e-6)).toFixed(1)}×`);
  // D3 灭态保持中性
  const maxSpread = Math.max(...offS.map(spread));
  ok('D3 灭态本体三通道极差 ≤ 30（中性）', maxSpread <= 30, `最大 ${maxSpread}`);
  // 最低亮灯 / 最高灭灯（最坏情况也要分得开）
  const minLit = Math.min(...litS.map(lumOf)), maxOff = Math.max(...offS.map(lumOf));
  R.notes.push(`最坏情况：最暗亮灯 L=${minLit.toFixed(4)} vs 最亮灭灯 L=${maxOff.toFixed(4)} → 比 ${(minLit / Math.max(maxOff, 1e-6)).toFixed(2)}×`);
  ok('D2b 最坏情况（最暗亮灯 vs 最亮灭灯）仍可分辨（≥1.5×）', minLit / Math.max(maxOff, 1e-6) >= 1.5, `${(minLit / Math.max(maxOff, 1e-6)).toFixed(2)}×`);

  // D1 相邻双亮中间必须是局部极小值
  let pair = null;
  for (let i = 0; i + 1 < lamps.length; i++) {
    if (lamps[i].lit && lamps[i + 1].lit && Math.abs(lamps[i].y - lamps[i + 1].y) < 8 && Math.abs(lamps[i].x - lamps[i + 1].x) < 90) { pair = [lamps[i], lamps[i + 1]]; break; }
  }
  if (pair) {
    const [a, b] = pair;
    const mid = await js(`return (async()=>{
      const board = document.getElementById('board');
      const xml = new XMLSerializer().serializeToString(board);
      const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('svg load fail')); i.src = url; });
      const r0 = board.getBoundingClientRect();
      const cv = document.createElement('canvas'); cv.width = Math.round(r0.width); cv.height = Math.round(r0.height);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#080d11'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const d = ctx.getImageData(${Math.round((a.x + b.x) / 2)}, ${Math.round(a.y)}, 1, 1).data;
      return [d[0], d[1], d[2]];
    })()`);
    const lmid = lum(mid[0], mid[1], mid[2]);
    R.notes.push(`相邻双亮：A L=${lumOf(a).toFixed(4)} 中点 L=${lmid.toFixed(4)} B L=${lumOf(b).toFixed(4)}`);
    ok('D1 相邻双亮中间是局部极小值（未糊成亮条）', lmid < Math.min(lumOf(a), lumOf(b)) * 0.75, `中点/灯心=${(lmid / Math.min(lumOf(a), lumOf(b))).toFixed(2)}`);
  } else R.notes.push('（当前帧无相邻双亮样本）');

  const shot = (await page.send('Page.captureScreenshot', { format: 'png' })).data;
  fs.writeFileSync(SHOT, Buffer.from(shot, 'base64'));
  R.notes.push('截图: ' + SHOT);

  console.log(`\n=== qa_110_dense_love 结果 ===`);
  console.log(`通过 ${R.pass}  失败 ${R.fail}`);
  for (const f of R.failures) console.log('  ✗ ' + f);
  for (const n of R.notes) console.log('  · ' + n);
  console.log(R.fail === 0 ? 'QA110_DENSE_LOVE_PASS' : 'QA110_DENSE_LOVE_FAIL');
  process.exit(R.fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });

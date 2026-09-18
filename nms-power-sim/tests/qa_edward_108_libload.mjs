#!/usr/bin/env node
/**
 * tests/qa_edward_108_libload.mjs — QA Edward 1.0.8 专项：实例库载入路径的开关同步
 * ---------------------------------------------------------------------------
 * 背景：导入（import-file）与撤销/重做路径都调用了 board.setWiresHidden(engine.getWiresHidden())
 *       同步线条隐藏偏好；但实例库「载入」（loadInstanceEntry）疑似缺失同步。
 * 方法：往 localStorage 写入一条 wiresHidden:true 的实例（等价于 UI 保存产物，
 *       data 为引擎 serialize 兼容结构）→ 打开实例库面板 → 点「载入」→
 *       断言按钮 aria-pressed / svg 根类 / 导线层可见性是否反映已保存的隐藏偏好。
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(process.argv[1]);
const PROJECT_ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(PROJECT_ROOT, '..');
const CDP = process.env.QA_CDP || 'http://127.0.0.1:9222';
const PORT = Number(process.env.QA_PORT) || 8900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP = process.env.QA_URL || `${URL_BASE}/nms-power-sim/index.html`;

const R = { pass: 0, fail: 0, failures: [] };
function ok(name, cond, detail = '') {
  if (cond) R.pass++; else { R.fail++; R.failures.push(name + (detail ? ' :: ' + detail : '')); }
  console.log(`${cond ? '  [OK]' : '  [NG]'} ${name}${detail ? ' :: ' + detail : ''}`);
  return !!cond;
}
async function portUp() {
  try { const res = await fetch(`${URL_BASE}/`, { signal: AbortSignal.timeout(1500) }); return res.status < 500; }
  catch { return false; }
}
async function ensureServer() {
  if (await portUp()) return null;
  const py = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: WORKSPACE, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await portUp()) return py; await sleep(250); }
  throw new Error('静态服务启动失败');
}
async function ensureEdge() {
  try { await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json(); return { proc: null }; }
  catch { /* 拉起 */ }
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa108lib-edge-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${new URL(CDP).port}`,
    `--user-data-dir=${dir.replace(/\\/g, '/')}`, '--remote-allow-origins=*', '--no-first-run',
    '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); return { proc }; }
    catch { await sleep(250); }
  }
  throw new Error('headless Edge 启动失败');
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}
const connect = (url) => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new Cdp(ws)); ws.onerror = () => rej(new Error('ws error')); });

const FN = `
  async () => {
    document.getElementById('view-switch').querySelector('[data-view="lab"]').click();
    await new Promise((r) => setTimeout(r, 300));
    // 预置一条 wiresHidden:true 的实例（等价 UI「存为实例」产物：data = engine.serialize() 结构）
    const entry = {
      name: 'QA隐藏实例',
      savedAt: new Date().toISOString(),
      count: 2,
      data: {
        simTime: 0, timeOfDay: 8, dayCycle: true, wireStyle: 'straight', wiresHidden: true,
        idSeq: 3, wireSeq: 1,
        elements: [
          { id: 'p1', type: 'power', x: 100, y: 100 },
          { id: 'l1', type: 'lamp', x: 320, y: 100 },
        ],
        wires: [],
      },
    };
    localStorage.setItem('nmsPowerSimLibrary.v1', JSON.stringify([entry]));
    // 打开实例库面板并点「载入」
    const btnLib = document.getElementById('btn-library');
    if (btnLib) btnLib.click();
    await new Promise((r) => setTimeout(r, 400));
    const item = document.querySelector('.lib-item[data-name="QA隐藏实例"]');
    if (!item) return { itemFound: false };
    const loadBtn = [...item.querySelectorAll('button')].find((b) => b.textContent === '载入');
    if (!loadBtn) return { itemFound: true, loadBtnFound: false };
    loadBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    const btn = document.getElementById('btn-wires-hidden');
    const svg = document.getElementById('board');
    const lw = svg.querySelector('.layer-wires');
    return {
      itemFound: true, loadBtnFound: true,
      aria: btn ? btn.getAttribute('aria-pressed') : null,
      cls: svg.classList.contains('wires-hidden'),
      wiresDisp: lw ? getComputedStyle(lw).display : null,
      nEls: svg.querySelectorAll('.element').length,
    };
  }
`;

let server = null, edge = null, targetId = null;
try {
  console.log('===== QA Edward · 1.0.8 实例库载入 × 线条隐藏同步 =====');
  server = await ensureServer();
  edge = await ensureEdge();
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json().catch(() => null);
  const tab = created || (await (await fetch(`${CDP}/json/list`)).json())[0];
  targetId = tab.id;
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: APP });
  await sleep(1800);
  const r = await page.send('Runtime.evaluate', { expression: `(${FN})()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const m = r.result.value;
  ok('实例条目渲染成功', m.itemFound === true, JSON.stringify(m).slice(0, 120));
  if (m.itemFound) {
    ok('「载入」按钮存在并已点击', m.loadBtnFound === true);
    ok('实例电路已载入画布', m.nEls >= 2, `elements=${m.nEls}`);
    console.log(`  · 载入后实际状态：aria-pressed=${m.aria} svg类=${m.cls} 导线层display=${m.wiresDisp}`);
    // 期望（与导入/撤销路径一致的行为）：保存的 wiresHidden:true 在载入后应同步到 UI
    ok('载入后 aria-pressed=true（与导入/撤销路径行为一致）', m.aria === 'true', `实际=${m.aria}`);
    ok('载入后 svg 根含 .wires-hidden 类', m.cls === true);
    ok('载入后导线层隐藏（反映保存的偏好）', m.wiresDisp === 'none', `display=${m.wiresDisp}`);
  }
} catch (e) {
  R.fail++;
  R.failures.push('执行异常：' + (e && e.stack ? e.stack : e));
  console.log('  [NG] 执行异常: ' + (e && e.message));
} finally {
  if (targetId) { try { await fetch(`${CDP}/json/close/${targetId}`); } catch { /* ignore */ } }
  if (edge && edge.proc) { try { edge.proc.kill(); } catch { /* ignore */ } }
  if (server) { try { server.kill(); } catch { /* ignore */ } }
}
console.log('\n===== 结果 =====');
console.log(`  通过 ${R.pass} / 失败 ${R.fail}（断言总数 ${R.pass + R.fail}）`);
console.log(R.fail === 0 ? 'QA108_LIBLOAD_PASS' : 'QA108_LIBLOAD_FAILED');
process.exit(R.fail === 0 ? 0 : 1);

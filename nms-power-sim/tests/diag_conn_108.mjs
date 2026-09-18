#!/usr/bin/env node
/** tests/diag_conn_108.mjs — 连通性诊断（一次性） */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CDP = 'http://127.0.0.1:9222';
// 1) start server via Node spawn (same pattern as perf_scroll)
const py = spawn('python', ['-m', 'http.server', '8900', '--bind', '127.0.0.1'], {
  cwd: 'C:\\Users\\liao9\\WorkBuddy\\我的工作1', stdio: 'ignore',
});
await sleep(2000);
// 2) node-side fetch
try {
  const r = await fetch('http://127.0.0.1:8900/nms-power-sim/index.html', { signal: AbortSignal.timeout(4000) });
  console.log('NODE fetch:', r.status);
} catch (e) { console.log('NODE fetch FAIL:', e.cause?.code || e.message); }

// 3) edge-side fetch via CDP
let ws = null;
try {
  const ver = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  ws = ver.webSocketDebuggerUrl;
  console.log('CDP up');
} catch (e) { console.log('CDP DOWN:', e.cause?.code || e.message); }

if (ws) {
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const wsUrl = created.webSocketDebuggerUrl;
  const sock = new WebSocket(wsUrl);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === mid) { sock.removeEventListener('message', h); resolve(m.result); }
    };
    sock.addEventListener('message', h);
    sock.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8900/nms-power-sim/index.html' });
  await sleep(2500);
  const r = await send('Runtime.evaluate', {
    expression: `fetch('/nms-power-sim/index.html').then(r=>r.status).catch(e=>'FETCH_ERR:'+e.message)`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('EDGE fetch:', JSON.stringify(r.result?.value));
  const nav = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  console.log('EDGE location:', JSON.stringify(nav.result?.value));
  await fetch(`${CDP}/json/close/${created.id}`);
}
py.kill();
console.log('DIAG_DONE');
process.exit(0);

#!/usr/bin/env node
/* =========================================================================
 * scripts/verify-cdp.mjs —— 通过 Chrome DevTools Protocol 对桌面壳做端到端验证
 *
 * 用法示例：
 *   开发版（渲染层直接指向 ../nms-power-sim）：
 *     node scripts/verify-cdp.mjs --mode dev --user-data ./.verify-data
 *   打包版（win-unpacked 或 portable exe）：
 *     node scripts/verify-cdp.mjs --bin dist/win-unpacked/NMS-PowerSim.exe \
 *          --user-data ./.verify-data
 *
 * 断言（stdout 最后一行以 RESULT_JSON: 前缀）：
 *   - URL 以 app://local/ 开头
 *   - 页面标题正确
 *   - 顶部三个视图页签（元件图鉴 / 仿真实验室 / 应用实例）都在
 *   - 元件图鉴渲染出 12 张卡片（1.0.9 起含「发光地板」）
 *   - 应用实例渲染出 7 张卡片，且 7 张参考图 naturalWidth > 0（治相对路径/MIME）
 *   - 载入「流水灯」预设并播放 12 秒，灯态至少出现 3 种不同组合
 *   - console error / 未捕获异常 / 失败请求 均为 0
 * ========================================================================= */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

const EXPECT_TITLE = '无人深空 · 电力模拟器';
const EXPECT_NAV = 3;
const EXPECT_CATALOG_CARDS = 12; // 1.0.9：新增「发光地板」glow_floor（原 11 卡 → 12 卡）
const EXPECT_PRESET_CARDS = 7;   // 含新增「太阳能板昼夜供电」实例（presets 7 个）
const PLAY_SECONDS = 12;
const MIN_DISTINCT_LAMP_STATES = 3;

/* --------------------------------------------------------------- 参数解析 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODE = args.mode === 'packaged' || args.bin ? 'packaged' : 'dev';
const PORT = String(args.port || 9333);
const USER_DATA = args['user-data'] ? path.resolve(args['user-data']) : null;
const BIN = args.bin ? path.resolve(args.bin) : null;
const TOTAL_TIMEOUT = Number(args.timeout || 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.error('[verify-cdp]', ...a); }

function killTree(pid) {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    try { process.kill(pid); } catch (__) { /* ignore */ }
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

/* --------------------------------------------------------- CDP 客户端 */
class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }

  attach() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || 'unknown'))));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          for (const fn of this.listeners) {
            try { fn(msg); } catch (_) { /* ignore */ }
          }
        }
      });
      this.ws.addEventListener('close', () => { this.closed = true; });
    });
  }

  onEvent(fn) { this.listeners.add(fn); }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // 每个 CDP 请求加超时：避免在渲染进程卡死时无限等待（导致整个验证挂起）
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 请求超时: ' + method)); }
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面求值异常: ' + text);
    }
    return res && res.result ? res.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

/* ------------------------------------------------------------ 主流程 */
async function main() {
  const port = PORT;
  const launchArgs = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  if (process.env.NMS_KEEP_GPU !== '1') {
    launchArgs.push('--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer');
  }
  if (process.argv.includes('--no-sandbox') || process.env.NMS_NO_SANDBOX) {
    launchArgs.push('--no-sandbox');
  }
  if (USER_DATA) launchArgs.push(`--user-data-dir=${USER_DATA}`);

  // 清理会改变 Electron 启动模式的环境变量
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  // 验证时不要自动弹开发者工具（否则会多出一个调试 target 干扰选择）
  childEnv.NMS_POWER_SIM_NO_DEVTOOLS = '1';

  let child;
  if (MODE === 'packaged') {
    if (!BIN || !fs.existsSync(BIN)) {
      throw new Error('打包版可执行文件不存在：' + (BIN || '(未提供 --bin)'));
    }
    child = spawn(BIN, launchArgs, { cwd: path.dirname(BIN), stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  } else {
    const electronPath = require('electron');
    child = spawn(electronPath, ['.', ...launchArgs], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  }

  child.stdout.on('data', (d) => process.stderr.write('[app] ' + d.toString()));
  child.stderr.on('data', (d) => process.stderr.write('[app-err] ' + d.toString()));
  child.on('exit', (code) => log('应用进程退出，code =', code));

  // 失败请求统计
  const errors = [];
  const failedRequests = [];
  let client = null;

  try {
    const deadline = Date.now() + TOTAL_TIMEOUT;

    // 1. 等待调试端口就绪并拿到 page target
    let target = null;
    while (Date.now() < deadline) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        target = pages.find((t) => String(t.url || '').startsWith('app://local')) || pages[0] || null;
        if (target) break;
      } catch (_) { /* 尚未就绪 */ }
      await sleep(400);
    }
    if (!target) throw new Error('超时：未能获取到 CDP page target');
    log('已获取 page target:', target.url);

    // 2. 连接
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.attach();
    log('已连接 DevTools');

    // 3. 采集控制台错误 / 异常 / 失败请求
    client.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        errors.push('console.error: ' + text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
        errors.push('uncaught: ' + text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry && msg.params.entry.level === 'error') {
        const ent = msg.params.entry;
        errors.push('log: ' + ent.text + ' @ ' + (ent.url || ''));
      } else if (msg.method === 'Network.loadingFailed') {
        failedRequests.push(msg.params.errorText || 'unknown');
      } else if (msg.method === 'Network.responseReceived') {
        const st = msg.params.response && msg.params.response.status;
        if (st && st >= 400) failedRequests.push(`${st} ${msg.params.response.url}`);
      }
    });

    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await client.send('Network.enable');
    await client.send('Page.setLifecycleEventsEnabled', { enabled: true });
    log('CDP 域已启用');

    // 4. 重新加载一次，捕获完整启动过程（含资源加载）
    const loadPromise = new Promise((resolve) => {
      const t = setTimeout(resolve, 15000);
      client.onEvent((msg) => {
        if (msg.method === 'Page.loadEventFired') { clearTimeout(t); resolve(); }
      });
    });
    await client.send('Page.reload', { ignoreCache: true });
    await loadPromise;
    log('reload 完成');

    // 5. 等待应用就绪（图鉴 12 张卡片渲染完成）
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = await client.evaluate(
          `document.querySelectorAll('#catalog-root .el-card').length === ${EXPECT_CATALOG_CARDS} && document.querySelectorAll('#view-switch .nav-btn').length === ${EXPECT_NAV}`
        );
      } catch (e) { ready = false; log('就绪轮询 evaluate 失败:', e && e.message); }
      if (ready) break;
      await sleep(300);
    }
    if (!ready) throw new Error('超时：应用未渲染出预期的图鉴卡片/页签');
    log('应用就绪（图鉴卡片已渲染）');

    // 6. 基础信息
    const info = await client.evaluate(`(() => ({
      href: location.href,
      title: document.title,
      navCount: document.querySelectorAll('#view-switch .nav-btn').length,
      navLabels: [...document.querySelectorAll('#view-switch .nav-btn')].map(b => b.textContent.trim()),
      catalogCards: document.querySelectorAll('#catalog-root .el-card').length,
      catalogTypes: [...document.querySelectorAll('#catalog-root .el-card')].map(c => c.dataset.type),
      presetCards: document.querySelectorAll('#preset-root .preset-card').length,
      desktopBridge: !!(window.nmsPowerSimDesktop && window.nmsPowerSimDesktop.isDesktop),
      bg: getComputedStyle(document.body).backgroundColor
    }))()`);

    // 7. 切换到「应用实例」并强制加载 6 张参考图（治 lazy + 相对路径/MIME）
    await client.evaluate(`(() => {
      const btn = document.querySelector('#view-switch .nav-btn[data-view="presets"]');
      if (btn) btn.click();
      document.querySelectorAll('#preset-root img').forEach(img => { img.loading = 'eager'; });
      return true;
    })()`);

    let imageInfo = { count: 0, loaded: 0, widths: [] };
    const imgDeadline = Date.now() + 12000;
    while (Date.now() < imgDeadline) {
      imageInfo = await client.evaluate(`(() => {
        const imgs = [...document.querySelectorAll('#preset-root img')];
        return {
          count: imgs.length,
          loaded: imgs.filter(i => i.naturalWidth > 0).length,
          widths: imgs.map(i => i.naturalWidth),
          srcs: imgs.map(i => i.getAttribute('src'))
        };
      })()`);
      if (imageInfo.count > 0 && imageInfo.loaded === imageInfo.count) break;
      await sleep(500);
    }

    // 8. 载入「流水灯」预设（第 3 个实例：延时信号传递 · 流水灯 · 环形振荡器版）
    const loadResult = await client.evaluate(`(() => {
      const cards = [...document.querySelectorAll('#preset-root .preset-card')];
      const titles = cards.map(c => (c.querySelector('h3') || {}).textContent || '');
      const idx = titles.findIndex(t => t.includes('流水灯'));
      if (idx < 0) return { ok: false, titles };
      const btn = cards[idx].querySelector('button.btn.primary');
      if (!btn) return { ok: false, titles, reason: 'no load button' };
      btn.click();
      return { ok: true, idx, title: titles[idx] };
    })()`);

    // 等待实验室视图可见 + 3 盏灯出现
    let labReady = false;
    const labDeadline = Date.now() + 8000;
    while (Date.now() < labDeadline) {
      try {
        labReady = await client.evaluate(`(() => {
          const lab = document.getElementById('view-lab');
          const lamps = document.querySelectorAll('#board .element-lamp').length;
          return !!lab && !lab.hidden && lamps === 3;
        })()`);
      } catch (_) { labReady = false; }
      if (labReady) break;
      await sleep(300);
    }

    // 9. 播放 12 秒并采样灯态（点亮 = lamp 图标 rect fill === #ffd23f）
    //    注意（1.0.9）：灯柱颜色已可选（props.color，7 色），这里判「点亮」用的是
    //    默认黄色 #ffd23f；预设电路的灯都是默认黄色，故仍成立。若日后改了预设灯色
    //    或新增彩色灯阵，必须同步改这里的判色，否则彩色灯会被误判为熄灭。
    const sampleExpr = `(() => {
      const groups = [...document.querySelectorAll('#board .element-lamp')];
      const lit = groups.map(g => [...g.querySelectorAll('rect')]
        .some(r => ((r.getAttribute('fill') || '')).toLowerCase() === '#ffd23f'));
      return {
        lit,
        mask: lit.map(b => b ? '1' : '0').join(''),
        simTime: (document.getElementById('time-label') || {}).textContent || '',
        simState: (document.getElementById('sim-state') || {}).textContent || ''
      };
    })()`;

    const samples = [];
    const distinct = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < PLAY_SECONDS * 1000) {
      const s = await client.evaluate(sampleExpr);
      if (s && typeof s.mask === 'string' && s.mask.length === 3) {
        samples.push(s.mask);
        distinct.add(s.mask);
      }
      await sleep(400);
    }

    const firstSample = samples[0] || '';
    const lastSimTime = (await client.evaluate(sampleExpr)).simTime;

    // 10. 汇总
    const result = {
      mode: MODE,
      bin: MODE === 'packaged' ? BIN : 'electron(dev)',
      href: info.href,
      title: info.title,
      urlOk: typeof info.href === 'string' && info.href.startsWith('app://local/'),
      titleOk: info.title === EXPECT_TITLE,
      nav: { count: info.navCount, labels: info.navLabels },
      navOk: info.navCount === EXPECT_NAV,
      catalog: { cards: info.catalogCards, types: info.catalogTypes },
      catalogOk: info.catalogCards === EXPECT_CATALOG_CARDS,
      presetCards: info.presetCards,
      presetCardsOk: info.presetCards === EXPECT_PRESET_CARDS,
      images: {
        count: imageInfo.count,
        loaded: imageInfo.loaded,
        widths: imageInfo.widths,
        srcs: imageInfo.srcs
      },
      imagesOk: imageInfo.count === EXPECT_PRESET_CARDS && imageInfo.loaded === imageInfo.count,
      desktopBridge: info.desktopBridge,
      bg: info.bg,
      lamp: {
        presetLoaded: loadResult.ok,
        presetTitle: loadResult.title || null,
        labReady,
        samples: samples.length,
        distinctStates: [...distinct].sort(),
        distinctCount: distinct.size,
        first: firstSample,
        lastSimTime
      },
      lampOk: loadResult.ok && labReady && distinct.size >= MIN_DISTINCT_LAMP_STATES,
      errorCount: errors.length,
      errors: errors.slice(0, 20),
      failedRequestCount: failedRequests.length,
      failedRequests: failedRequests.slice(0, 20),
      pass: false
    };

    result.pass =
      result.urlOk &&
      result.titleOk &&
      result.navOk &&
      result.catalogOk &&
      result.presetCardsOk &&
      result.imagesOk &&
      result.lampOk &&
      result.errorCount === 0 &&
      result.failedRequestCount === 0;

    console.log('RESULT_JSON:' + JSON.stringify(result));
    return result.pass ? 0 : 2;
  } finally {
    if (client) client.close();
    if (!args['keep-open']) killTree(child.pid);
  }
}

main()
  .then((code) => {
    setTimeout(() => process.exit(code), 800);
  })
  .catch((err) => {
    console.log('RESULT_JSON:' + JSON.stringify({ pass: false, fatal: String((err && err.stack) || err) }));
    setTimeout(() => process.exit(3), 300);
  });

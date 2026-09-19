/**
 * app.js — 应用入口
 * ---------------------------------------------------------------------------
 * 负责：三个视图的切换与渲染、元件图鉴、应用实例、仿真主循环、工具条、
 * 属性 / 状态面板、导出 / 导入。
 * ---------------------------------------------------------------------------
 */

import { createEngine, FIXED_DT, MAX_STEPS, LIGHT_COLOR_KEYS } from './engine.js';
import { GEOMETRY, drawIcon, ELEMENTS, EL_BY_ID, PALETTE_ORDER, RULE_TEXT, DELAY_TEXT, LIGHT_COLORS } from './catalog.js';
import { PRESETS, loadPreset } from './presets.js';
import { createBoard } from './board.js';

const NS = 'http://www.w3.org/2000/svg';

/* ============================ 引擎 & 画布 ============================ */

const engine = createEngine();

let paused = false;
let speed = 1;
let acc = 0;
let lastTs = 0;
let settleNeeded = false; // 暂停时的手动更改需要重算一次
let lastPresetId = null;

const dom = {
  nav: document.getElementById('view-switch'),
  views: {
    catalog: document.getElementById('view-catalog'),
    lab: document.getElementById('view-lab'),
    presets: document.getElementById('view-presets'),
  },
  catalogRoot: document.getElementById('catalog-root'),
  presetRoot: document.getElementById('preset-root'),
  board: document.getElementById('board'),
  canvasWrap: document.getElementById('canvas-wrap'),
  palette: document.getElementById('palette'),
  inspectorProps: document.getElementById('inspector-props'),
  inspectorStatus: document.getElementById('inspector-status'),
  timeLabel: document.getElementById('time-label'),
  simState: document.getElementById('sim-state'),
  btnRun: document.getElementById('btn-run'),
  btnReset: document.getElementById('btn-reset'),
  btnStep: document.getElementById('btn-step'),
  btnClear: document.getElementById('btn-clear'),
  btnExport: document.getElementById('btn-export'),
  btnImport: document.getElementById('btn-import'),
  importFile: document.getElementById('import-file'),
  speedBtns: [...document.querySelectorAll('.speed-btn')],
  wireStyleBtns: [...document.querySelectorAll('.wire-style-btn')],
  btnWiresHidden: document.getElementById('btn-wires-hidden'),
  labTitle: document.getElementById('lab-title'),
  zoomLabel: document.getElementById('zoom-label'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnFit: document.getElementById('btn-fit'),
  clockLabel: document.getElementById('clock-label'),
  timeRange: document.getElementById('time-range'),
  dayCycle: document.getElementById('day-cycle'),
  // 实例库 / 模态 / toast / 撤销重做（1.0.2 / 1.0.3 新增）
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnSaveInstance: document.getElementById('btn-save-instance'),
  btnLibrary: document.getElementById('btn-library'),
  libraryPanel: document.getElementById('library-panel'),
  libraryList: document.getElementById('library-list'),
  libraryClose: document.getElementById('library-close'),
  nameModal: document.getElementById('name-modal'),
  nameInput: document.getElementById('name-input'),
  nameError: document.getElementById('name-error'),
  nameOk: document.getElementById('name-modal-ok'),
  nameCancel: document.getElementById('name-modal-cancel'),
  nameTitle: document.getElementById('name-modal-title'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmText: document.getElementById('confirm-text'),
  confirmOk: document.getElementById('confirm-modal-ok'),
  confirmCancel: document.getElementById('confirm-modal-cancel'),
  toastRoot: document.getElementById('toast-root'),
};

/** 把画布视图变换写到 .canvas-wrap 的 CSS 自定义属性上（网格底纹跟随）。 */
function applyViewVars(v) {
  const w = dom.canvasWrap;
  w.style.setProperty('--k', String(v.k));
  w.style.setProperty('--tx', `${v.tx}px`);
  w.style.setProperty('--ty', `${v.ty}px`);
  w.classList.toggle('zoom-far', v.k < 0.55);
  w.classList.toggle('zoom-farther', v.k < 0.3);
  if (dom.zoomLabel) dom.zoomLabel.textContent = `${Math.round(v.k * 100)}%`;
}

const board = createBoard(dom.board, engine, {
  wrap: dom.canvasWrap,
  onViewChange: applyViewVars,
  /** 撤销历史：任何结构变更（放置/移动/连线/删除）真正发生前压入快照。 */
  onBeforeChange: () => pushHistory(),
  onChange: (kind) => {
    if (paused) settleNeeded = true;
    if (kind === 'armed' || kind === 'add' || kind === 'delete') {
      // 放置后可能自动解除武装：同步元件库高亮 / 画布武装态
      updatePaletteActive();
      dom.canvasWrap.classList.toggle('is-armed', !!board.getArmedType());
    }
    renderInspectorProps();
    renderInspectorStatus();
  },
});

/* ============================ 撤销 / 重做（快照式历史） ============================ */
/**
 * 快照式撤销历史（1.0.3）：每次结构变更「发生前」把 engine.serialize() 全量
 * 序列化成 JSON 字符串压入撤销栈；规模小（每快照几 KB～几十 KB），上限 50 步。
 * 语义说明：撤销/重做用 deserialize 全量恢复——simTime/timeOfDay 等运行态会随
 * 快照回退，对这种小规模教学仿真可接受且行为可预期。
 * 触发点（push）：放置元件（armed 单击 / 图鉴试用 / 拖放）、拖动结束（首帧移动前）、
 * 连线创建、删除（单个/批量/检查器删线）、检查器改属性、清空画布（保留该一步可撤销）。
 * 历史重置（reset）：导入 JSON / 载入预设 / 载入实例执行后清空两栈，避免跨文档串味。
 * 运行态操作（电源开关 / 暂停 / 时刻调整 / 走线样式）不进历史。
 */
const HISTORY_LIMIT = 50;
const historyStacks = { undo: [], redo: [] };

function updateHistoryButtons() {
  if (dom.btnUndo) dom.btnUndo.disabled = historyStacks.undo.length === 0;
  if (dom.btnRedo) dom.btnRedo.disabled = historyStacks.redo.length === 0;
}

/** 当前状态全量快照（字符串，不可变）。 */
function takeSnapshot() {
  return JSON.stringify(engine.serialize());
}

/** 结构变更前调用：压入当前状态；清空重做栈；超出上限丢最旧。 */
function pushHistory() {
  historyStacks.undo.push(takeSnapshot());
  if (historyStacks.undo.length > HISTORY_LIMIT) historyStacks.undo.shift();
  historyStacks.redo = [];
  updateHistoryButtons();
}

/** 清空画布专用：压入清除前快照且使其成为唯一可撤销一步（跨文档不串味）。 */
function pushHistoryKeepOnly() {
  historyStacks.undo = [takeSnapshot()];
  historyStacks.redo = [];
  updateHistoryButtons();
}

/** 导入 / 载入预设 / 载入实例后：彻底清空历史。 */
function resetHistory() {
  historyStacks.undo = [];
  historyStacks.redo = [];
  updateHistoryButtons();
}

/** 撤销/重做恢复后的公共收尾：清选择、同步走线样式与面板、暂停态重算。 */
function afterHistoryRestore() {
  board.clearSelection();
  board.setArmedType(null);
  updatePaletteActive();
  dom.canvasWrap.classList.remove('is-armed');
  board.setWireStyle(engine.getWireStyle());
  syncWireStyleUI();
  // 1.0.8：恢复随快照保存的线条隐藏偏好
  board.setWiresHidden(engine.getWiresHidden());
  syncWiresHiddenUI();
  if (paused) settleNeeded = true;
  dom.canvasWrap.classList.toggle('is-empty', engine.getElements().length === 0);
  board.render();
  renderInspectorProps();
  renderInspectorStatus();
  updateTimeLabel();
  updateClockLabel();
  updateHistoryButtons();
}

function undoHistory() {
  if (!historyStacks.undo.length) return;
  const snap = historyStacks.undo.pop();
  historyStacks.redo.push(takeSnapshot());
  engine.deserialize(snap);
  afterHistoryRestore();
}

function redoHistory() {
  if (!historyStacks.redo.length) return;
  const snap = historyStacks.redo.pop();
  historyStacks.undo.push(takeSnapshot());
  if (historyStacks.undo.length > HISTORY_LIMIT) historyStacks.undo.shift();
  engine.deserialize(snap);
  afterHistoryRestore();
}

if (dom.btnUndo) dom.btnUndo.addEventListener('click', undoHistory);
if (dom.btnRedo) dom.btnRedo.addEventListener('click', redoHistory);

/* ============================ 视图切换 ============================ */

function switchView(name) {
  for (const key in dom.views) {
    dom.views[key].hidden = key !== name;
  }
  dom.nav.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === name);
  });
  if (name === 'lab') {
    // 显示后再渲染，确保 svg 已获得尺寸
    requestAnimationFrame(() => board.render());
  }
}

dom.nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (btn) switchView(btn.dataset.view);
});

/* ============================ 元件图标工具 ============================ */

function iconSvg(type, view, opts = {}) {
  const box = GEOMETRY[type];
  const pad = opts.pad != null ? opts.pad : 22;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-box.w / 2 - pad} ${-box.h / 2 - pad} ${box.w + pad * 2} ${box.h + pad * 2}`);
  svg.setAttribute('class', opts.class || 'icon-svg');
  svg.setAttribute('aria-hidden', 'true');
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${drawIcon(type, view)}</svg>`, 'image/svg+xml');
  const src = doc.documentElement;
  while (src.firstChild) svg.appendChild(src.firstChild);
  return svg;
}

/* ============================ 视图 1 · 图鉴 ============================ */

function renderCatalog() {
  dom.catalogRoot.innerHTML = '';

  const rule = document.createElement('section');
  rule.className = 'rule-card';
  rule.innerHTML =
    `<h2 class="rule-title">总规则</h2>` +
    `<p class="rule-line">${RULE_TEXT}</p>` +
    `<p class="rule-line muted">${DELAY_TEXT}</p>`;
  dom.catalogRoot.appendChild(rule);

  const grid = document.createElement('div');
  grid.className = 'catalog-grid';

  for (const def of ELEMENTS) {
    const card = document.createElement('article');
    card.className = 'el-card';
    card.dataset.type = def.id;

    const head = document.createElement('div');
    head.className = 'el-card-head';
    head.appendChild(iconSvg(def.id, null, { class: 'el-card-icon' }));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'el-card-title';
    titleWrap.innerHTML =
      `<h3>${def.name}</h3>` +
      `<p class="en">${def.en}</p>` +
      `<p class="eid">内部 id：<code>${def.id}</code></p>`;
    head.appendChild(titleWrap);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'el-card-body';
    body.innerHTML =
      `<p class="principle">${def.principle}</p>` +
      `<p class="ports">端口：${def.portsText}</p>` +
      `<p class="usage">用法：${def.usage}</p>`;
    card.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'el-card-foot';
    const ind = document.createElement('span');
    ind.className = 'mini-indicator';
    ind.innerHTML = `<i class="sq green"></i>接通 <i class="sq red"></i>切断`;
    foot.appendChild(ind);

    if (def.id !== 'player') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = '在实验室中试用';
      btn.addEventListener('click', () => {
        switchView('lab');
        const spot = board.findFreeSpot();
        board.addAt(def.id, spot.x, spot.y);
        dom.labTitle.textContent = `仿真实验室 · 已放置：${def.name}`;
      });
      foot.appendChild(btn);
    }
    card.appendChild(foot);

    grid.appendChild(card);
  }
  dom.catalogRoot.appendChild(grid);
}

/* ============================ 视图 2 · 实验室 ============================ */

function renderPalette() {
  dom.palette.innerHTML = '';
  for (const type of PALETTE_ORDER) {
    const def = EL_BY_ID[type];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'palette-item';
    item.dataset.type = type;
    item.setAttribute('draggable', 'true');
    item.innerHTML =
      `<span class="pi-icon" data-icon="${type}"></span>` +
      `<span class="pi-name">${def.name}</span>`;
    item.querySelector('.pi-icon').appendChild(iconSvg(type, null, { class: 'pi-svg', pad: 14 }));

    item.addEventListener('click', () => {
      const armed = board.getArmedType() === type ? null : type;
      board.setArmedType(armed);
      updatePaletteActive();
      dom.canvasWrap.classList.toggle('is-armed', !!armed);
    });

    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', type);
      e.dataTransfer.effectAllowed = 'copy';
    });

    dom.palette.appendChild(item);
  }
}

function updatePaletteActive() {
  const armed = board.getArmedType();
  dom.palette.querySelectorAll('.palette-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.type === armed);
  });
}

dom.board.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
dom.board.addEventListener('drop', (e) => {
  e.preventDefault();
  const type = e.dataTransfer.getData('text/plain');
  if (!EL_BY_ID[type]) return;
  // 屏幕坐标 → 世界坐标（缩放 / 平移后仍能准确落点）
  const p = board.clientToWorld(e.clientX, e.clientY);
  board.addAt(type, p.x, p.y);
  board.setArmedType(null);
  updatePaletteActive();
  dom.canvasWrap.classList.remove('is-armed');
});

/* --------------------------- 属性 / 状态面板 --------------------------- */

/* ---------------------- 发光颜色选择（1.0.9） ---------------------- */
/**
 * 生成一行「发光颜色」色块（1.0.9，单选 / 多选共用）：点击即对所有目标批量改色。
 * 撤销语义：每次点到「不同于当前色」的颜色各压一次快照，因此可逐级撤销；
 * 点当前已选色视为空操作（不压快照、不改色、不重渲染）。
 * @param {Array<object>} targets 目标元件（lamp / glow_floor，可多个）
 * @returns {HTMLElement} 色块行容器
 */
function buildColorRow(targets) {
  const row = document.createElement('div');
  row.className = 'color-row';
  const currentColor = (targets[0] && LIGHT_COLORS[targets[0].props.color]) ? targets[0].props.color : 'yellow';
  for (const key of LIGHT_COLOR_KEYS) {
    const c = LIGHT_COLORS[key];
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `color-swatch${key === currentColor ? ' is-active' : ''}`;
    sw.dataset.color = key;
    sw.title = c.name;
    sw.setAttribute('aria-label', c.name);
    sw.innerHTML = `<span class="color-swatch-dot"></span><span class="color-swatch-name">${c.name}</span>`;
    sw.querySelector('.color-swatch-dot').style.setProperty('--sw', c.on);
    sw.addEventListener('click', () => {
      if (key === currentColor) return; // 点当前已选色 = 空操作，不压快照、不改、不重渲染
      pushHistory(); // 每次改色各压一次快照 → 逐级可撤销
      for (const el of targets) engine.setColor(el.id, key);
      board.render();
      renderInspectorProps(); // 重渲染属性面板，让当前色高亮跟上
    });
    row.appendChild(sw);
  }
  return row;
}

function renderInspectorProps() {
  const sel = board.getSelection();
  dom.inspectorProps.innerHTML = '';
  if (!sel) {
    dom.inspectorProps.innerHTML = '<p class="muted small">未选择任何元件。点击画布中的元件查看属性；空白处拖动平移画布，Ctrl+拖动可框选多个元件。</p>';
    return;
  }
  if (sel.kind === 'multi') {
    // 多选面板：数量概览 + 批量操作提示
    const names = sel.ids
      .map((id) => engine.getElement(id))
      .filter(Boolean)
      .map((e) => (EL_BY_ID[e.type] ? EL_BY_ID[e.type].name : e.type));
    const uniq = [...new Set(names)];
    const box = document.createElement('div');
    box.innerHTML =
      `<h3>已选中 ${sel.ids.length} 个元件</h3>` +
      `<p class="small muted">${uniq.join('、')}</p>` +
      `<p class="small muted">拖动任一选中元件可整组移动；按 Delete 键批量删除；按 Esc 取消选择。</p>`;
    dom.inspectorProps.appendChild(box);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger';
    del.textContent = `删除选中（${sel.ids.length}）`;
    del.addEventListener('click', () => {
      board.deleteSelection();
      renderInspectorProps();
      renderInspectorStatus();
    });
    dom.inspectorProps.appendChild(del);
    // 1.0.9：选择集含 lamp / glow_floor → 显示颜色行，点击对全部目标批量改色（LOVE 灯阵 43 盏一次改完）
    const colorTargets = sel.ids
      .map((id) => engine.getElement(id))
      .filter((e) => e && (e.type === 'lamp' || e.type === 'glow_floor'));
    if (colorTargets.length) {
      const field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = `<span>发光颜色（批量 · 共 ${colorTargets.length} 个）</span>`;
      field.appendChild(buildColorRow(colorTargets));
      dom.inspectorProps.appendChild(field);
    }
    return;
  }
  if (sel.kind === 'wire') {
    const w = engine.getWires().find((x) => x.id === sel.id);
    if (!w) {
      dom.inspectorProps.innerHTML = '<p class="muted small">导线已删除。</p>';
      return;
    }
    const a = engine.getElement(w.a.el);
    const b = engine.getElement(w.b.el);
    const name = (x) => (x ? (EL_BY_ID[x.type] ? EL_BY_ID[x.type].name : x.type) : '?');
    dom.inspectorProps.innerHTML =
      `<h3>导线 ${w.id}</h3>` +
      `<p class="small">A：${name(a)} · ${w.a.port}</p>` +
      `<p class="small">B：${name(b)} · ${w.b.port}</p>` +
      `<p class="small muted">在画布上右键该导线可重新选中；按 Delete 键或点下方按钮删除。</p>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger';
    del.textContent = '删除该导线';
    del.addEventListener('click', () => {
      board.deleteSelection();
      renderInspectorProps();
      renderInspectorStatus();
    });
    dom.inspectorProps.appendChild(del);
    return;
  }

  const elem = engine.getElement(sel.id);
  if (!elem) {
    dom.inspectorProps.innerHTML = '<p class="muted small">元件已删除。</p>';
    return;
  }
  const def = EL_BY_ID[elem.type];
  const box = document.createElement('div');
  box.innerHTML =
    `<h3>${def.name} <span class="eid">#${elem.id}</span></h3>` +
    `<p class="small muted">位置：(${Math.round(elem.x)}, ${Math.round(elem.y)})</p>`;
  dom.inspectorProps.appendChild(box);

  if (elem.type === 'prox_switch') {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.innerHTML = `<span>感应半径：<b>${Math.round(elem.props.radius)}</b> px</span>`;
    const rng = document.createElement('input');
    rng.type = 'range';
    rng.min = '40';
    rng.max = '320';
    rng.step = '10';
    rng.value = String(elem.props.radius);
    let radiusHistPushed = true; // 本次拖动是否已压过历史快照
    rng.addEventListener('pointerdown', () => { radiusHistPushed = false; });
    rng.addEventListener('input', () => {
      if (!radiusHistPushed) { radiusHistPushed = true; pushHistory(); } // 首次改动前压快照
      engine.setProp(elem.id, 'radius', Number(rng.value));
      wrap.querySelector('b').textContent = rng.value;
      board.render();
    });
    wrap.appendChild(rng);
    dom.inspectorProps.appendChild(wrap);
  }

  if (elem.type === 'button') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.textContent = '触发一次（接通 1 秒）';
    btn.addEventListener('click', () => {
      engine.triggerButton(elem.id);
      if (paused) settleNeeded = true;
    });
    dom.inspectorProps.appendChild(btn);
  }

  if (elem.type === 'wall_switch') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.textContent = '翻转开关';
    btn.addEventListener('click', () => {
      engine.toggleWallSwitch(elem.id);
      if (paused) settleNeeded = true;
      board.render();
    });
    dom.inspectorProps.appendChild(btn);
  }

  // 1.0.9：灯柱 / 发光地板 → 显示一行 7 个色块，点击即改色
  if (elem.type === 'lamp' || elem.type === 'glow_floor') {
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<span>发光颜色</span>';
    field.appendChild(buildColorRow([elem]));
    dom.inspectorProps.appendChild(field);
  }
}

/** 时刻（小时，0–24）→ 'HH:MM'，含 60 分钟进位。 */
function formatHourMinute(t) {
  let h = Math.floor(t);
  let m = Math.round((t % 1) * 60);
  if (m >= 60) {
    m = 0;
    h = (h + 1) % 24;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(h)}:${pad2(m)}`;
}

/* ---------- 状态面板（1.0.6 性能改造：按 id 缓存行 + 就地差量更新） ----------
 * 旧实现每次调用 innerHTML='' 后重建全部 .status-row（大电路 376 行 + 376 次
 * appendChild），剖析显示这是交互卡顿的第一热点（自耗时 74ms/爆发段）。
 * 新实现：
 *   - 行元素按元件 id 缓存在 statusRows，状态变化只改对应行的 textContent /
 *     class / 进度条宽度（值未变则零 DOM 写入），常态布局/绘制开销趋零；
 *   - 元件增删时只增删对应行；顺序变化（导入 / 撤销）时才整体重排一次。
 * 对外语义与旧版完全一致：行结构、类名（sr-name / sr-id / sr-state on|off|warn /
 * is-pending / timer-bar / timer-fill）与文案逐字保留。
 */
const statusRows = new Map();   // 元件 id → 行缓存 { row, stateEl, bar, fill, text, cls, pending, prog }
let statusClockState = null;    // 顶部时刻行的 .sr-state 元件
let statusClockText = '';       // 上次渲染的时刻文案
let statusEmptyEl = null;       // 「画布为空」提示元素
let statusOrderKey = '';        // 上次行顺序指纹（view.id 串联）

/** 状态面板：元件的展示文案。 */
function statusViewText(v) {
  if (v.type === 'power') return v.state.on === false ? '已关断' : '持续供电';
  if (v.type === 'solar_panel') return v.supplying ? '白天 · 供电中' : '夜晚 · 停止';
  if (v.type === 'lamp' || v.type === 'glow_floor') return v.lit ? '点亮' : '熄灭'; // 1.0.9：灯柱 / 发光地板共用
  if (v.type === 'door') return v.open ? '打开（通行）' : '关闭（拦截）';
  if (v.type === 'player') return '位置令牌';
  return v.conducting ? '接通' : '切断';
}

/** 状态面板：元件状态文字的颜色类。 */
function statusViewCls(v) {
  if (v.type === 'door') return v.open ? 'warn' : 'on';
  if (v.type === 'solar_panel') return v.supplying ? 'on' : 'off';
  if (v.type === 'power') return v.state.on === false ? 'off' : 'on';
  return (v.conducting || v.lit) ? 'on' : 'off';
}

function renderInspectorStatus() {
  const views = engine.getElementViews();
  const isDay = engine.getIsDay();
  const root = dom.inspectorStatus;

  // ---- 顶部固定的昼夜摘要行（始终第一条）----
  const clockText = `${formatHourMinute(engine.getTimeOfDay())} · ${isDay ? '白天' : '夜晚'}`;
  if (!statusClockState) {
    const clockRow = document.createElement('div');
    clockRow.className = 'status-row is-clock';
    clockRow.innerHTML =
      `<span class="sr-name">时刻</span><span class="sr-state ${isDay ? 'on' : 'off'}"></span>`;
    root.insertBefore(clockRow, root.firstChild);
    statusClockState = clockRow.querySelector('.sr-state');
    statusClockText = '';
  }
  if (statusClockText !== clockText) {
    statusClockText = clockText;
    statusClockState.textContent = clockText;
    statusClockState.classList.toggle('on', isDay);
    statusClockState.classList.toggle('off', !isDay);
  }

  // ---- 空画布提示 ----
  if (!views.length) {
    if (!statusEmptyEl) {
      statusEmptyEl = document.createElement('p');
      statusEmptyEl.className = 'muted small';
      statusEmptyEl.textContent = '画布为空。';
      root.appendChild(statusEmptyEl);
    }
    if (statusRows.size) {
      for (const entry of statusRows.values()) entry.row.remove();
      statusRows.clear();
      statusOrderKey = '';
    }
    return;
  }
  if (statusEmptyEl) { statusEmptyEl.remove(); statusEmptyEl = null; }

  // ---- 逐行差量更新（值未变零 DOM 写入）----
  const seen = new Set();
  for (const v of views) {
    seen.add(v.id);
    let entry = statusRows.get(v.id);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'status-row';
      row.innerHTML =
        `<span class="sr-name">${EL_BY_ID[v.type] ? EL_BY_ID[v.type].name : v.type}` +
        `<i class="sr-id">#${v.id}</i></span><span class="sr-state"></span>`;
      // 延迟元件的 1 秒倒计时进度条（非延迟元件保持隐藏）
      const bar = document.createElement('div');
      bar.className = 'timer-bar';
      const fill = document.createElement('div');
      fill.className = 'timer-fill';
      bar.appendChild(fill);
      bar.style.display = 'none';
      row.appendChild(bar);
      entry = {
        row,
        stateEl: row.querySelector('.sr-state'),
        bar, fill,
        text: null, cls: null, pending: null, prog: -1,
      };
      statusRows.set(v.id, entry);
    }

    const stateText = statusViewText(v);
    if (entry.text !== stateText) {
      entry.text = stateText;
      entry.stateEl.textContent = stateText;
    }
    const cls = statusViewCls(v);
    if (entry.cls !== cls) {
      entry.cls = cls;
      entry.stateEl.className = `sr-state ${cls}`;
    }

    // 延迟元件的倒计时进度（仅 pending 翻转 / 进度百分比变化时写 DOM）
    const isDelay = v.type === 'auto_switch' || v.type === 'inverter';
    if (isDelay) {
      const pending = !!v.pending;
      const prog = Math.round((v.timerProgress || 0) * 100);
      if (entry.pending !== pending) {
        entry.pending = pending;
        entry.bar.style.display = pending ? '' : 'none';
        entry.bar.title = pending ? '正在计时，1 秒后切换' : '当前稳定';
        entry.row.classList.toggle('is-pending', pending);
      }
      if (entry.prog !== prog) {
        entry.prog = prog;
        entry.fill.style.width = `${prog}%`;
      }
    } else if (entry.pending !== false) {
      // 非延迟元件（或类型转换后）：确保进度条隐藏
      entry.pending = false;
      entry.bar.style.display = 'none';
      entry.row.classList.remove('is-pending');
      entry.prog = -1;
    }
  }

  // ---- 移除已消失元件的行 ----
  if (statusRows.size !== seen.size) {
    for (const [id, entry] of statusRows) {
      if (!seen.has(id)) {
        entry.row.remove();
        statusRows.delete(id);
      }
    }
  }

  // ---- 顺序维护：视图顺序 = 元件插入序，仅指纹变化（导入 / 撤销 / 增删）时重排 ----
  let orderKey = '';
  for (const v of views) orderKey += `${v.id}|`;
  if (orderKey !== statusOrderKey) {
    statusOrderKey = orderKey;
    for (const v of views) {
      const entry = statusRows.get(v.id);
      if (entry) root.appendChild(entry.row); // appendChild 同时负责移动到正确位置
    }
  }
}

/* --------------------------- 工具条 --------------------------- */

function updateRunBtn() {
  dom.btnRun.textContent = paused ? '▶ 运行' : '❚❚ 暂停';
  dom.btnRun.classList.toggle('is-paused', paused);
  dom.simState.textContent = paused ? '已暂停' : '运行中';
  dom.simState.classList.toggle('paused', paused);
}

dom.btnRun.addEventListener('click', () => {
  paused = !paused;
  if (!paused) acc = 0;
  updateRunBtn();
});

dom.btnStep.addEventListener('click', () => {
  // 单步 +1 秒（暂停或运行状态均可）
  for (let i = 0; i < 60; i++) engine.tick(FIXED_DT);
  board.render();
  renderInspectorStatus();
  updateTimeLabel();
});

dom.btnClear.addEventListener('click', () => {
  if (engine.getElements().length) pushHistoryKeepOnly(); // 清空前快照（且仅此一步可撤销）
  engine.reset();
  lastPresetId = null;
  acc = 0;
  board.setArmedType(null);
  board.clearSelection();
  updatePaletteActive();
  dom.canvasWrap.classList.remove('is-armed');
  dom.canvasWrap.classList.add('is-empty');
  dom.labTitle.textContent = '仿真实验室';
  board.render();
  renderInspectorProps();
  renderInspectorStatus();
});

dom.btnReset.addEventListener('click', () => {
  if (lastPresetId) {
    const p = PRESETS.find((x) => x.id === lastPresetId);
    if (p) loadPreset(engine, p);
  } else {
    softResetStates();
  }
  acc = 0;
  board.render();
  renderInspectorStatus();
  updateTimeLabel();
});

/** 复位：保留拓扑，把各元件状态恢复为初始值。 */
function softResetStates() {
  for (const elem of engine.getElements()) {
    const s = elem.state;
    s.conducting = false;
    s.timer = 0;
    s.lit = false;
    if (elem.type === 'wall_switch') s.on = false;
    if (elem.type === 'button') s.pulse = 0;
    if (elem.type === 'door') s.open = true;
  }
  const data = engine.serialize();
  data.simTime = 0;
  engine.deserialize(data);
}

dom.btnExport.addEventListener('click', () => {
  const json = engine.serializeJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nms-power-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

dom.btnImport.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', () => {
  const file = dom.importFile.files && dom.importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const ok = engine.deserialize(String(reader.result));
    lastPresetId = null;
    acc = 0;
    board.clearSelection();
    resetHistory(); // 导入视为新文档：历史清空，避免跨文档撤销串味
    // 暂停态导入后需立即重算一次通电状态（与 board 的 onChange → settle 行为一致），
    // 否则导入「电源 → 灯」类电路后灯会保持熄灭，直到用户手动恢复运行。
    if (paused) settleNeeded = true;
    // 恢复随 JSON 保存的走线样式（缺省 / 旧 JSON → 直线）
    board.setWireStyle(engine.getWireStyle());
    syncWireStyleUI();
    // 恢复随 JSON 保存的线条隐藏偏好（缺省 / 旧 JSON → 显示）
    board.setWiresHidden(engine.getWiresHidden());
    syncWiresHiddenUI();
    dom.canvasWrap.classList.toggle('is-empty', engine.getElements().length === 0);
    board.render();
    renderInspectorProps();
    renderInspectorStatus();
    updateTimeLabel();
    dom.labTitle.textContent = ok ? '仿真实验室 · 已导入电路' : '仿真实验室 · 导入失败';
  };
  reader.readAsText(file);
  dom.importFile.value = '';
});

for (const b of dom.speedBtns) {
  b.addEventListener('click', () => {
    speed = Number(b.dataset.speed) || 1;
    dom.speedBtns.forEach((x) => x.classList.toggle('is-active', x === b));
  });
}

/* 走线样式切换（直线 / 曲线）：同步 board、engine（随序列化保存）与按钮高亮。 */
function syncWireStyleUI() {
  const cur = board.getWireStyle();
  dom.wireStyleBtns.forEach((x) => x.classList.toggle('is-active', x.dataset.style === cur));
}
for (const b of dom.wireStyleBtns) {
  b.addEventListener('click', () => {
    board.setWireStyle(b.dataset.style);
    engine.setWireStyle(board.getWireStyle());
    syncWireStyleUI();
  });
}

/* 线条隐藏开关（1.0.8）：同步 board（O(1) 类切换）、engine（随序列化保存）与按钮按下态。 */
function syncWiresHiddenUI() {
  if (!dom.btnWiresHidden) return;
  const hidden = board.getWiresHidden();
  dom.btnWiresHidden.classList.toggle('is-active', hidden);
  dom.btnWiresHidden.setAttribute('aria-pressed', hidden ? 'true' : 'false');
}
if (dom.btnWiresHidden) {
  dom.btnWiresHidden.addEventListener('click', () => {
    const next = !board.getWiresHidden();
    board.setWiresHidden(next);
    engine.setWiresHidden(next);
    syncWiresHiddenUI();
  });
}

function updateTimeLabel() {
  dom.timeLabel.textContent = `t = ${engine.getSimTime().toFixed(2)} s`;
}

/* ---------------- 视图控件（缩放 / 适应视图） ---------------- */

if (dom.btnZoomIn) dom.btnZoomIn.addEventListener('click', () => board.zoomBy(1.25));
if (dom.btnZoomOut) dom.btnZoomOut.addEventListener('click', () => board.zoomBy(1 / 1.25));
if (dom.btnFit) dom.btnFit.addEventListener('click', () => board.fitToContent());

/* ---------------- 昼夜时间控件 ---------------- */

/** 刷新工具条时钟标签 / 昼夜循环勾选 / 时刻滑块。 */
function updateClockLabel() {
  const t = engine.getTimeOfDay();
  const isDay = engine.getIsDay();
  if (dom.clockLabel) {
    dom.clockLabel.textContent = `${isDay ? '☀' : '🌙'} ${formatHourMinute(t)} ${isDay ? '白天' : '夜晚'}`;
  }
  if (dom.dayCycle) dom.dayCycle.checked = engine.getDayCycle();
  // 用户正在拖动滑块时不覆盖其值
  if (dom.timeRange && document.activeElement !== dom.timeRange) {
    dom.timeRange.value = String(t);
  }
}

if (dom.timeRange) {
  dom.timeRange.addEventListener('input', () => {
    engine.setTimeOfDay(Number(dom.timeRange.value));
    if (paused) settleNeeded = true; // 暂停状态下也立即重算一次通电状态
    board.render();
    renderInspectorStatus();
    updateClockLabel();
  });
}
if (dom.dayCycle) {
  dom.dayCycle.addEventListener('change', () => {
    engine.setDayCycle(dom.dayCycle.checked);
  });
}

/* ============================ 实例库（localStorage 持久化） ============================ */
/**
 * 存储结构：localStorage key `nmsPowerSimLibrary.v1` → JSON 数组（新的插前面）：
 *   [{ name, savedAt(ISO), count(元件数), data: engine.serialize() }, ...]
 * Electron 下落在 userData（便携版为 exe 同目录 NmsPowerSimData/Local Storage），
 * 浏览器模式同样可用；读写全程 try-catch，异常只提示不崩页。
 */
const LIB_KEY = 'nmsPowerSimLibrary.v1';

/** 读取实例库（损坏 / 不可用 → 返回空数组，绝不抛出）。 */
function libRead() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.name === 'string') : [];
  } catch (e) {
    return [];
  }
}

/** 写入实例库。失败（隐私模式 / 超限）→ toast 提示并返回 false。 */
function libWrite(list) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    toast('保存失败：本地存储不可用或已满', 3000);
    return false;
  }
}

/** 轻提示（自动消失）。 */
function toast(msg, ms = 2200) {
  if (!dom.toastRoot) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  dom.toastRoot.appendChild(t);
  requestAnimationFrame(() => t.classList.add('is-show'));
  setTimeout(() => {
    t.classList.remove('is-show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/* ---------------- 自制命名模态（Electron 渲染进程无 window.prompt） ---------------- */

let nameModalResolve = null;

/**
 * 弹出命名输入模态。
 * @param {string} title 标题
 * @param {string} placeholder 输入提示
 * @param {string} [initial] 初始值
 * @returns {Promise<string|null>} 确定返回输入文本（未 trim），取消返回 null
 */
function openNameModal(title, placeholder, initial = '') {
  return new Promise((resolve) => {
    nameModalResolve = resolve;
    dom.nameTitle.textContent = title;
    dom.nameInput.value = initial;
    dom.nameInput.placeholder = placeholder || '';
    dom.nameError.textContent = '';
    dom.nameModal.hidden = false;
    setTimeout(() => dom.nameInput.focus(), 30);
  });
}

/** 关闭命名模态并回传结果（value 为 null 表示取消）。 */
function closeNameModal(value) {
  if (dom.nameModal.hidden) return false;
  dom.nameModal.hidden = true;
  if (nameModalResolve) { nameModalResolve(value); nameModalResolve = null; }
  return true;
}

/** 命名模态内的确认：空名 / 纯空格不允许保存（模态保持打开并提示）。 */
function confirmNameModal() {
  const v = dom.nameInput.value;
  if (!v.trim()) {
    dom.nameError.textContent = '名称不能为空';
    dom.nameInput.focus();
    return;
  }
  closeNameModal(v);
}

if (dom.nameOk) dom.nameOk.addEventListener('click', confirmNameModal);
if (dom.nameCancel) dom.nameCancel.addEventListener('click', () => closeNameModal(null));
if (dom.nameInput) {
  dom.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmNameModal(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeNameModal(null); }
  });
}

/* ---------------- 自制确认模态（替代 window.confirm，可被自动化测试驱动） ---------------- */

let confirmModalResolve = null;

/**
 * 弹出确认模态。
 * @param {string} text 正文
 * @returns {Promise<boolean>} 确定 true / 取消 false
 */
function openConfirmModal(text) {
  return new Promise((resolve) => {
    confirmModalResolve = resolve;
    dom.confirmText.textContent = text;
    dom.confirmModal.hidden = false;
    setTimeout(() => dom.confirmOk.focus(), 30);
  });
}

function closeConfirmModal(result) {
  if (dom.confirmModal.hidden) return false;
  dom.confirmModal.hidden = true;
  if (confirmModalResolve) { confirmModalResolve(result); confirmModalResolve = null; }
  return true;
}

if (dom.confirmOk) dom.confirmOk.addEventListener('click', () => closeConfirmModal(true));
if (dom.confirmCancel) dom.confirmCancel.addEventListener('click', () => closeConfirmModal(false));

/* ---------------- 实例库面板 ---------------- */

/** 时间 → 'MM-DD HH:mm' 本地格式。 */
function formatSavedAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isLibraryOpen() {
  return !!(dom.libraryPanel && !dom.libraryPanel.hidden);
}

function openLibraryPanel() {
  if (!dom.libraryPanel) return;
  dom.libraryPanel.hidden = false;
  requestAnimationFrame(() => dom.libraryPanel.classList.add('is-open'));
  renderLibraryPanel();
}

function closeLibraryPanel() {
  if (!dom.libraryPanel || dom.libraryPanel.hidden) return false;
  dom.libraryPanel.classList.remove('is-open');
  setTimeout(() => { dom.libraryPanel.hidden = true; }, 220);
  return true;
}

/** 渲染实例库列表（按保存时间倒序）。 */
function renderLibraryPanel() {
  if (!dom.libraryList) return;
  const list = libRead().slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  dom.libraryList.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small lib-empty';
    p.textContent = '暂无保存的实例。画布上搭好电路后点「存为实例」保存到这里。';
    dom.libraryList.appendChild(p);
    return;
  }
  for (const entry of list) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.dataset.name = entry.name;
    const info = document.createElement('div');
    info.className = 'lib-info';
    info.innerHTML =
      `<span class="lib-name"></span>` +
      `<span class="lib-meta">${formatSavedAt(entry.savedAt)} · ${entry.count} 个元件</span>`;
    info.querySelector('.lib-name').textContent = entry.name;
    item.appendChild(info);

    const ops = document.createElement('div');
    ops.className = 'lib-ops';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    ops.appendChild(mk('载入', '', () => loadInstanceEntry(entry)));
    ops.appendChild(mk('覆盖', '', () => overwriteInstanceEntry(entry)));
    ops.appendChild(mk('删除', 'danger', () => deleteInstanceEntry(entry)));
    item.appendChild(ops);
    dom.libraryList.appendChild(item);
  }
}

/** 载入实例：直接载入并提示（不二次确认）。 */
function loadInstanceEntry(entry) {
  const data = entry && entry.data;
  const ok = engine.deserialize(data && typeof data === 'object' ? data : JSON.stringify(data || null));
  if (!ok) {
    toast('实例数据无效，载入失败');
    return;
  }
  lastPresetId = null;
  acc = 0;
  board.clearSelection();
  resetHistory(); // 载入实例视为新文档：历史清空
  if (paused) settleNeeded = true;
  // 恢复随 JSON 保存的走线样式（缺省 / 旧 JSON → 直线）
  board.setWireStyle(engine.getWireStyle());
  syncWireStyleUI();
  // 恢复随 JSON 保存的线条隐藏偏好（缺省 / 旧 JSON → 显示）
  board.setWiresHidden(engine.getWiresHidden());
  syncWiresHiddenUI();
  dom.canvasWrap.classList.remove('is-empty');
  dom.labTitle.textContent = `仿真实验室 · 实例：${entry.name}`;
  switchView('lab');
  requestAnimationFrame(() => {
    board.fitToContent();
    updateClockLabel();
    renderInspectorProps();
    renderInspectorStatus();
    updateTimeLabel();
  });
  toast(`已载入实例「${entry.name}」`);
}

/** 用当前画布内容覆盖指定实例条目。 */
function overwriteInstanceEntry(entry) {
  const list = libRead();
  const target = list.find((x) => x.name === entry.name);
  if (!target) {
    toast('实例已不存在，请刷新面板');
    renderLibraryPanel();
    return;
  }
  target.savedAt = new Date().toISOString();
  target.count = engine.getElements().length;
  target.data = engine.serialize();
  if (libWrite(list)) {
    toast(`已用当前画布覆盖「${entry.name}」`);
    renderLibraryPanel();
  }
}

/** 删除实例条目（二次确认）。 */
async function deleteInstanceEntry(entry) {
  const yes = await openConfirmModal(`确定删除实例「${entry.name}」？此操作不可恢复。`);
  if (!yes) return;
  const list = libRead();
  const idx = list.findIndex((x) => x.name === entry.name);
  if (idx >= 0) list.splice(idx, 1);
  if (libWrite(list)) {
    toast(`已删除「${entry.name}」`);
    renderLibraryPanel();
  }
}

/** 「存为实例」主流程：命名 → 重名处理（覆盖确认 / 自动加序号）→ 持久化。 */
async function saveInstanceFlow() {
  if (!engine.getElements().length) {
    toast('画布为空，先搭一个电路再保存');
    return;
  }
  const name = await openNameModal('存为实例', '输入实例名称，如：我的双控灯');
  if (name === null) return;
  const trimmed = name.trim();
  const list = libRead();
  const existing = list.find((x) => x.name === trimmed);
  if (existing) {
    const overwrite = await openConfirmModal(`实例「${trimmed}」已存在，覆盖同名实例？`);
    if (overwrite) {
      existing.savedAt = new Date().toISOString();
      existing.count = engine.getElements().length;
      existing.data = engine.serialize();
      if (libWrite(list)) toast(`已覆盖实例「${trimmed}」`);
    } else {
      // 自动加序号后缀：name-2、name-3 …
      let n = 2;
      while (list.some((x) => x.name === `${trimmed}-${n}`)) n++;
      const newName = `${trimmed}-${n}`;
      list.unshift({
        name: newName,
        savedAt: new Date().toISOString(),
        count: engine.getElements().length,
        data: engine.serialize(),
      });
      if (libWrite(list)) toast(`已保存为「${newName}」`);
    }
  } else {
    list.unshift({
      name: trimmed,
      savedAt: new Date().toISOString(),
      count: engine.getElements().length,
      data: engine.serialize(),
    });
    if (libWrite(list)) toast(`已保存实例「${trimmed}」`);
  }
  renderLibraryPanel();
}

if (dom.btnSaveInstance) dom.btnSaveInstance.addEventListener('click', saveInstanceFlow);
if (dom.btnLibrary) {
  dom.btnLibrary.addEventListener('click', () => {
    if (isLibraryOpen()) closeLibraryPanel();
    else openLibraryPanel();
  });
}
if (dom.libraryClose) dom.libraryClose.addEventListener('click', closeLibraryPanel);

/* ============================ 视图 3 · 应用实例 ============================ */

function renderPresets() {
  dom.presetRoot.innerHTML = '';
  const intro = document.createElement('section');
  intro.className = 'rule-card';
  intro.innerHTML =
    `<h2 class="rule-title">应用实例</h2>` +
    `<p class="rule-line muted">下面 7 个电路都来自教程素材，可直接「载入实验室」上电运行。载入后可在实验室中拖动元件、点击开关、拖动玩家令牌观察效果。</p>`;
  dom.presetRoot.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'preset-list';

  for (const p of PRESETS) {
    const card = document.createElement('article');
    card.className = 'preset-card';

    const left = document.createElement('div');
    left.className = 'preset-media';
    const img = document.createElement('img');
    img.src = p.image;
    img.alt = p.title + ' 参考图';
    img.loading = 'lazy';
    left.appendChild(img);
    card.appendChild(left);

    const right = document.createElement('div');
    right.className = 'preset-info';

    const partsHtml = p.parts.map((x) => `<li>${x.name} × ${x.qty}</li>`).join('');
    const howtoHtml = p.howto.map((x) => `<li>${x}</li>`).join('');
    right.innerHTML =
      `<h3>${p.title}</h3>` +
      `<p class="tag">${p.tag}</p>` +
      `<p class="summary">${p.summary}</p>` +
      `<h4>接法</h4><ol class="howto">${howtoHtml}</ol>` +
      `<p class="keypoint">💡 ${p.keyPoint}</p>` +
      `<h4>元件清单</h4><ul class="parts">${partsHtml}</ul>`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = '载入实验室';
    btn.addEventListener('click', () => loadIntoLab(p));
    right.appendChild(btn);

    card.appendChild(right);
    list.appendChild(card);
  }
  dom.presetRoot.appendChild(list);
}

function loadIntoLab(preset) {
  loadPreset(engine, preset);
  lastPresetId = preset.id;
  acc = 0;
  paused = false;
  board.clearSelection();
  resetHistory(); // 载入预设视为新文档：历史清空
  updateRunBtn();
  dom.canvasWrap.classList.remove('is-empty');
  dom.labTitle.textContent = `仿真实验室 · ${preset.title}`;
  switchView('lab');
  requestAnimationFrame(() => {
    // 载入实例后自动适应视图：避免预设电路横向超出画布被裁掉
    board.fitToContent();
    updateClockLabel();
    renderInspectorProps();
    renderInspectorStatus();
    updateTimeLabel();
  });
}

/* ============================ 主循环 ============================ */

function frame(ts) {
  if (!lastTs) lastTs = ts;
  const real = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;

  if (paused) {
    if (settleNeeded) {
      engine.tick(0.000001); // 仅重算通电状态，几乎不推进时间
      settleNeeded = false;
    }
  } else {
    acc += real * speed;
    let steps = 0;
    while (acc >= FIXED_DT && steps < MAX_STEPS) {
      engine.tick(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_STEPS) acc = 0; // 卡顿后丢弃残余，避免一次补太多
  }

  board.render();
  updateTimeLabel();
  requestAnimationFrame(frame);
}

let statusThrottle = 0;
function statusLoop(ts) {
  if (ts - statusThrottle > 120) {
    statusThrottle = ts;
    renderInspectorStatus();
    updateClockLabel();
  }
  requestAnimationFrame(statusLoop);
}

/* ============================ 键盘快捷键 ============================ */

window.addEventListener('keydown', (e) => {
  // 1.0.9：按住 Ctrl/⌘ 时给画布加 is-marquee-ready 类（十字光标提示「可框选」）。
  // 放在文本输入框拦截之前——它是纯光标状态提示，须始终反映 Ctrl 物理状态。
  if (e.key === 'Control' && dom.canvasWrap) {
    dom.canvasWrap.classList.add('is-marquee-ready');
  }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 文本输入框聚焦时不触发（模态输入不受影响）
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoHistory(); else undoHistory();
      return;
    }
    if (k === 'y') {
      e.preventDefault();
      redoHistory();
      return;
    }
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // 选择集非空 → 批量删除（级联相连导线）；否则删除当前选中的元件 / 导线
    if (board.deleteSelection()) {
      e.preventDefault();
      dom.canvasWrap.classList.toggle('is-empty', engine.getElements().length === 0);
    }
  } else if (e.key === 'Escape') {
    // Esc 优先级：关闭命名模态 → 关闭确认模态 → 关闭实例库面板 → 清除选择 / 解除武装
    if (closeNameModal(null)) { /* 已处理 */ }
    else if (closeConfirmModal(false)) { /* 已处理 */ }
    else if (closeLibraryPanel()) { /* 已处理 */ }
    else {
      board.clearSelection();
      board.setArmedType(null);
      updatePaletteActive();
      dom.canvasWrap.classList.remove('is-armed');
    }
  } else if (e.key === ' ') {
    // 1.0.9：空格 = 显示 / 隐藏线条（长按不反复切换）。同步 board（O(1) 类切换）、
    // engine（随序列化保存）与工具条按钮高亮。
    e.preventDefault();
    if (e.repeat) return;
    const next = !board.getWiresHidden();
    board.setWiresHidden(next);
    engine.setWiresHidden(next);
    syncWiresHiddenUI();
  }
});

window.addEventListener('keyup', (e) => {
  // 1.0.9：松开 Ctrl/⌘ 移除 is-marquee-ready 类（不拦截输入框，避免残留态）。
  if (e.key === 'Control' && dom.canvasWrap) {
    dom.canvasWrap.classList.remove('is-marquee-ready');
  }
});

// 窗口失焦时复位「框选准备」类，避免「按住 Ctrl + 切窗」后卡在十字光标态
window.addEventListener('blur', () => {
  if (dom.canvasWrap) dom.canvasWrap.classList.remove('is-marquee-ready');
});

/* ============================ 启动 ============================ */

function boot() {
  renderCatalog();
  renderPalette();
  renderPresets();

  dom.canvasWrap.classList.add('is-empty');
  updateRunBtn();
  updateHistoryButtons();
  syncWireStyleUI();
  syncWiresHiddenUI();
  renderInspectorProps();
  renderInspectorStatus();
  updateTimeLabel();
  updateClockLabel();
  switchView('catalog');

  requestAnimationFrame(frame);
  requestAnimationFrame(statusLoop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

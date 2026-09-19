/**
 * board.js — 画布：SVG 渲染 + 拖拽 / 连线交互 + 视图缩放平移 + 直线 / 曲线走线
 * ---------------------------------------------------------------------------
 * 与 engine 解耦：board 只读取 engine 的元素与导线，并通过 engine 的公开方法
 * 修改（addElement / addWire / moveElement / removeElement / removeWire ...）。
 *
 * 坐标系统：
 *   - 世界坐标（world）：元件 / 端口的逻辑坐标，与 engine 完全一致。
 *   - 屏幕坐标（client）：浏览器视口像素。
 *   - 视图变换 view = { k, tx, ty }：screen = world * k + t。
 *     <g class="viewport" transform="translate(tx ty) scale(k)"> 承载全部图层，
 *     因此放置 / 拖动 / 连线 / 拖令牌等手势全部沿用世界坐标，无需各自改写。
 *
 * 图层顺序（viewport 自下而上）：
 *   fx（感应半径 / 感应区）→ elements（元件）→ wires（线缆，含 halo）→
 *   jumps（交叉拱）→ overlay（连线预览）。
 * 线缆层渲染在所有元件实例之上：任何情况下线不会被元件身体盖住。
 * 线缆层 pointer-events:none，点击 / 拖拽优先命中元件；导线的选中与删除
 * 走「右键导线 → 检查器 → 删除按钮 / Delete 键」。
 *
 * 走线样式 wireStyle：
 *   - 'straight'：端口到端口的直连线段（默认）。
 *   - 'curve'   ：三次贝塞尔曲线，控制点沿两端端口方向外伸，形成平滑 S 弧。
 * ---------------------------------------------------------------------------

 */

import { GEOMETRY, portOffset, drawIcon, EL_BY_ID } from './catalog.js';
import { DEFAULT_PROX_RADIUS, FLOOR_HALF, LIGHT_COLOR_KEYS } from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
const GRID = 24;
const DRAG_THRESHOLD = 4;
const JUMP_R = 7;        // 交叉拱半径（px）
const JUMP_MARGIN = 12;  // 交叉点距线段端点的最小距离（px）
const MIN_K = 0.25;
const MAX_K = 3;
const EPS = 0.01;
const CURVE_BOW_RATIO = 0.4; // 曲线控制点外伸量 = 端口距离 × 该比例
const CURVE_BOW_MIN = 24;    // 曲线控制点外伸下限（px）
const CURVE_BOW_MAX = 140;   // 曲线控制点外伸上限（px）

/* ---- 1.0.8 渲染规模削减（全景缩放卡顿治理）----
 * DECOR_HIDE_K：低缩放装饰削减阈值。缩放比低于该值时，halo 暗色底衬与交叉拱
 * 在视觉上已难以分辨（7px 拱在 k=0.3 时不足 3px），整层隐藏可大幅削减绘制量。
 * CULL_MARGIN_PX / CULL_MIN_NODES：视口剔除参数——视口（含边距）外的节点
 * display:none 不参与绘制；节点总数低于下限的小电路剔除无收益，整体禁用。 */
const DECOR_HIDE_K = 0.55;
const CULL_MARGIN_PX = 160;
const CULL_MIN_NODES = 200;

export { JUMP_R, JUMP_MARGIN };

const DIR_VEC = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function approxEq(a, b) {
  return Math.abs(a - b) < EPS;
}

/** 保留两位小数，避免 path 字符串过长 / 浮点噪声。 */
function r2(v) {
  return Math.round(v * 100) / 100;
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

/**
 * 图标缓存键：type + 状态关键位（+ 发光元件的颜色）。
 * 只有这些位会影响 drawIcon() 的外观（导通 / 点亮 / 打开 / 供电 / 颜色），据此复用母本。
 * 1.0.9：颜色纳入缓存键——否则 lamp / glow_floor 改色后母本命中旧图不刷新。
 */
const LIGHT_COLOR_SET = new Set(LIGHT_COLOR_KEYS);
function iconCacheKey(type, view_) {
  const st = (view_ && view_.state) || {};
  const pr = (view_ && view_.props) || {};
  const color = LIGHT_COLOR_SET.has(pr.color) ? pr.color : 'yellow'; // 缺省 / 非法回退默认色
  switch (type) {
    case 'lamp': return `lamp${st.lit ? 1 : 0}:${color}`;
    case 'glow_floor': return `glow${st.lit ? 1 : 0}:${color}`;
    case 'door': return `door${st.open ? 1 : 0}`;
    case 'solar_panel': return `solar_panel${st.supplying ? 1 : 0}`;
    case 'power': return `power${st.on === false ? 0 : 1}`; // N1：关断态需刷新图标母本
    case 'wall_switch':
    case 'prox_switch':
    case 'button':
    case 'floor_switch':
    case 'auto_switch':
    case 'inverter': return `${type}${st.conducting ? 1 : 0}`;
    default: return type;
  }
}

/** 仅在需要时增删 class，避免每帧无谓的 DOM 写入。 */
function toggleCls(node, cls, on) {
  const has = node.classList.contains(cls);
  if (on && !has) node.classList.add(cls);
  else if (!on && has) node.classList.remove(cls);
}

/** 用 DOMParser 把 SVG 片段字符串转成节点数组后再挂到 <g>，兼容性优于 innerHTML。 */
function parseFragments(str) {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${NS}">${str}</svg>`,
    'image/svg+xml'
  );
  const svg = doc.documentElement;
  const nodes = [];
  for (let i = 0; i < svg.childNodes.length; i++) nodes.push(svg.childNodes[i]);
  return nodes;
}

/* ============================ 走线几何（纯函数） ============================ */

/** 两条同向共线线段的「重叠长度」（不共线 / 垂直 → 0）。 */
function segOverlapLen(a, b) {
  const oa = segOrientation(a);
  const ob = segOrientation(b);
  if (oa !== ob || oa === 'd') return 0;
  if (oa === 'h') {
    if (!approxEq(a.y1, b.y1)) return 0;
    return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  }
  if (!approxEq(a.x1, b.x1)) return 0;
  return Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
}

/** 线段朝向：h 水平 / v 垂直 / d 退化。 */
export function segOrientation(s) {
  if (approxEq(s.y1, s.y2)) return 'h';
  if (approxEq(s.x1, s.x2)) return 'v';
  return 'd';
}

/** 点是否落在线段「内部」（距端点 > JUMP_MARGIN）。 */
export function pointInterior(seg, cx, cy) {
  const o = segOrientation(seg);
  if (o === 'h') {
    return approxEq(cy, seg.y1) && cx > seg.x1 + JUMP_MARGIN && cx < seg.x2 - JUMP_MARGIN;
  }
  if (o === 'v') {
    return approxEq(cx, seg.x1) && cy > seg.y1 + JUMP_MARGIN && cy < seg.y2 - JUMP_MARGIN;
  }
  return false;
}

/** 求「一横一竖」正交交叉点；不满足条件返回 null。 */
export function orthCross(a, b) {
  const oa = segOrientation(a);
  const ob = segOrientation(b);
  if (!((oa === 'h' && ob === 'v') || (oa === 'v' && ob === 'h'))) return null;
  const cx = oa === 'h' ? b.x1 : a.x1;
  const cy = oa === 'h' ? a.y1 : b.y1;
  if (!pointInterior(a, cx, cy) || !pointInterior(b, cx, cy)) return null;
  return { x: cx, y: cy };
}

/** 取导线 id 中的数值（'w12' → 12），用于拱的归属判定。 */
export function numericId(id) {
  const n = parseInt(String(id).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** 折线整体包围盒（用于交叉粗筛）。 */
function pathBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 导线包围盒（世界坐标，外扩弧拱 / 曲线弓出余量；1.0.8 视口剔除用）。
 * 直线模式交叉拱最高凸出 JUMP_R；曲线控制点外伸最多 CURVE_BOW_MAX。
 * @param {{pts:Array, curve:boolean}} wd 导线几何
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
function wireBBoxOf(wd) {
  const b = pathBBox(wd.pts);
  const slack = wd.curve ? CURVE_BOW_MAX : JUMP_R + 6;
  return {
    minX: b.minX - slack, minY: b.minY - slack,
    maxX: b.maxX + slack, maxY: b.maxY + slack,
  };
}

/**
 * 计算所有导线两两交叉的「拱点」。
 * 归属与朝向无关——同一个交叉点只允许一条导线起拱，取经过该点的所有导线中
 * id 数值最大者；因此同一处不会出现两条线各起一个方向不同的叠弧。
 * 仅适用于直线模式（折线段为水平 / 垂直段）；曲线模式调用方应传入空跳线表。
 * @param {Array<{id:string, pts:Array}>} wirePaths
 * @returns {Map<string, Array<{x:number,y:number}>>} id → 拱点数组
 */
export function computeJumps(wirePaths) {
  const byPoint = new Map();
  const boxes = wirePaths.map((w) => pathBBox(w.pts));
  const segCache = wirePaths.map((w) => pointsToSegments(w.pts));
  for (let i = 0; i < wirePaths.length; i++) {
    for (let j = i + 1; j < wirePaths.length; j++) {
      const ba = boxes[i], bb = boxes[j];
      // 包围盒粗筛：不相交的两条线不可能有正交交点
      if (ba.maxX < bb.minX || ba.minX > bb.maxX || ba.maxY < bb.minY || ba.minY > bb.maxY) continue;
      const A = wirePaths[i];
      const B = wirePaths[j];
      for (const sa of segCache[i]) {
        for (const sb of segCache[j]) {
          const p = orthCross(sa, sb);
          if (!p) continue;
          const key = `${r2(p.x)},${r2(p.y)}`;
          let rec = byPoint.get(key);
          if (!rec) { rec = { x: p.x, y: p.y, ids: new Set() }; byPoint.set(key, rec); }
          rec.ids.add(A.id);
          rec.ids.add(B.id);
        }
      }
    }
  }
  const jumps = new Map();
  for (const rec of byPoint.values()) {
    let owner = null, best = -Infinity;
    for (const id of rec.ids) { const n = numericId(id); if (n > best) { best = n; owner = id; } }
    const list = jumps.get(owner) || [];
    list.push({ x: rec.x, y: rec.y });
    jumps.set(owner, list);
  }
  return jumps;
}

/**
 * 由元件与导线计算全部导线的几何（世界坐标）。
 * 纯函数：不触碰 DOM，可供渲染层与自测工具共用，保证「所见即所测」。
 * 走线样式：
 *   - 'straight'：端口到端口直连线段（两点折线）。轴对齐的交叉仍由 computeJumps
 *     计算跳线拱（R=7，只给较大 id 的线起拱）；斜线段在正交求交下自然为空。
 *   - 'curve'   ：三次贝塞尔曲线（pts 仍存两端端口点，curve=true 时渲染层用
 *     curvePathD 生成 d）。曲线不走正交求交，交叉拱不适用（jumps 为空表）。
 * @param {Array<object>} elements engine.getElements() 的结果
 * @param {Array<object>} wires engine.getWires() 的结果
 * @param {string} [style='straight'] 'straight' 直线 | 'curve' 曲线
 * @returns {{wireData:Array<{id:string,pts:Array,a:object,b:object,curve:boolean,d1:string,d2:string}>, jumps:Map}}
 */
export function buildWirePaths(elements, wires, style = 'straight') {
  const byId = new Map();
  for (const e of elements) byId.set(e.id, e);
  const curve = style === 'curve';
  const wireData = [];
  wires.forEach((w) => {
    const a = byId.get(w.a.el);
    const b = byId.get(w.b.el);
    if (!a || !b) return;
    const oa = portOffset(a.type, w.a.port);
    const ob = portOffset(b.type, w.b.port);
    const pa = { x: a.x + oa.dx, y: a.y + oa.dy };
    const pb = { x: b.x + ob.dx, y: b.y + ob.dy };
    wireData.push({
      id: w.id,
      pts: [pa, pb],
      a: w.a,
      b: w.b,
      curve,
      d1: oa.dir,
      d2: ob.dir,
    });
  });
  const jumps = curve ? new Map() : computeJumps(wireData);
  return { wireData, jumps };
}

/**
 * 计算曲线导线三次贝塞尔的两个控制点（curvePathD 与 curveSamplePoints 共用，
 * 保证「渲染的弧」与「拾取的弧」永远是同一条曲线）。
 * 控制点沿两端端口朝向各外伸 k（k = 端口距离 × CURVE_BOW_RATIO，钳位在
 * [CURVE_BOW_MIN, CURVE_BOW_MAX]），水平端口横向外伸、垂直端口纵向外伸。
 * @param {{x:number,y:number}} p1 起点端口世界坐标
 * @param {string} dir1 起点端口朝向
 * @param {{x:number,y:number}} p2 终点端口世界坐标
 * @param {string} dir2 终点端口朝向
 * @param {number} [bow] 外伸量（缺省按距离自动计算）
 * @returns {{c1:{x:number,y:number}, c2:{x:number,y:number}}} 两个控制点
 */
function curveControlPoints(p1, dir1, p2, dir2, bow) {
  const v1 = DIR_VEC[dir1] || DIR_VEC.right;
  const v2 = DIR_VEC[dir2] || DIR_VEC.left;
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const k = bow != null ? bow
    : clamp(dist * CURVE_BOW_RATIO, CURVE_BOW_MIN, CURVE_BOW_MAX);
  return {
    c1: { x: p1.x + v1.x * k, y: p1.y + v1.y * k },
    c2: { x: p2.x + v2.x * k, y: p2.y + v2.y * k },
  };
}

/**
 * 生成「曲线导线」的三次贝塞尔 path d 字符串（M + C）。
 * @param {{x:number,y:number}} p1 起点端口世界坐标
 * @param {string} dir1 起点端口朝向
 * @param {{x:number,y:number}} p2 终点端口世界坐标
 * @param {string} dir2 终点端口朝向
 * @param {number} [bow] 外伸量（缺省按距离自动计算）
 * @returns {string} d 字符串
 */
export function curvePathD(p1, dir1, p2, dir2, bow) {
  const { c1, c2 } = curveControlPoints(p1, dir1, p2, dir2, bow);
  return `M ${r2(p1.x)} ${r2(p1.y)}`
    + ` C ${r2(c1.x)} ${r2(c1.y)} ${r2(c2.x)} ${r2(c2.y)}`
    + ` ${r2(p2.x)} ${r2(p2.y)}`;
}

/**
 * 把曲线导线的三次贝塞尔按渲染同款控制点逻辑采样成折线（1.0.4）。
 * 曲线右键拾取用：旧实现对曲线用「首尾弦线」近似算距离，弧线中段远离弦线时
 * 点在看得见的弧上却选不中；现在按与 curvePathD 完全一致的控制点把曲线采样为
 * n 段折线，拾取时对折线各段求最近距离，保证「点到看得见的弧上即命中」。
 * @param {{x:number,y:number}} p1 起点端口世界坐标
 * @param {string} dir1 起点端口朝向
 * @param {{x:number,y:number}} p2 终点端口世界坐标
 * @param {string} dir2 终点端口朝向
 * @param {number} [bow] 外伸量（缺省按距离自动计算）
 * @param {number} [n=40] 采样段数（≥32，弧中段采样误差远小于拾取半径）
 * @returns {Array<{x:number,y:number}>} n+1 个采样点（含首尾端点）
 */
export function curveSamplePoints(p1, dir1, p2, dir2, bow, n = 40) {
  const segs = Math.max(2, Math.floor(n) || 40);
  const { c1, c2 } = curveControlPoints(p1, dir1, p2, dir2, bow);
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const u = 1 - t;
    // 三次贝塞尔基函数：B(t) = u³·p1 + 3u²t·c1 + 3ut²·c2 + t³·p2
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    pts.push({
      x: b0 * p1.x + b1 * c1.x + b2 * c2.x + b3 * p2.x,
      y: b0 * p1.y + b1 * c1.y + b2 * c2.y + b3 * p2.y,
    });
  }
  return pts;
}

/**
 * 由折线点列 + 拱点生成 SVG path 的 d 字符串（直线模式）。
 * 仅使用 M / L / A 命令；拱为 R=7 的半圆弧。
 */
export function buildPath(points, jumps) {
  if (!points || !points.length) return '';
  let d = `M ${r2(points[0].x)} ${r2(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const horizontal = approxEq(a.y, b.y);
    const dir = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    const sameDir = dir >= 0 ? 1 : -1;

    const onSeg = (jumps || []).filter((jp) => (
      horizontal
        ? approxEq(jp.y, a.y) && jp.x > Math.min(a.x, b.x) + 1 && jp.x < Math.max(a.x, b.x) - 1
        : approxEq(jp.x, a.x) && jp.y > Math.min(a.y, b.y) + 1 && jp.y < Math.max(a.y, b.y) - 1
    ));
    onSeg.sort((u, v) => (horizontal ? (u.x - v.x) : (u.y - v.y)) * sameDir);

    // 让半圆拱「拱向固定一侧」：水平段向上拱、垂直段向右拱。
    const sweep = sameDir === 1 ? 1 : 0;
    for (const jp of onSeg) {
      if (horizontal) {
        d += ` L ${r2(jp.x - sameDir * JUMP_R)} ${r2(jp.y)}`;
        d += ` A ${JUMP_R} ${JUMP_R} 0 0 ${sweep} ${r2(jp.x + sameDir * JUMP_R)} ${r2(jp.y)}`;
      } else {
        d += ` L ${r2(jp.x)} ${r2(jp.y - sameDir * JUMP_R)}`;
        d += ` A ${JUMP_R} ${JUMP_R} 0 0 ${sweep} ${r2(jp.x)} ${r2(jp.y + sameDir * JUMP_R)}`;
      }
    }
    d += ` L ${r2(b.x)} ${r2(b.y)}`;
  }
  return d;
}

/**
 * 生成「单个交叉拱」的独立路径（仅 M + A 两条命令，R=7 半圆）。
 * 方向 / 扫向与 buildPath 内嵌的拱完全一致，用于在顶层图层重绘同一道拱，
 * 使其始终压在元件图标之上、永远可见。
 * @param {Array<{x:number,y:number}>} points 该导线的折线点列
 * @param {{x:number,y:number}} jp 拱点
 * @returns {string} 弧线的 d 字符串（找不到所在线段时返回 ''）
 */
export function arcPathForJump(points, jp) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const horizontal = approxEq(a.y, b.y);
    const on = horizontal
      ? approxEq(jp.y, a.y) && jp.x >= Math.min(a.x, b.x) && jp.x <= Math.max(a.x, b.x)
      : approxEq(jp.x, a.x) && jp.y >= Math.min(a.y, b.y) && jp.y <= Math.max(a.y, b.y);
    if (!on) continue;
    const dir = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    const sameDir = dir >= 0 ? 1 : -1;
    const sweep = sameDir === 1 ? 1 : 0;
    if (horizontal) {
      return `M ${r2(jp.x - sameDir * JUMP_R)} ${r2(jp.y)} A ${JUMP_R} ${JUMP_R} 0 0 ${sweep} ${r2(jp.x + sameDir * JUMP_R)} ${r2(jp.y)}`;
    }
    return `M ${r2(jp.x)} ${r2(jp.y - sameDir * JUMP_R)} A ${JUMP_R} ${JUMP_R} 0 0 ${sweep} ${r2(jp.x)} ${r2(jp.y + sameDir * JUMP_R)}`;
  }
  return '';
}

/** 折线 → 轴对齐线段集合（规范化为 x1<=x2 / y1<=y2）。 */
export function pointsToSegments(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    segs.push({
      x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
    });
  }
  return segs;
}

/**
 * 创建画布。
 * @param {SVGElement} svg 目标 svg 元素
 * @param {object} engine 引擎实例
 * @param {{ onChange?:Function, onViewChange?:Function, wrap?:HTMLElement }} [opts]
 */
export function createBoard(svg, engine, opts = {}) {
  const onChange = opts.onChange || (() => {});
  const onViewChange = opts.onViewChange || (() => {});
  /**
   * 结构变更前回调（撤销历史用）：在真正修改 engine 之前触发一次，
   * 让外层把当前状态压入撤销栈。kind ∈ 'add'|'move'|'wire'|'delete'。
   */
  const onBeforeChange = opts.onBeforeChange || (() => {});
  const wrap = opts.wrap || (svg.closest ? svg.closest('.canvas-wrap') : null);
  let armedType = null;
  let selection = null; // { kind:'wire', id } | null —— 仅导线选中；元件选择统一走 multiSel
  let multiSel = new Set(); // 元件选择集（单选时恰好 1 个元素，与 getSelection() 保持镜像）
  let gesture = null;   // 当前手势：{kind:'pan'|'wire'|'element'|'marquee', ...}
  let preview = null;   // 连线预览 { x1,y1,x2,y2 }
  let marqueeEl = null; // 框选虚线框（overlay 层，世界坐标）
  let hover = { x: 0, y: 0 };

  /** 视图变换：初始 k=1 / t=0 —— 与旧坐标语义完全兼容。 */
  let view = { k: 1, tx: 0, ty: 0 };
  /** 走线样式 'straight'（直线，默认）| 'curve'（三次贝塞尔曲线）。 */
  let wireStyle = 'straight';
  /** 线条隐藏（1.0.8）：true 时导线与交叉拱整层视觉隐藏，元件保留。O(1) 类切换。 */
  let wiresHidden = false;

  /* ---- 渲染结构 / 缓存（结构重建与每帧刷新分离） ---- */
  let viewportEl = null;    // <g class="viewport">
  let wireLayerEl = null;   // 线缆层（位于元件层之上）
  let halosLayerEl = null;  // 线缆暗色底衬子层（1.0.7 提升到画布作用域：增量增删导线用）
  let linesLayerEl = null;  // 线缆彩色线子层（同上）
  let fxLayerEl = null;     // 特效层（感应半径 / 感应区，位于元件之下）
  let elemLayerEl = null;   // 元件层
  let jumpsLayerEl = null;  // 顶层：交叉拱
  let overlayLayerEl = null;// 最顶层：连线预览
  let previewEl = null;     // 连线预览节点
  /**
   * 上次结构重建时的「结构修订号 + 走线样式」（1.0.5 性能修复）：
   * 用 engine.getRevision() 做廉价比对，替代旧版每帧把全部元件 / 导线拼接成
   * 大字符串的 computeStructureSig 指纹。
   */
  let structureRev = -1;      // 引擎结构修订号快照
  let structureStyle = null;  // 上次重建时的走线样式快照
  let dynCache = null;        // 上次全量动态刷新时的引擎动态修订号（1.0.6）
  let selWireCache = null;    // 上次写入 is-selected 类的导线 id（1.0.6）
  let renderScheduled = false; // 手势渲染 rAF 合帧标记（1.0.6）
  const domEls = new Map();   // elId → { group, iconG, portDots:Map, proxEl, floorEl, selBox, stateKey }
  const domWires = new Map(); // wireId → { line, halo, a, b }
  const wireGeom = new Map(); // wireId → { pts, curve, d1, d2 }（右键拾取用）
  const domJumps = [];        // [{ node, wireId }] 拱弧彩色层，刷新颜色用
  const iconCache = new Map(); // 图标母本：cacheKey → Array<SVGNode>
  let jumpSigCache = null;    // 上次拱弧集合指纹（1.0.7：交叉拱差量同步用）
  /* ---- 渲染机制计数（1.0.7）：暴露在 svg.__nmsRenderStats 供专项测试自证 ----
   * rebuilds = rebuildStructure 调用次数（纯拖动期间必须为 0）；
   * incremental = applyIncremental 增量结构更新次数；
   * culled = 上一次视口剔除扫描中被隐藏的元件+导线节点数（1.0.8）。 */
  const stats = { rebuilds: 0, incremental: 0, culled: 0 };
  svg.__nmsRenderStats = stats;

  /* --------------------------- 坐标与几何工具 --------------------------- */

  /**
   * svg 视口矩形的缓存。
   * 读取 getBoundingClientRect() 会强制同步布局；当画布内元素很多、且视图变换刚被
   * 写入（transform 脏）时，这会变得非常昂贵（性能探针里是主要瓶颈）。
   * 由于同一同步任务内的布局不会变化，这里缓存测量结果，并在「下一帧」失效，
   * 兼顾精度（每帧最多量一次）与性能（同帧多次调用只量一次）。
   */
  let rectCache = null;
  function svgRect() {
    if (!rectCache) {
      rectCache = svg.getBoundingClientRect();
      requestAnimationFrame(() => { rectCache = null; });
    }
    return rectCache;
  }

  function clientToWorld(clientX, clientY) {
    const r = svgRect();
    return {
      x: ((clientX - r.left) - view.tx) / view.k,
      y: ((clientY - r.top) - view.ty) / view.k,
    };
  }

  function worldToClient(x, y) {
    const r = svgRect();
    return { x: x * view.k + view.tx + r.left, y: y * view.k + view.ty + r.top };
  }

  /** 内部手势用：屏幕坐标 → 世界坐标。 */
  function toLocal(clientX, clientY) {
    return clientToWorld(clientX, clientY);
  }

  function portPos(elem, port) {
    const off = portOffset(elem.type, port);
    return { x: elem.x + off.dx, y: elem.y + off.dy };
  }

  /* ------------------------------- 视图操作 ------------------------------- */

  function notifyView() {
    onViewChange({ k: view.k, tx: view.tx, ty: view.ty });
  }

  /** 以画布内像素点 (px,py) 为锚点缩放：该点对应的世界坐标保持不变。 */
  function zoomAt(factor, px, py) {
    const k2 = clamp(view.k * factor, MIN_K, MAX_K);
    if (k2 === view.k) return;
    const tx2 = px - ((px - view.tx) / view.k) * k2;
    const ty2 = py - ((py - view.ty) / view.k) * k2;
    view = { k: k2, tx: tx2, ty: ty2 };
    notifyView();
    applyView(); // 缩放只改 viewport 变换，无需重建 / 逐帧刷新
  }

  /**
   * 平移手势进行中切换 .canvas-wrap.is-panning（抓取光标）。
   * 1.0.9：移除了空格相关逻辑（原先的 is-pan-ready 与空格平移已删除）。
   */
  function updateCursorClasses() {
    if (!wrap) return;
    const panning = !!(gesture && gesture.kind === 'pan');
    wrap.classList.toggle('is-panning', panning);
  }

  /** 待应用的滚轮缩放（1.0.6：rAF 合帧——同一帧内多次滚轮因子累乘，锚点取最新位置）。 */
  let pendingZoom = null;

  function onWheel(e) {
    e.preventDefault();
    const r = svgRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (!pendingZoom) {
      pendingZoom = { factor, px: e.clientX - r.left, py: e.clientY - r.top };
      requestAnimationFrame(() => {
        const z = pendingZoom;
        pendingZoom = null;
        if (z) zoomAt(z.factor, z.px, z.py);
      });
    } else {
      pendingZoom.factor *= factor;
      pendingZoom.px = e.clientX - r.left;
      pendingZoom.py = e.clientY - r.top;
    }
  }
  svg.addEventListener('wheel', onWheel, { passive: false });

  /* ------------------------------- 渲染 ------------------------------- */

  /** 只更新 viewport 的缩放平移变换（缩放 / 平移时用，避免重建 DOM）。 */
  function applyView() {
    if (!viewportEl) return;
    viewportEl.setAttribute(
      'transform',
      `translate(${r2(view.tx)} ${r2(view.ty)}) scale(${view.k})`
    );
    // 注意：低缩放装饰削减（is-far-zoom 类）与视口剔除（updateCulling）不在这里
    // 执行，而是放在 refreshDynamic（每帧渲染阶段只跑一次）——避免 fit 等单帧内
    // 多次视图变更（resetView→fitToContent）造成的重复类切换 / 重复剔除扫描。
  }

  /**
   * 视口剔除（1.0.8）：把视口（含 CULL_MARGIN_PX 边距）之外的元件 / 导线 /
   * 交叉拱节点置为 display:none，使其不参与绘制与合成；平移 / 缩放后越回视口
   * 的节点自动恢复显示。纯视图操作——不触碰引擎数据、不触发结构重建；
   * 框选与命中检测仍查全量数据（框选遍历 engine.getElements()，导线拾取遍历
   * wireGeom），不受剔除影响。节点总数低于 CULL_MIN_NODES 时整体禁用并恢复
   * 全部显示（小电路剔除无收益）。每帧只对「可见性发生变化的节点」写 DOM。
   */
  function updateCulling() {
    const enabled = domEls.size + domWires.size >= CULL_MIN_NODES;
    if (!enabled) {
      // 恢复全部显示：仅对处于剔除态的节点写 DOM
      for (const d of domEls.values()) {
        if (d.cullHid) {
          d.cullHid = false;
          d.group.style.display = '';
          if (d.proxEl) d.proxEl.style.display = '';
          if (d.floorEl) d.floorEl.style.display = '';
        }
      }
      for (const rec of domWires.values()) {
        if (rec.cullHid) {
          rec.cullHid = false;
          rec.line.style.display = '';
          rec.halo.style.display = '';
        }
      }
      for (const j of domJumps) {
        if (j.cullHid) {
          j.cullHid = false;
          j.node.style.display = '';
        }
      }
      stats.culled = 0;
      return;
    }
    const r = svgRect();
    const m = CULL_MARGIN_PX;
    // 可视世界矩形（含边距）：screen = world * k + t
    const x1 = (0 - m - view.tx) / view.k;
    const x2 = (r.width + m - view.tx) / view.k;
    const y1 = (0 - m - view.ty) / view.k;
    const y2 = (r.height + m - view.ty) / view.k;
    let culled = 0;
    // 元件（外扩感应圈半径 / 标签余量；fx 层节点随本体一起剔除）
    for (const d of domEls.values()) {
      const ext = d.fxR > d.ext ? d.fxR : d.ext;
      const hid = d.wx + ext <= x1 || d.wx - ext >= x2 || d.wy + ext <= y1 || d.wy - ext >= y2;
      if (hid !== !!d.cullHid) {
        d.cullHid = hid;
        const v = hid ? 'none' : '';
        d.group.style.display = v;
        if (d.proxEl) d.proxEl.style.display = v;
        if (d.floorEl) d.floorEl.style.display = v;
      }
      if (hid) culled++;
    }
    // 导线（halo + 彩色线一起剔除；包围盒外扩过弧拱 / 曲线弓出余量）
    for (const rec of domWires.values()) {
      const b = rec.bbox;
      const hid = !b || b.maxX <= x1 || b.minX >= x2 || b.maxY <= y1 || b.minY >= y2;
      if (hid !== !!rec.cullHid) {
        rec.cullHid = hid;
        const v = hid ? 'none' : '';
        rec.line.style.display = v;
        rec.halo.style.display = v;
      }
      if (hid) culled++;
    }
    // 交叉拱（跟随所属导线的包围盒）
    for (const j of domJumps) {
      const dw = domWires.get(j.wireId);
      const b = dw && dw.bbox;
      const hid = !b || b.maxX <= x1 || b.minX >= x2 || b.maxY <= y1 || b.minY >= y2;
      if (hid !== !!j.cullHid) {
        j.cullHid = hid;
        j.node.style.display = hid ? 'none' : '';
      }
    }
    stats.culled = culled;
  }

  /** 取（或建立）某 type + 状态位 的图标母本节点数组（drawIcon 只在首次算一次）。 */
  function iconTemplate(type, view_) {
    const key = iconCacheKey(type, view_);
    let nodes = iconCache.get(key);
    if (!nodes) {
      nodes = parseFragments(drawIcon(type, view_));
      iconCache.set(key, nodes);
    }
    return nodes;
  }

  /** 创建单个元件的 DOM 节点并登记 domEls（1.0.7：全量重建与增量更新共用）。 */
  function createElementNode(elem) {
    const view_ = engine.getElementView(elem.id);
    const g = el('g', {
      class: `element element-${elem.type}`,
      transform: `translate(${elem.x},${elem.y})`,
      'data-el': elem.id,
    });

    // 本体命中区（透明矩形）：SVG <g> 自身不参与命中测试，必须显式提供几何，
    // 否则鼠标永远点不中元件本体（无法点击 / 拖动 / 选中）。
    // ⚠️ 必须排在最前（端口在其之后 append），保证 .port-hit 在 z 序上高于本体命中区。
    const body = GEOMETRY[elem.type];
    g.appendChild(el('rect', {
      x: -body.w / 2, y: -body.h / 2, width: body.w, height: body.h,
      class: 'el-hit', fill: 'transparent',
    }));

    // 邻近开关感应半径 / 地面开关感应区（画在 FX 层，位于元件之下）
    let proxEl = null;
    let floorEl = null;
    if (elem.type === 'prox_switch') {
      const r = Number(elem.props.radius) || DEFAULT_PROX_RADIUS;
      proxEl = el('circle', { cx: elem.x, cy: elem.y, r, class: 'prox-radius', fill: 'none' });
      fxLayerEl.appendChild(proxEl);
    }
    if (elem.type === 'floor_switch') {
      floorEl = el('rect', {
        x: elem.x - FLOOR_HALF, y: elem.y - FLOOR_HALF,
        width: FLOOR_HALF * 2, height: FLOOR_HALF * 2,
        class: 'floor-area', fill: 'none',
      });
      fxLayerEl.appendChild(floorEl);
    }

    // 图标（缓存母本 → 克隆，避免每帧 DOMParser）
    const iconG = el('g', { class: 'icon' });
    for (const node of iconTemplate(elem.type, view_)) iconG.appendChild(node.cloneNode(true));
    g.appendChild(iconG);

    // 名称标签
    const def = EL_BY_ID[elem.type];
    if (def) {
      const box = GEOMETRY[elem.type];
      const t = el('text', {
        class: 'el-label', x: 0, y: box.h / 2 + 16, 'text-anchor': 'middle',
      });
      t.textContent = def.name;
      g.appendChild(t);
    }

    // 端口
    const ports = GEOMETRY[elem.type].ports || {};
    const portDots = new Map();
    for (const name in ports) {
      const off = ports[name];
      const pg = el('g', { class: 'port', 'data-port': '1', 'data-el': elem.id, 'data-portname': name });
      pg.appendChild(el('circle', {
        cx: off.dx, cy: off.dy, r: 12, class: 'port-hit', fill: 'transparent',
      }));
      const dot = el('circle', { cx: off.dx, cy: off.dy, r: 6, class: 'port-dot is-idle' });
      pg.appendChild(dot);
      g.appendChild(pg);
      portDots.set(name, dot);
    }

    elemLayerEl.appendChild(g);
    domEls.set(elem.id, {
      group: g, iconG, bodyRect: body, proxEl, floorEl, portDots,
      selBox: null, stateKey: iconCacheKey(elem.type, view_),
      // 1.0.8 视口剔除缓存：世界坐标 + 视觉外扩（标签 / 选择框）+ 感应圈半径
      wx: elem.x, wy: elem.y,
      ext: Math.max(body.w, body.h) / 2 + 40,
      fxR: elem.type === 'prox_switch'
        ? (Number(elem.props.radius) || DEFAULT_PROX_RADIUS)
        : (elem.type === 'floor_switch' ? FLOOR_HALF : 0),
    });
  }

  /**
   * 增量刷新导线几何（1.0.7）：只重写 changedSet 内导线的 halo/line 的 path d
   * （直线带交叉拱 / 曲线两种 wireStyle 均正确），缺失节点补建、失效节点移除，
   * 并差量同步顶层交叉拱。几何重算用纯函数 buildWirePaths（O(W) + 交叉粗筛），
   * 不触碰未变更导线的 DOM。
   */
  function refreshWirePaths(changedSet) {
    const els = engine.getElements();
    const wires = engine.getWires();
    const { wireData, jumps } = buildWirePaths(els, wires, wireStyle);
    let byId = null;
    for (const id of changedSet) {
      if (!byId) byId = new Map(wireData.map((x) => [x.id, x]));
      const wd = byId.get(id);
      let rec = domWires.get(id);
      if (!wd) {
        // 导线已被删除：移除节点与几何缓存
        if (rec) {
          rec.line.remove();
          rec.halo.remove();
          domWires.delete(id);
          wireGeom.delete(id);
        }
        continue;
      }
      const d = wd.curve
        ? curvePathD(wd.pts[0], wd.d1, wd.pts[1], wd.d2)
        : buildPath(wd.pts, jumps.get(wd.id));
      if (!rec) {
        // 新增导线：补建 halo + 彩色线（初始 is-idle，通电类由动态刷新补齐）
        const halo = el('path', { d, class: 'wire-halo', fill: 'none' });
        const line = el('path', { d, class: 'wire is-idle', fill: 'none' });
        halosLayerEl.appendChild(halo);
        linesLayerEl.appendChild(line);
        rec = { line, halo, a: wd.a, b: wd.b, bbox: wireBBoxOf(wd) };
        domWires.set(id, rec);
      } else if (rec.line.getAttribute('d') !== d) {
        rec.line.setAttribute('d', d);
        rec.halo.setAttribute('d', d);
        rec.bbox = wireBBoxOf(wd); // 几何变化 → 剔除包围盒同步失效
      }
      wireGeom.set(id, { pts: wd.pts, curve: wd.curve, d1: wd.d1, d2: wd.d2 });
    }
    syncJumpArcs(wireData, jumps);
  }

  /**
   * 交叉拱差量同步（1.0.7）：按期望拱集合指纹（wireId:坐标 串联）比对，
   * 指纹不变零 DOM 操作；变化则整层重建立 casing + 弧，并按当前通电态写类。
   */
  function syncJumpArcs(wireData, jumps) {
    let sig = '';
    for (const [wid, list] of jumps) {
      for (const jp of list) sig += `${wid}:${r2(jp.x)},${r2(jp.y)};`;
    }
    if (sig === jumpSigCache) return;
    jumpSigCache = sig;
    while (jumpsLayerEl.firstChild) jumpsLayerEl.removeChild(jumpsLayerEl.firstChild);
    domJumps.length = 0;
    if (!jumps.size) return;
    const ptsById = new Map(wireData.map((x) => [x.id, x.pts]));
    for (const [wid, list] of jumps) {
      const pts = ptsById.get(wid);
      if (!pts) continue;
      for (const jp of list) {
        const d = arcPathForJump(pts, jp);
        if (!d) continue;
        jumpsLayerEl.appendChild(el('path', {
          d, class: 'jump-casing', fill: 'none', 'pointer-events': 'none',
        }));
        const arc = el('path', {
          d, class: 'jump-arc is-idle', fill: 'none', 'pointer-events': 'none',
        });
        jumpsLayerEl.appendChild(arc);
        domJumps.push({ node: arc, wireId: wid });
      }
    }
    // 新建弧为初始 is-idle：立即按当前通电态对齐，避免依赖下一次动态刷新
    for (const j of domJumps) {
      const dw = domWires.get(j.wireId);
      const powered = dw ? engine.getNodePowered(dw.a.el, dw.a.port) : false;
      j.node.setAttribute('class', `jump-arc ${powered ? 'is-powered' : 'is-idle'}`);
    }
  }

  /** 单次增量更新的批量上限：超过则整表重建更划算（导入 / 批量删除 / 撤销）。 */
  const INC_MAX_BATCH = 150;

  /**
   * 增量结构更新（1.0.7）：按引擎 getChangesSince 的变更清单只动受影响的 DOM。
   * 拖动（el-move）路径：仅更新被拖元件 transform / 感应圈位置 + 端点关联导线的
   * path d + 交叉拱差量——不重建任何图层、不触碰无关节点。
   * @param {{els:Set<string>, wires:Set<string>}} ch 引擎变更清单
   * @returns {boolean} 本次是否发生过节点增删（调用方据此强制一次通电类刷新）
   */
  function applyIncremental(ch) {
    let structural = false;
    // ---- 元件：移动只改 transform；新增建节点；删除移除节点 ----
    for (const id of ch.els) {
      if (engine.hasElement(id)) {
        const elem = engine.getElement(id);
        const d = domEls.get(id);
        if (d) {
          // 移动：组内图标/端口/选择框随 transform 一起走
          d.group.setAttribute('transform', `translate(${elem.x},${elem.y})`);
          d.wx = elem.x; // 1.0.8 视口剔除缓存坐标同步
          d.wy = elem.y;
          if (d.proxEl) {
            d.proxEl.setAttribute('cx', String(elem.x));
            d.proxEl.setAttribute('cy', String(elem.y));
          }
          if (d.floorEl) {
            d.floorEl.setAttribute('x', String(elem.x - FLOOR_HALF));
            d.floorEl.setAttribute('y', String(elem.y - FLOOR_HALF));
          }
        } else {
          createElementNode(elem);
          structural = true;
        }
      } else {
        const d = domEls.get(id);
        if (d) {
          d.group.remove();
          if (d.proxEl) d.proxEl.remove();
          if (d.floorEl) d.floorEl.remove();
          domEls.delete(id);
          structural = true;
        }
      }
    }
    // ---- 导线：元件移动会牵连其端点导线几何，一并纳入变更集 ----
    const affected = new Set(ch.wires);
    if (ch.els.size) {
      for (const w of engine.getWires()) {
        if (ch.els.has(w.a.el) || ch.els.has(w.b.el)) affected.add(w.id);
      }
    }
    if (affected.size) refreshWirePaths(affected);
    stats.incremental++;
    return structural;
  }

  /** 结构重建：整表失效（导入 / 复位 / 走线样式切换 / 超大批量变更）时重建全部 DOM。
   *  1.0.7：常规结构变化（增删改元件 / 导线、拖动移动）改走 applyIncremental，
   *  本函数仅在增量不可行时调用，调用次数由 stats.rebuilds 计数供专项测试自证。 */
  function rebuildStructure() {
    stats.rebuilds++;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    domEls.clear();
    domWires.clear();
    wireGeom.clear();
    domJumps.length = 0;
    jumpSigCache = null;
    previewEl = null;
    marqueeEl = null;

    viewportEl = el('g', { class: 'viewport' });
    fxLayerEl = el('g', { class: 'layer-fx' });
    elemLayerEl = el('g', { class: 'layer-elements' });
    wireLayerEl = el('g', { class: 'layer-wires' });
    halosLayerEl = el('g', { class: 'wire-halos' });
    linesLayerEl = el('g', { class: 'wire-lines' });
    jumpsLayerEl = el('g', { class: 'layer-jumps' });
    overlayLayerEl = el('g', { class: 'layer-overlay' });

    // ---------------- 元件 ----------------
    const els = engine.getElements();
    for (const elem of els) {
      createElementNode(elem);
    }

    // ---------------- 导线（线缆层：位于元件层之上）----------------
    const { wireData, jumps } = buildWirePaths(els, engine.getWires(), wireStyle);

    for (const wd of wireData) {
      const d = wd.curve
        ? curvePathD(wd.pts[0], wd.d1, wd.pts[1], wd.d2)
        : buildPath(wd.pts, jumps.get(wd.id));
      // 暗色底衬 halo：在交叉处「切断」下层导线，使交叉点分层可辨
      const halo = el('path', { d, class: 'wire-halo', fill: 'none' });
      // 彩色线
      const line = el('path', { d, class: 'wire is-idle', fill: 'none' });
      halosLayerEl.appendChild(halo);
      linesLayerEl.appendChild(line);
      domWires.set(wd.id, { line, halo, a: wd.a, b: wd.b, bbox: wireBBoxOf(wd) });
      wireGeom.set(wd.id, { pts: wd.pts, curve: wd.curve, d1: wd.d1, d2: wd.d2 });
    }
    wireLayerEl.appendChild(halosLayerEl);
    wireLayerEl.appendChild(linesLayerEl);

    // ---------------- 交叉拱（顶层图层）：深色 casing + 彩色弧 ----------------
    syncJumpArcs(wireData, jumps);

    viewportEl.appendChild(fxLayerEl);
    viewportEl.appendChild(elemLayerEl);
    viewportEl.appendChild(wireLayerEl);  // 线缆（含 halo）压在所有元件之上
    viewportEl.appendChild(jumpsLayerEl); // 顶层：交叉拱
    viewportEl.appendChild(overlayLayerEl); // 最顶：连线预览
    svg.appendChild(viewportEl);
    applyView();
  }

  /** 连线预览（每帧刷新用）：激活则创建 / 更新 d，否则移除。跟随走线样式。 */
  function refreshPreview() {
    if (preview && preview.active) {
      const p1 = { x: preview.x1, y: preview.y1 };
      const p2 = { x: preview.x2, y: preview.y2 };
      const d = wireStyle === 'curve'
        ? curvePathD(p1, preview.dir1 || 'right', p2, preview.dir2 || 'left')
        : buildPath([p1, p2], []);
      if (!previewEl) {
        previewEl = el('path', { class: 'wire-preview', fill: 'none' });
        overlayLayerEl.appendChild(previewEl);
      }
      if (previewEl.getAttribute('d') !== d) previewEl.setAttribute('d', d);
    } else if (previewEl) {
      previewEl.remove();
      previewEl = null;
    }
  }

  /**
   * 全量动态刷新（1.0.6 拆分）：元件图标（按状态位换母本）+ 端口点 + 感应区，
   * 以及导线 / 拱弧的通电类。仅当引擎动态修订号（getDynRev）变化时执行——
   * 大电路稳态运行 / 纯视图操作（平移缩放）时整段跳过，零 O(N) 开销。
   */
  function refreshPowerState() {
    // 元件：图标（按状态位换母本）+ 端口点 + 感应区
    for (const [id, d] of domEls) {
      const view_ = engine.getElementView(id);
      if (!view_) continue;
      const key = iconCacheKey(view_.type, view_);
      if (key !== d.stateKey) {
        d.stateKey = key;
        const tmpl = iconTemplate(view_.type, view_);
        while (d.iconG.firstChild) d.iconG.removeChild(d.iconG.firstChild);
        for (const node of tmpl) d.iconG.appendChild(node.cloneNode(true));
      }
      for (const [name, dot] of d.portDots) {
        const powered = !!(view_.ports[name] && view_.ports[name].powered);
        const cls = powered ? 'port-dot is-powered' : 'port-dot is-idle';
        if (dot.getAttribute('class') !== cls) dot.setAttribute('class', cls);
      }
      if (d.proxEl) {
        const r = Number(view_.props.radius) || DEFAULT_PROX_RADIUS;
        if (Number(d.proxEl.getAttribute('r')) !== r) d.proxEl.setAttribute('r', String(r));
        d.fxR = r; // 1.0.8 视口剔除外扩半径同步（感应半径可在检查器调节）
        toggleCls(d.proxEl, 'is-active', !!view_.conducting);
      }
      if (d.floorEl) toggleCls(d.floorEl, 'is-active', !!view_.conducting);
    }

    // 导线：通电类（选中类由 refreshSelection 维护，此处带上快照值保证一致性）
    for (const [id, d] of domWires) {
      const powered = engine.getNodePowered(d.a.el, d.a.port);
      const cls = `wire ${powered ? 'is-powered' : 'is-idle'}${id === selWireCache ? ' is-selected' : ''}`;
      if (d.line.getAttribute('class') !== cls) d.line.setAttribute('class', cls);
    }
    // 拱弧颜色跟随其所属导线的通电状态
    for (const j of domJumps) {
      const dw = domWires.get(j.wireId);
      const powered = dw ? engine.getNodePowered(dw.a.el, dw.a.port) : false;
      const cls = `jump-arc ${powered ? 'is-powered' : 'is-idle'}`;
      if (j.node.getAttribute('class') !== cls) j.node.setAttribute('class', cls);
    }
  }

  /**
   * 选择相关刷新（1.0.6 拆分）：每帧执行但常态零 DOM 写入——
   * 选择框只在创建 / 移除时触碰 DOM；选中导线仅在 id 变化时更新新旧两条线。
   */
  function refreshSelection() {
    // 元件选择框
    for (const [id, d] of domEls) {
      const isSel = multiSel.has(id)
        || !!(selection && selection.kind === 'element' && selection.id === id);
      if (isSel && !d.selBox) {
        const b = d.bodyRect;
        d.selBox = el('rect', {
          x: -b.w / 2 - 6, y: -b.h / 2 - 6, width: b.w + 12, height: b.h + 12,
          rx: 14, class: 'sel-box', fill: 'none',
        });
        d.group.appendChild(d.selBox);
      } else if (!isSel && d.selBox) {
        d.selBox.remove();
        d.selBox = null;
      }
    }
    // 导线选中态：仅当选中 id 变化时更新（含通电态的完整类字符串）
    const selWire = selection && selection.kind === 'wire' ? selection.id : null;
    if (selWire !== selWireCache) {
      for (const id of [selWireCache, selWire]) {
        if (!id) continue;
        const d = domWires.get(id);
        if (!d) continue;
        const powered = engine.getNodePowered(d.a.el, d.a.port);
        d.line.setAttribute('class',
          `wire ${powered ? 'is-powered' : 'is-idle'}${id === selWire ? ' is-selected' : ''}`);
      }
      selWireCache = selWire;
    }
  }

  /**
   * 每帧刷新入口（1.0.6 门控）：通电/图标刷新仅动态修订号变化时执行，选择刷新常态零开销。
   * 1.0.8：低缩放装饰削减与视口剔除也在每帧渲染阶段此处执行（视图变换已是
   * 本帧最终值，单帧内多次视图变更只会做一次削减 / 一次剔除扫描）。
   */
  function refreshDynamic() {
    // 选择集自愈：已被删除的导线移出选中（1.0.5：用 hasWire 避免 getWires() 每帧建大数组）
    if (selection && selection.kind === 'wire' && !engine.hasWire(selection.id)) selection = null;
    // 选择集自愈：已被删除的元件 id 移出选择集
    if (multiSel.size) {
      for (const id of [...multiSel]) {
        if (!engine.getElement(id)) multiSel.delete(id);
      }
    }

    // 1.0.8 低缩放装饰削减：O(1) 类切换（CSS 隐藏 halo 底衬 / 交叉拱 / 标签 / 端口点）
    toggleCls(svg, 'is-far-zoom', view.k < DECOR_HIDE_K);
    // 1.0.8 视口剔除：视口外节点 display:none（稳态零 DOM 写入）
    updateCulling();

    // 通电 / 图标刷新：引擎动态修订号不变 → 跳过整段 O(N) 循环
    const dyn = engine.getDynRev();
    if (dyn !== dynCache) {
      dynCache = dyn;
      refreshPowerState();
    }
    refreshSelection();
    refreshPreview();
    toggleCls(svg, 'is-armed', !!armedType);
  }

  /**
   * 渲染入口（主循环每帧调用）：
   * 结构未变 → 只做每帧动态刷新；结构变化 → 优先增量更新，必要时整表重建。
   * 变更检测（1.0.7）：revision 比对（O(1)）后取引擎 getChangesSince 变更清单，
   * 常规增删改（含拖动 el-move）走 applyIncremental——拖动期间每帧只更新被拖
   * 元件 transform + 端点关联导线 path d，rebuildStructure 调用次数为 0
   * （svg.__nmsRenderStats.rebuilds 供专项测试自证）。
   * 走整表重建的口径：引擎标记 full（导入/复位/走线样式切换）、画布尚未建立、
   * 本地走线样式变化、或单批变更量超过 INC_MAX_BATCH（导入/批量删除/撤销更划算）。
   */
  function render() {
    const rev = engine.getRevision();
    if (rev !== structureRev || wireStyle !== structureStyle || !viewportEl) {
      const ch = engine.getChangesSince(structureRev);
      const batchSize = ch.els.size + ch.wires.size;
      if (ch.full || !viewportEl || wireStyle !== structureStyle
        || batchSize > INC_MAX_BATCH) {
        structureRev = rev;
        structureStyle = wireStyle;
        rebuildStructure();
        // 结构重建后 DOM 节点全新（类名为初始态），强制下一轮做一次全量动态刷新
        dynCache = null;
      } else {
        const structural = applyIncremental(ch);
        structureRev = rev;
        // 增量中发生过节点增删 → 新节点类名为初始态，强制一次全量通电刷新
        if (structural) dynCache = null;
      }
    }
    refreshDynamic();
    applyView();
  }

  /**
   * 手势渲染合帧（1.0.6）：pointermove 等高频事件只置位标记，实际 render()
   * 由 rAF 每帧至多执行一次，避免事件速率高于帧率时的重复渲染/重建。
   * 语义不变：渲染读取的永远是最新状态（位置 / 预览端点在事件回调里已更新）。
   */
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  /* ------------------------------ 手势处理 ------------------------------ */

  /** 线条隐藏类切换（1.0.8）：只动 svg 根的一个类，O(1)，无任何 DOM 重建。 */
  function applyWiresHiddenCls(hidden) {
    toggleCls(svg, 'wires-hidden', !!hidden);
  }

  function svgPoint(e) {
    return toLocal(e.clientX, e.clientY);
  }

  /** 点到线段的最短距离（导线右键拾取用）。 */
  function distPointSeg(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
  }

  /**
   * 按世界坐标拾取导线（右键选中用）。
   * 直线用端口连线段做距离判定；曲线（1.0.4 修复）按渲染同款控制点把三次
   * 贝塞尔采样成折线（curveSamplePoints，40 段），对折线各段求最近距离——
   * 弧线中段远离弦线的位置也能命中，且阈值口径与直线模式完全一致（世界坐标）。
   * @param {number} wx 世界 x
   * @param {number} wy 世界 y
   * @returns {string|null} 命中的导线 id
   */
  function pickWire(wx, wy) {
    const th = Math.max(6, 10 / Math.max(view.k, 0.25));
    let bestId = null;
    let bestD = th;
    for (const [id, g] of wireGeom) {
      let d;
      if (g.curve) {
        const pts = curveSamplePoints(g.pts[0], g.d1, g.pts[1], g.d2);
        d = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
          const dd = distPointSeg(wx, wy, pts[i], pts[i + 1]);
          if (dd < d) d = dd;
        }
      } else {
        d = distPointSeg(wx, wy, g.pts[0], g.pts[1]);
      }
      if (d < bestD) { bestD = d; bestId = id; }
    }
    return bestId;
  }

  /** 右键：命中导线则选中（配合检查器的删除按钮 / Delete 键删除导线）。
   *  1.0.8：线条隐藏期间导线不可见 → 拾取表现为选不中（恢复显示后照旧）。 */
  function onContextMenu(e) {
    e.preventDefault();
    if (wiresHidden) return;
    const pt = svgPoint(e);
    const wid = pickWire(pt.x, pt.y);
    if (wid) {
      multiSel.clear();
      selection = { kind: 'wire', id: wid };
      render();
      onChange('selection');
    }
  }
  svg.addEventListener('contextmenu', onContextMenu);

  /**
   * Alt + 拖动：把当前被拖元件集合整组复制一份（1.0.9）。
   *   - type 与 props 全量复制（Object.assign），state 用引擎默认初始态；
   *   - 收集副本的 offsets，把后续拖动目标（gesture.offs / gesture.id）换成副本，
   *     锚点对应「原锚点那一份」的副本，保证吸附位置仍是同一元件；
   *   - multiSel 变为副本集合，松手后副本保持选中，原元件原地不动；
   *   - 一次拖动只复制一次（由 gesture.copied 守卫，不随 mousemove 反复复制）。
   * @param {object} g 当前 kind:'element' 手势对象
   */
  function duplicateGroupForDrag(g) {
    onBeforeChange('add'); // 撤销快照：压入「复制前」状态（一次拖动只压一次）
    const anchorSrc = g.offs.find((o) => o.id === g.id) || g.offs[0];
    const newOffs = [];
    let anchorNewId = null;
    for (const o of g.offs) {
      const src = engine.getElement(o.id);
      if (!src) continue;
      const created = engine.addElement(src.type, {
        x: src.x, y: src.y, props: Object.assign({}, src.props),
      });
      if (!created) continue;
      newOffs.push({ id: created.id, ox: o.ox, oy: o.oy });
      if (o === anchorSrc) anchorNewId = created.id;
    }
    if (!newOffs.length) return; // 无可复制（理论上不会发生）
    g.offs = newOffs;
    g.id = anchorNewId != null ? anchorNewId : newOffs[0].id;
    g.copied = true;
    multiSel = new Set(newOffs.map((o) => o.id));
    onChange('add'); // 外部据此刷新元件库高亮 / 检查器
  }

  function onDown(e) {
    if (e.button !== 0 && e.button !== 1) return;

    // 0) 平移手势：鼠标中键拖动（1.0.9：左键空白处拖动也改为平移，见下方空白分支）。
    //    期间不得选中 / 放置 / 连线。
    if (e.button === 1) {
      gesture = {
        kind: 'pan', button: e.button, lastX: e.clientX, lastY: e.clientY, moved: false,
      };
      updateCursorClasses();
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      e.preventDefault();
      return;
    }

    const pt = svgPoint(e);
    hover = pt;
    const portNode = e.target.closest ? e.target.closest('[data-port]') : null;
    const elNode = e.target.closest ? e.target.closest('[data-el]') : null;

    // 1) 从端口拉线
    if (portNode) {
      const elId = portNode.getAttribute('data-el');
      const portName = portNode.getAttribute('data-portname');
      const elem = engine.getElement(elId);
      if (elem) {
        const p = portPos(elem, portName);
        gesture = { kind: 'wire', el: elId, port: portName };
        preview = {
          active: true, x1: p.x, y1: p.y, x2: pt.x, y2: pt.y,
          dir1: portOffset(elem.type, portName).dir, dir2: 'left',
        };
        selection = null;
        multiSel.clear();
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        e.preventDefault();
        render();
      }
      return;
    }

    // 2) 元件：单选 / Shift 加减选 / 组拖准备（线缆层 pointer-events:none，不会拦截元件点击）
    if (elNode) {
      const elId = elNode.getAttribute('data-el');
      const elem = engine.getElement(elId);
      if (!elem) return;
      if (e.shiftKey) {
        // Shift + 点击：在选择集中增删该元件
        if (multiSel.has(elId)) multiSel.delete(elId);
        else multiSel.add(elId);
      } else if (!multiSel.has(elId)) {
        // 点击未选中的元件：变为单选（清空原选择集）
        multiSel = new Set([elId]);
      }
      // 点击已选中的元件：不清空选择集（为拖组做准备）
      selection = null;
      // 参与本次拖拽的元件集合：点击选中元件 → 整组；否则 → 仅该元件
      const dragIds = multiSel.has(elId) ? [...multiSel] : [elId];
      gesture = {
        kind: 'element', id: elId,
        startX: pt.x, startY: pt.y, moved: false,
        // 1.0.9：Alt 按下时，首次越过拖动阈值会把整组复制一份并改拖副本（原元件不动）
        alt: e.altKey,
        offs: dragIds.map((id) => {
          const e2 = engine.getElement(id);
          return { id, ox: e2.x - pt.x, oy: e2.y - pt.y };
        }),
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      render();
      onChange('selection');
      return;
    }

    // 3) 空白处：放置已选中元件（放下即解除武装）→ 框选（Ctrl/⌘）→ 平移画布
    if (armedType) {
      onBeforeChange('add'); // 撤销历史：压入放置前快照
      const id = placeAt(armedType, pt.x, pt.y);
      if (id) {
        multiSel = new Set([id]);
        selection = null;
        armedType = null;
        onChange('add');
        onChange('armed'); // 通知外部同步「元件库高亮 / 画布武装态」
      }
      render();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // 1.0.9：框选需按住 Ctrl/⌘。左→右全包含 / 右→左相交即选中，逻辑保持不变。
      // 松手若无位移则视为单击空白 → 清空选择。
      gesture = { kind: 'marquee', sx: pt.x, sy: pt.y, moved: false };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      e.preventDefault();
      return;
    }
    // 1.0.9（新默认手势）：空白处直接拖动 = 平移画布。松手若无位移（左键单击空白）
    // 视为「单击空白」→ 清空选择（保留 1.0.8 既有的「点空白取消选择」行为）。
    gesture = { kind: 'pan', button: e.button, lastX: e.clientX, lastY: e.clientY, moved: false };
    updateCursorClasses();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    e.preventDefault();
  }

  function onMove(e) {
    if (!gesture && !preview) return;

    // 平移：直接用屏幕像素增量累加到 tx/ty（相当于 1:1 拖动画布）
    if (gesture && gesture.kind === 'pan') {
      const dx = e.clientX - gesture.lastX;
      const dy = e.clientY - gesture.lastY;
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) gesture.moved = true;
      view.tx += dx;
      view.ty += dy;
      notifyView();
      scheduleRender(); // 1.0.6：平移手势渲染合帧（rAF 每帧至多一次）
      return;
    }

    const pt = svgPoint(e);
    hover = pt;
    if (gesture && gesture.kind === 'wire' && preview) {
      preview.x2 = pt.x;
      preview.y2 = pt.y;
      // 预览终点朝最近端口方向
      preview.dir2 = pt.x < preview.x1 ? 'right' : 'left';
      scheduleRender(); // 1.0.6：连线预览渲染合帧（rAF 每帧至多一次）
      return;
    }
    if (gesture && gesture.kind === 'element') {
      const dx = pt.x - gesture.startX;
      const dy = pt.y - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        gesture.moved = true;
        gesture.snapshotted = false;
        // 1.0.9：Alt+拖动首次越过阈值 → 复制整组副本并把后续拖动目标切为副本。
        // 复制瞬间已压入撤销快照（'add'），故把 snapshotted 置真，避免再压一次 'move'。
        if (gesture.alt && !gesture.copied) {
          duplicateGroupForDrag(gesture);
          gesture.snapshotted = true;
        }
      }
      if (gesture.moved) {
        // 刚体批量移动（1.0.3 修复组变形）：吸附只对「锚点」（手势抓取的元件）
        // 做一次，得到统一增量 dx/dy，再把同一个增量套到组内所有元件上——
        // 组内任意两元件的相对坐标在移动前后像素级相等，与初始是否网格对齐无关。
        // 导线走 render() 增量管线：位置变化 → 结构指纹变化 → 按新坐标重算全部路径。
        if (!gesture.snapshotted) {
          gesture.snapshotted = true;
          onBeforeChange('move'); // 撤销历史：压入移动前快照
        }
        const anchor = gesture.offs.find((o) => o.id === gesture.id) || gesture.offs[0];
        const gx = snap(pt.x + anchor.ox) - (anchor.ox + gesture.startX);
        const gy = snap(pt.y + anchor.oy) - (anchor.oy + gesture.startY);
        for (const o of gesture.offs) {
          engine.moveElement(o.id, o.ox + gesture.startX + gx, o.oy + gesture.startY + gy);
        }
        scheduleRender(); // 1.0.6：元件拖动渲染合帧（moveElement 逐事件更新坐标，渲染按帧合并）
      }
      return;
    }
    if (gesture && gesture.kind === 'marquee') {
      const dx = pt.x - gesture.sx;
      const dy = pt.y - gesture.sy;
      if (!gesture.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) gesture.moved = true;
      if (gesture.moved) {
        if (!marqueeEl) {
          marqueeEl = el('rect', { class: 'marquee-box', fill: 'none' });
          overlayLayerEl.appendChild(marqueeEl);
        }
        const x = Math.min(gesture.sx, pt.x);
        const y = Math.min(gesture.sy, pt.y);
        marqueeEl.setAttribute('x', String(r2(x)));
        marqueeEl.setAttribute('y', String(r2(y)));
        marqueeEl.setAttribute('width', String(r2(Math.abs(pt.x - gesture.sx))));
        marqueeEl.setAttribute('height', String(r2(Math.abs(pt.y - gesture.sy))));
      }
    }
  }

  function onUp(e) {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);

    if (gesture && gesture.kind === 'pan') {
      // 1.0.9：平移手势松手——左键且几乎没动 = 单击空白 → 清空选择。
      // 中键单击不触发清除（仅结束平移）。
      const clickEmpty = !gesture.moved && gesture.button === 0;
      gesture = null;
      updateCursorClasses();
      if (clickEmpty) {
        multiSel.clear();
        selection = null;
        render();
        onChange('selection');
      }
      return;
    }

    if (gesture && gesture.kind === 'wire') {
      // 用 elementFromPoint 命中真实端口（不受事件捕获影响）
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const portNode = under && under.closest ? under.closest('[data-port]') : null;
      if (portNode) {
        const toEl = portNode.getAttribute('data-el');
        const toPort = portNode.getAttribute('data-portname');
        if (toEl) {
          onBeforeChange('wire'); // 撤销历史：压入连线前快照
          engine.addWire(gesture.el, gesture.port, toEl, toPort);
        }
      }
      preview = null;
      gesture = null;
      render();
      onChange('wire');
      return;
    }

    if (gesture && gesture.kind === 'element') {
      if (!gesture.moved) {
        // 视为点击：手动元件即时操作（选择逻辑不吞掉电源 / 开关的单击切换）。
        // 1.0.9：Alt+单击不触发任何点击动作（Alt 是「拖动复制」修饰键）。
        const elem = engine.getElement(gesture.id);
        if (elem && !gesture.alt) {
          if (elem.type === 'wall_switch') engine.toggleWallSwitch(elem.id);
          else if (elem.type === 'button') engine.triggerButton(elem.id);
          else if (elem.type === 'power') engine.togglePower(elem.id);
        }
      } else if (multiSel.size === 0) {
        // Shift 减选到空集后又拖动了该元件：把被拖元件收入选择集
        for (const o of gesture.offs) multiSel.add(o.id);
      }
      gesture = null;
      render();
      onChange('change');
      return;
    }

    if (gesture && gesture.kind === 'marquee') {
      const pt = svgPoint(e); // 松手位置（世界坐标）
      if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
      if (!gesture.moved) {
        // 无位移的单击空白：清除选择
        multiSel.clear();
        selection = null;
        render();
        onChange('selection');
        gesture = null;
        return;
      }
      // 松手：按选框挑选元件。从右往左框（终点 x < 起点 x）→ 相交即选中；
      // 从左往右 → 元件包围盒完全落入框内才选中。
      const x1 = Math.min(gesture.sx, pt.x);
      const x2 = Math.max(gesture.sx, pt.x);
      const y1 = Math.min(gesture.sy, pt.y);
      const y2 = Math.max(gesture.sy, pt.y);
      const intersectMode = pt.x < gesture.sx;
      const hits = [];
      for (const elem of engine.getElements()) {
        const b = GEOMETRY[elem.type];
        if (!b) continue;
        const l = elem.x - b.w / 2;
        const r = elem.x + b.w / 2;
        const t = elem.y - b.h / 2;
        const btm = elem.y + b.h / 2;
        const hit = intersectMode
          ? (l < x2 && r > x1 && t < y2 && btm > y1)
          : (l >= x1 && r <= x2 && t >= y1 && btm <= y2);
        if (hit) hits.push(elem.id);
      }
      multiSel = new Set(hits);
      selection = null;
      gesture = null;
      render();
      onChange('selection');
      return;
    }
    gesture = null;
  }

  function placeAt(type, x, y) {
    const elem = engine.addElement(type, { x: snap(x), y: snap(y) });
    if (elem) {
      // 放置多个时避免完全重叠
      return elem.id;
    }
    return null;
  }

  svg.addEventListener('pointerdown', onDown);

  /* ------------------------------- 公开 API ------------------------------- */

  return {
    render,
    setArmedType(type) {
      armedType = type || null;
      render();
    },
    getArmedType() {
      return armedType;
    },
    /** 设置走线样式（'straight' 直线 | 'curve' 曲线；旧值 'orth' 归一为 'straight'），切换后重建导线层。 */
    setWireStyle(style) {
      const next = style === 'curve' ? 'curve' : 'straight';
      if (next === wireStyle) return;
      wireStyle = next;
      render();
      onChange('wire-style');
    },
    /** 当前走线样式。 */
    getWireStyle() {
      return wireStyle;
    },
    /**
     * 线条隐藏开关（1.0.8）：true 时导线（halo+线）与交叉拱整层视觉隐藏，
     * 元件、端口点、连线预览保留。O(1) 类切换（svg 根加 .wires-hidden 类，
     * CSS display:none），禁止全量重建；隐藏时当前选中的导线自动取消选中
     * （看不见的线不应保持选中）。
     * @param {boolean} hidden 是否隐藏线条
     */
    setWiresHidden(hidden) {
      const next = hidden === true;
      applyWiresHiddenCls(next);
      if (next === wiresHidden) return;
      wiresHidden = next;
      if (next && selection && selection.kind === 'wire') {
        selection = null;
        onChange('selection');
      }
      render(); // 结构修订号不变 → 不重建；仅刷新选择态等
      onChange('wires-visibility');
    },
    /** 当前是否隐藏线条（1.0.8）。 */
    getWiresHidden() {
      return wiresHidden;
    },
    /**
     * 当前选择：
     *   - 导线选中 → { kind:'wire', id }
     *   - 元件单选 → { kind:'element', id }
     *   - 元件多选 → { kind:'multi', ids:[...] }
     *   - 无选择   → null
     */
    getSelection() {
      if (selection) return selection;
      if (multiSel.size === 1) return { kind: 'element', id: [...multiSel][0] };
      if (multiSel.size > 1) return { kind: 'multi', ids: [...multiSel] };
      return null;
    },
    /** 元件选择集快照（数组，世界 id 顺序为 engine 遍历序）。 */
    getSelectionSet() {
      return [...multiSel];
    },
    clearSelection() {
      multiSel.clear();
      selection = null;
      render();
    },
    /**
     * 删除当前选择：导线选中 → 删该导线；元件选择集非空 → 批量删除
     * （removeElement 自动级联删除相连导线）。
     * @returns {boolean} 是否删除了内容
     */
    deleteSelection() {
      if (selection && selection.kind === 'wire') {
        onBeforeChange('delete'); // 撤销历史：压入删除前快照
        engine.removeWire(selection.id);
        selection = null;
        render();
        onChange('delete');
        return true;
      }
      if (multiSel.size) {
        onBeforeChange('delete'); // 撤销历史：压入删除前快照（批量）
        for (const id of [...multiSel]) engine.removeElement(id);
        multiSel.clear();
        render();
        onChange('delete');
        return true;
      }
      return false;
    },
    /** 在画布上以世界坐标添加元件（供图鉴「在实验室试用」/ 拖放调用）。 */
    addAt(type, x, y) {
      onBeforeChange('add'); // 撤销历史：压入放置前快照
      const id = placeAt(type, x, y);
      if (id) {
        multiSel = new Set([id]);
        onChange('add');
        render();
      }
      return id;
    },
    /** 画布可视区中心对应的世界坐标附近的空闲网格坐标。 */
    findFreeSpot() {
      const r = svgRect();
      const p = clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
      return { x: snap(Math.max(120, p.x)), y: snap(Math.max(120, p.y)) };
    },

    /* --------------------------- 视图（缩放 / 平移） --------------------------- */

    /** 屏幕坐标 → 世界坐标。 */
    clientToWorld,
    /** 世界坐标 → 屏幕坐标。 */
    worldToClient,
    /** 当前视图变换快照。 */
    getView() {
      return { k: view.k, tx: view.tx, ty: view.ty };
    },
    /** 重置视图为 1:1 原点。1.0.8：变换立即生效，渲染走 rAF 合帧（纯视图操作）。 */
    resetView() {
      view = { k: 1, tx: 0, ty: 0 };
      notifyView();
      applyView();
      scheduleRender();
    },
    /** 以画布中心为锚点缩放（供工具条 + / − 调用）。 */
    zoomBy(factor) {
      const r = svgRect();
      zoomAt(factor, r.width / 2, r.height / 2);
    },
    /** 以指定屏幕像素点为锚点缩放。 */
    zoomAt,
    /**
     * 适应视图：把全部元件（含端口与标签，四周留 80px）缩放进画布。
     * 1.0.8：fit 是纯视图操作——变换与视口剔除立即生效，渲染走 rAF 合帧
     * （scheduleRender），绝不触发 rebuildStructure（结构修订号不变）。
     */
    fitToContent() {
      const els = engine.getElements();
      if (!els.length) {
        view = { k: 1, tx: 0, ty: 0 };
        notifyView();
        applyView();
        scheduleRender();
        return;
      }
      const pad = 80;
      const margin = 24; // 端口 / 标签外扩
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const e of els) {
        const box = GEOMETRY[e.type];
        if (!box) continue;
        minX = Math.min(minX, e.x - box.w / 2 - margin);
        maxX = Math.max(maxX, e.x + box.w / 2 + margin);
        minY = Math.min(minY, e.y - box.h / 2 - margin);
        maxY = Math.max(maxY, e.y + box.h / 2 + margin);
      }
      if (!Number.isFinite(minX)) {
        view = { k: 1, tx: 0, ty: 0 };
        notifyView();
        applyView();
        scheduleRender();
        return;
      }
      const r = svgRect();
      const W = r.width || 800;
      const H = r.height || 600;
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const k = clamp(Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh), MIN_K, 2);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      view = { k, tx: W / 2 - cx * k, ty: H / 2 - cy * k };
      notifyView();
      applyView();
      scheduleRender();
    },

    /* --------------------------- 空格平移协作 --------------------------- */
    // 1.0.9：空格相关的平移协作 API（setSpaceDown / consumeSpacePan）已全部移除——
    // 平移改为「空白处直接拖动」，空格改作「显示 / 隐藏线条」快捷键（见 app.js）。
  };
}

export default { createBoard };

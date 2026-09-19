/**
 * catalog.js — 元件定义：类型、端口、几何、内联 SVG 图标、原理文案、图鉴数据
 * ---------------------------------------------------------------------------
 * 图标统一使用「以元件中心为原点」的局部坐标系，由 board.js 平移到实际位置。
 * 所有图标为内联 SVG（非位图），可跟随主题缩放与变色。
 * ---------------------------------------------------------------------------
 */

/** 全局总规则（照抄素材说明）。 */
export const RULE_TEXT =
  '所有开关或控制元件的输入输出端口都可以互换，一个端口接通电源另一个就是输出了，' +
  '并且它们都有电源指示。整体绿色为接通，红色为切断。';

/** 延迟规则说明。 */
export const DELAY_TEXT =
  '自动开关 / 能量逆变器都是「控制电源元件」：顶部单独的端口是控制端，其余是电源输入输出端。' +
  '控制端通电后，输出会延迟 1 秒再接通（自动开关）或切断（能量逆变器）；' +
  '若目标状态在 1 秒内又变回去，则倒计时清零重新计时。';

/**
 * 发光颜色调色板（1.0.9）：灯柱 lamp 与发光地板 glow_floor 共用。
 *   - 顺序即 UI 展示顺序（与 engine.LIGHT_COLOR_KEYS 一致）：绿 / 粉 / 黄 / 蓝 / 紫 / 白 / 红。
 *   - on  = 通电点亮时的亮色；off = 断电熄灭时的暗色（同色系暗化版，
 *           保证断电时也能一眼辨认选了哪个颜色）。
 * 说明：光晕一律用「额外一层低透明度同色图形」实现，禁止 CSS filter: drop-shadow /
 * blur —— 1.0.6 已因大灯阵的滤镜开销把导线滤镜删除，LOVE 灯阵有 43 盏灯，滤镜会拖垮交互。
 */
export const LIGHT_COLORS = {
  green: { name: '绿', on: '#2fd06a', off: '#2c5c3f' },
  pink: { name: '粉', on: '#ff6fb5', off: '#7a3a58' },
  yellow: { name: '黄', on: '#ffd23f', off: '#8a7328' },
  blue: { name: '蓝', on: '#3ea8ff', off: '#22527d' },
  purple: { name: '紫', on: '#b57bff', off: '#573a7d' },
  white: { name: '白', on: '#ffffff', off: '#8a949c' },
  red: { name: '红', on: '#ff5a4d', off: '#7d2b26' },
};

/** 取颜色定义；缺省 / 非法 key 回退黄色（yellow），保证任何 props 都能画出图标。 */
function resolveColor(key) {
  return (key && LIGHT_COLORS[key]) ? LIGHT_COLORS[key] : LIGHT_COLORS.yellow;
}

/**
 * 几何：元件包围盒尺寸 + 端口相对偏移（相对元件中心）。
 * dir 仅用于导线出线方向的视觉修饰。
 */
export const GEOMETRY = {
  power: { w: 56, h: 60, ports: { out: { dx: 0, dy: 30, dir: 'down' } } },
  solar_panel: { w: 76, h: 64, ports: { out: { dx: 38, dy: 0, dir: 'right' } } },
  lamp: { w: 40, h: 66, ports: { in: { dx: 0, dy: 34, dir: 'down' } } },
  // 1.0.9 发光地板：正方形发光板（88×88），1 个底部输入端口，电气属性同灯柱。
  glow_floor: { w: 88, h: 88, ports: { in: { dx: 0, dy: 46, dir: 'down' } } },
  door: { w: 96, h: 118, ports: { in: { dx: 0, dy: -60, dir: 'up' } } },
  wall_switch: { w: 60, h: 58, ports: { a: { dx: -34, dy: 4, dir: 'left' }, b: { dx: 34, dy: 4, dir: 'right' } } },
  prox_switch: { w: 60, h: 56, ports: { a: { dx: -34, dy: 0, dir: 'left' }, b: { dx: 34, dy: 0, dir: 'right' } } },
  button: { w: 60, h: 56, ports: { a: { dx: -34, dy: 0, dir: 'left' }, b: { dx: 34, dy: 0, dir: 'right' } } },
  floor_switch: { w: 96, h: 96, ports: { a: { dx: -52, dy: 0, dir: 'left' }, b: { dx: 52, dy: 0, dir: 'right' } } },
  auto_switch: { w: 72, h: 62, ports: { a: { dx: -42, dy: 8, dir: 'left' }, b: { dx: 42, dy: 8, dir: 'right' }, ctrl: { dx: 0, dy: -38, dir: 'up' } } },
  inverter: { w: 72, h: 62, ports: { a: { dx: -42, dy: 8, dir: 'left' }, b: { dx: 42, dy: 8, dir: 'right' }, ctrl: { dx: 0, dy: -38, dir: 'up' } } },
  player: { w: 40, h: 46, ports: {} },
};

/** 取得端口偏移；不存在时返回 {dx:0,dy:0}。 */
export function portOffset(type, port) {
  const g = GEOMETRY[type];
  if (!g || !g.ports[port]) return { dx: 0, dy: 0, dir: 'down' };
  return g.ports[port];
}

/* ------------------------------ SVG 片段工具 ------------------------------ */

/** 状态指示灯：绿=接通，红=切断。 */
function indicator(cx, cy, on) {
  const c = on ? '#2fd06a' : '#e5484d';
  return `<rect x="${cx - 4}" y="${cy - 4}" width="8" height="8" rx="2" fill="${c}" stroke="#0b0f13" stroke-width="1.4"/>`;
}

/** 通用「云朵 / 气泡」外形（自动开关 & 逆变器共用），底部带小尖角。 */
const CLOUD_PATH =
  'M -34 10 C -45 10 -45 -9 -34 -9 ' +
  'C -37 -27 -18 -34 -8 -23 ' +
  'C -4 -39 23 -37 25 -20 ' +
  'C 41 -20 41 5 27 9 ' +
  'C 29 21 16 27 8 21 ' +
  'L 5 21 L 0 32 L -5 21 ' +
  'C -13 27 -31 23 -34 10 Z';

/** 顶部控制端口凸起。 */
const CTRL_TAB = '<rect x="-7" y="-42" width="14" height="13" rx="3" fill="#f4f6f8" stroke="#0b0f13" stroke-width="3"/>';

/* ------------------------------ 各元件图标 ------------------------------ */

/** 墙壁开关：圆角白块 + 顶部橙色竖板 + 红色拱形提手。 */
function iconWallSwitch(v) {
  const on = !!v.state.conducting;
  return (
    `<rect x="-24" y="-20" width="48" height="44" rx="15" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="-7" y="-40" width="14" height="22" rx="3" fill="#e08a2a" stroke="#0b0f13" stroke-width="3"/>` +
    `<path d="M-18 -22 C -18 -48 18 -48 18 -22" fill="none" stroke="#c0392b" stroke-width="5" stroke-linecap="round"/>` +
    indicator(-30, 20, on) +
    indicator(30, 20, on)
  );
}

/** 邻近开关：圆角白块 + 左右凹口 + 蓝色同心圆「眼睛」。 */
function iconProxSwitch(v) {
  const on = !!v.state.conducting;
  return (
    `<rect x="-24" y="-20" width="48" height="40" rx="13" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="-36" y="-9" width="12" height="18" rx="5" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="24" y="-9" width="12" height="18" rx="5" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<circle r="14" fill="#dcefff" stroke="#0b0f13" stroke-width="3"/>` +
    `<circle r="9" fill="none" stroke="#2b9fd8" stroke-width="5"/>` +
    `<circle r="3.6" fill="#2b9fd8"/>` +
    indicator(-14, 15, on) +
    indicator(14, 15, on)
  );
}

/** 按钮开关：圆角白块 + 左右凹口 + 正中纯红实心圆。 */
function iconButton(v) {
  const on = !!v.state.conducting;
  return (
    `<rect x="-24" y="-20" width="48" height="40" rx="13" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="-36" y="-9" width="12" height="18" rx="5" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="24" y="-9" width="12" height="18" rx="5" fill="#eef2f6" stroke="#0b0f13" stroke-width="4"/>` +
    `<circle r="11" fill="#e5342b" stroke="#0b0f13" stroke-width="3"/>` +
    indicator(-14, 15, on) +
    indicator(14, 15, on)
  );
}

/** 地面开关：较大的圆角矩形 + 深色板面 + 两条橙色人字纹。 */
function iconFloorSwitch(v) {
  const on = !!v.state.conducting;
  return (
    `<rect x="-38" y="-38" width="76" height="76" rx="12" fill="#2b3138" stroke="#0b0f13" stroke-width="5"/>` +
    `<rect x="-9" y="-47" width="18" height="11" rx="3" fill="#2b3138" stroke="#0b0f13" stroke-width="4"/>` +
    `<path d="M-18 4 L0 -14 L18 4" fill="none" stroke="#e0a53a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M-18 22 L0 4 L18 22" fill="none" stroke="#e0a53a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
    indicator(-30, 30, on) +
    indicator(30, 30, on)
  );
}

/** 自动开关：云朵形 + 正中绿色 ⊢ 符号。 */
function iconAutoSwitch(v) {
  const on = !!v.state.conducting;
  const c = on ? '#37c35a' : '#37c35a';
  return (
    CTRL_TAB +
    `<path d="${CLOUD_PATH}" fill="#f4f6f8" stroke="#0b0f13" stroke-width="4" stroke-linejoin="round"/>` +
    `<path d="M-11 -13 L-11 14" stroke="${c}" stroke-width="7" stroke-linecap="round"/>` +
    `<path d="M-11 -13 L13 -13" stroke="${c}" stroke-width="7" stroke-linecap="round"/>` +
    indicator(-22, 18, on) +
    indicator(22, 18, on)
  );
}

/** 能量逆变器：云朵形 + 左侧红方块列 + 右侧绿方块列。 */
function iconInverter(v) {
  const on = !!v.state.conducting;
  let reds = '';
  let greens = '';
  for (let i = 0; i < 3; i++) {
    const y = -18 + i * 14;
    reds += `<rect x="-16" y="${y}" width="9" height="9" rx="1.5" fill="#e5342b"/>`;
    greens += `<rect x="7" y="${y}" width="9" height="9" rx="1.5" fill="#2fd06a"/>`;
  }
  return (
    CTRL_TAB +
    `<path d="${CLOUD_PATH}" fill="#f4f6f8" stroke="#0b0f13" stroke-width="4" stroke-linejoin="round"/>` +
    reds +
    greens +
    indicator(-22, 20, on) +
    indicator(22, 20, on)
  );
}

/**
 * 电源：蓝色闪电。on=true（或缺省）亮蓝发光（供电）；on=false 压暗变灰（已关断）+ 红色指示灯。
 */
function iconPower(v) {
  const on = !(v.state && v.state.on === false); // 缺省视为开启（元件库缩略图等无状态场景）
  const fill = on ? '#28c7ff' : '#5a6a76';
  const glow = on ? ' style="filter:drop-shadow(0 0 3px rgba(40,199,255,0.85))"' : '';
  return (
    `<path d="M9 -32 L-15 6 L-1 6 L-8 32 L17 -8 L3 -8 Z" fill="${fill}" stroke="#0b0f13" stroke-width="3" stroke-linejoin="round"${glow}/>` +
    indicator(22, 24, on)
  );
}

/**
 * 太阳能板：深蓝面板 + 银灰外框 + 支架腿 + 格栅。
 * 白天（supplying）格栅发亮、面板明亮；夜晚整体压暗。右下角指示灯：绿=供电 / 红=停止。
 */
function iconSolarPanel(v) {
  const on = !!(v.state && v.state.supplying);
  const frame = on ? '#cdd6de' : '#7f8a94';
  const panel = on ? '#1d3a63' : '#132845';
  const grid = on ? '#3ea8ff' : '#2b4a6d';
  const glow = on ? ' style="filter:drop-shadow(0 0 3px rgba(62,168,255,0.9))"' : '';
  return (
    // 支架腿
    `<rect x="-26" y="10" width="7" height="18" rx="2" fill="#8b96a0" stroke="#0b0f13" stroke-width="2"/>` +
    `<rect x="19" y="10" width="7" height="18" rx="2" fill="#8b96a0" stroke="#0b0f13" stroke-width="2"/>` +
    // 面板 + 银灰外框
    `<rect x="-34" y="-28" width="68" height="38" rx="3" fill="${panel}" stroke="${frame}" stroke-width="3.5"/>` +
    // 格栅（3 列 × 2 行）
    `<path d="M-11.3 -28 V10 M11.3 -28 V10 M-34 -9 H34" fill="none" stroke="${grid}" stroke-width="2"${glow}/>` +
    indicator(28, 24, on)
  );
}

/**
 * 输出端（灯柱）：圆柱形灯柱。1.0.9 起颜色可选（props.color，缺省黄）：
 *   亮 = on 色 + 同色半透明光晕；灭 = off 色 + 无光晕。
 * 光晕用「额外一层低透明度同色放大矩形」实现，禁止 CSS filter（LOVE 灯阵 43 盏灯）。
 */
function iconLamp(v) {
  const on = !!v.state.lit;
  const c = resolveColor(v.props && v.props.color);
  const fill = on ? c.on : c.off;
  let svg = '';
  if (on) {
    svg += `<rect x="-21" y="-40" width="42" height="74" rx="21" fill="${c.on}" opacity="0.30"/>`;
  }
  svg +=
    `<rect x="-15" y="-34" width="30" height="62" rx="15" fill="${fill}" stroke="#0b0f13" stroke-width="4"/>` +
    `<path d="M-15 -14 H15 M-15 6 H15 M-15 26 H15" stroke="#0b0f13" stroke-width="2.4" opacity="0.5"/>`;
  return svg;
}

/**
 * 发光地板（1.0.9）：正方形发光板——深色方形底座 + 内嵌正方形发光面。
 *   亮 = on 色 + 外围同色半透明光晕；灭 = off 色 + 无光晕。
 * 电气属性与输出端（灯柱）完全一致（1 个 in 端口，通电即亮 / 断电即灭）。
 * 与地面开关 floor_switch 无关：不参与玩家踩踏感应。
 */
function iconGlowFloor(v) {
  const on = !!v.state.lit;
  const c = resolveColor(v.props && v.props.color);
  const face = on ? c.on : c.off;
  let svg = '';
  if (on) {
    // 光晕：额外一层低透明度同色图形（同上，禁止滤镜）
    svg += `<rect x="-50" y="-50" width="100" height="100" rx="16" fill="${c.on}" opacity="0.30"/>`;
  }
  svg +=
    `<rect x="-44" y="-44" width="88" height="88" rx="12" fill="#141c24" stroke="#0b0f13" stroke-width="4"/>` +
    `<rect x="-34" y="-34" width="68" height="68" rx="8" fill="${face}" stroke="#0b0f13" stroke-width="3"/>`;
  return svg;
}

/** 普通电门：八角形门框 + 门扇。断电=打开（通行），通电=关闭（拦截）。 */
function iconDoor(v) {
  const open = !!v.state.open;
  const leaf = open ? '#123042' : '#c9d1d8';
  return (
    `<path d="M-30 -52 L-44 -38 L-44 38 L-30 52 L30 52 L44 38 L44 -38 L30 -52 Z" fill="none" stroke="#0b0f13" stroke-width="5" stroke-linejoin="round"/>` +
    `<path d="M-24 -42 L24 -42 L24 42 L-24 42 Z" fill="${leaf}" stroke="#0b0f13" stroke-width="3"/>` +
    `<path d="M0 -42 L0 42" stroke="#0b0f13" stroke-width="3"/>` +
    (open
      ? `<path d="M-24 0 L-8 -12 L-8 12 Z" fill="#28c7ff" opacity="0.5"/>`
      : `<rect x="-10" y="-9" width="20" height="18" rx="2" fill="#0b1015" opacity="0.5"/>`)
  );
}

/** 玩家令牌：小人标记。 */
function iconPlayer() {
  return (
    `<circle cx="0" cy="-12" r="9" fill="#28c7ff" stroke="#0b0f13" stroke-width="3"/>` +
    `<path d="M-13 24 L-13 4 C -13 -3 13 -3 13 4 L13 24" fill="#28c7ff" stroke="#0b0f13" stroke-width="3" stroke-linejoin="round"/>`
  );
}

/** 将 view 规整为图标函数可安全读取的形状。 */
function normView(view) {
  const v = view || {};
  return {
    state: v.state || {
      conducting: false,
      lit: false,
      open: true,
      on: true, // 与 engine defaultState('power').on 一致：电源默认开启
      pulse: 0,
      timer: 0,
      supplying: false,
    },
    props: v.props || {},
  };
}

/**
 * 绘制某类型元件的图标（返回内联 SVG 片段字符串，坐标系以元件中心为原点）。
 * @param {string} type 元件类型
 * @param {object} [view] 元件视图（含 state / props）
 * @returns {string}
 */
export function drawIcon(type, view) {
  const v = normView(view);
  switch (type) {
    case 'power': return iconPower(v);
    case 'solar_panel': return iconSolarPanel(v);
    case 'lamp': return iconLamp(v);
    case 'glow_floor': return iconGlowFloor(v);
    case 'door': return iconDoor(v);
    case 'wall_switch': return iconWallSwitch(v);
    case 'prox_switch': return iconProxSwitch(v);
    case 'button': return iconButton(v);
    case 'floor_switch': return iconFloorSwitch(v);
    case 'auto_switch': return iconAutoSwitch(v);
    case 'inverter': return iconInverter(v);
    case 'player': return iconPlayer(v);
    default: return '';
  }
}

/* ------------------------------ 图鉴数据 ------------------------------ */

/** 电源 / 太阳能板 / 输出端 / 普通电门 + 6 种控制元件 + 玩家令牌，共 11 项。 */
export const ELEMENTS = [
  {
    id: 'power',
    name: '电源',
    en: 'Power Source',
    group: '基础',
    portsText: '1 个输出端口 out',
    principle: '基地的供电来源，持续向网络输出电力，是整条电路的起点。可人为关断：点击元件本体即可切断 / 恢复输出（图标变灰即已关断）。',
    usage: '作为电路起点，把它接到开关的任一侧端口即可；点击元件本体可人为切断/恢复输出。',
  },
  {
    id: 'solar_panel',
    name: '太阳能板',
    en: 'Solar Panel',
    group: '基础',
    portsText: '1 个输出端口 out',
    principle: '白天日照充足时持续为电网提供电力；入夜后日照消失，输出即停止供电。昼夜切换是即时的，不经过 1 秒延迟。',
    usage: '把它接到用电设备或开关的输入端；在实验室顶部的时刻控件上拖动时间，即可观察白天供电 / 夜晚断电的切换。',
  },
  {
    id: 'lamp',
    name: '输出端（灯柱）',
    en: 'Light / Output',
    group: '基础',
    portsText: '1 个输入端口 in',
    principle: '通电即点亮，断电熄灭，用来直观显示「信号是否到达」。',
    usage: '接在任一开关的输出端，作为状态指示灯；颜色可选绿 / 粉 / 黄 / 蓝 / 紫 / 白 / 红。',
  },
  {
    id: 'glow_floor',
    name: '发光地板',
    en: 'Glowing Floor',
    group: '基础',
    portsText: '1 个输入端口 in',
    principle: '通电即发光、断电熄灭；形状为正方形发光板；发光颜色可选绿 / 粉 / 黄 / 蓝 / 紫 / 白 / 红，与输出端（灯柱）属性一致。',
    usage: '接在任一开关的输出端，作为地面发光板使用；发光颜色可在属性面板切换。',
  },
  {
    id: 'door',
    name: '普通电门',
    en: 'Powered Door',
    group: '基础',
    portsText: '1 个输入端口 in',
    principle: '通电 = 关闭（拦截通行），断电 = 打开（允许通行）。',
    usage: '常与邻近开关配合：人走门自动打开，人离开门自动关闭。',
  },
  {
    id: 'wall_switch',
    name: '墙壁开关',
    en: 'Wall Switch',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）',
    principle: '把手向上或者向下为接通电源，反之为切断电源，靠近按住E人为手动控制开关。',
    usage: '点击元件本体即可翻转；作为手动控制信号源。',
  },
  {
    id: 'prox_switch',
    name: '邻近开关',
    en: 'Proximity Switch',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）',
    principle: '当人靠近时就会接通电源，离开时感应不到人就会切断电源。感应范围为360度球形，即开关背面也能感应。',
    usage: '把玩家令牌拖进圆形感应半径内即导通；半径可在属性面板调整。',
  },
  {
    id: 'button',
    name: '按钮开关',
    en: 'Push Button',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）',
    principle: '默认是不接通电源的，当靠近接住E按下按钮时，电源将接通1秒，随后弹起关闭电源。',
    usage: '点击元件本体触发一次 1 秒的接通脉冲。',
  },
  {
    id: 'floor_switch',
    name: '地面开关',
    en: 'Floor Switch',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）',
    principle: '体型很大，当人站上去时电源接通，离开时电源切断。',
    usage: '把玩家令牌拖到板面上即导通，离开即切断。',
  },
  {
    id: 'auto_switch',
    name: '自动开关',
    en: 'Auto Switch',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）+ 1 个控制端 ctrl（顶部）',
    principle: '控制电源元件，顶部单独的端口为控制端，其余是电源输入输出端。当给控制端通电时，输出电源将在1秒后接通。',
    usage: 'a↔b 的导通状态 = 控制端信号「延迟 1 秒」后的值（延迟跟随）。',
  },
  {
    id: 'inverter',
    name: '能量逆变器',
    en: 'Power Inverter',
    group: '控制元件',
    portsText: '2 个端口 a / b（可互换）+ 1 个控制端 ctrl（顶部）',
    principle: '控制电源元件，顶部单独的端口为控制端，其余是电源输入输出端。当给控制端通电时，输出电源将在1秒后切断。',
    usage: 'a↔b 的导通状态 = 控制端信号「延迟 1 秒」后取反的值（延迟反相）。',
  },
  {
    id: 'player',
    name: '玩家令牌',
    en: 'Player Token',
    group: '辅助',
    portsText: '无端口',
    principle: '不是电气元件，仅表示玩家的位置，用于驱动邻近开关与地面开关。',
    usage: '可自由拖动，用来演示人靠近 / 踩踏的感应效果。',
  },
];

/** id -> 定义。 */
export const EL_BY_ID = ELEMENTS.reduce((m, e) => {
  m[e.id] = e;
  return m;
}, {});

/** 元件库顺序（放置面板用）。 */
export const PALETTE_ORDER = [
  'power', 'solar_panel', 'lamp', 'glow_floor', 'door', 'wall_switch', 'prox_switch',
  'button', 'floor_switch', 'auto_switch', 'inverter', 'player',
];

export default { ELEMENTS, EL_BY_ID, GEOMETRY, drawIcon, portOffset, RULE_TEXT, DELAY_TEXT, PALETTE_ORDER, LIGHT_COLORS };

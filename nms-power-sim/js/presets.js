/**
 * presets.js — 7 个可直接上电运行的应用实例电路拓扑
 * ---------------------------------------------------------------------------
 * 每个实例包含：标题、参考图、说明、元件清单、拓扑（nodes + links）。
 * 其中 auto_switch / inverter 的 ctrl 端在本项目中作为「信号输入端」使用：
 *   - 自动开关：ctrl 收到信号后，a↔b 延迟 1 秒接通；
 *   - 逆变器：ctrl 收到信号后，a↔b 延迟 1 秒切断。
 * 为了让信号能沿链路逐级传递，实例中把各级自动开关的 ctrl 与自身输入 a 相连
 * （即「延迟线」用法），再用反馈线把末级输出接回首级 ctrl 形成环。
 * ---------------------------------------------------------------------------
 */

/** 载入一个实例到引擎（会先清空引擎）。 */
export function loadPreset(engine, preset) {
  if (!engine || !preset) return false;
  engine.reset();
  const idMap = {};
  for (const n of preset.nodes) {
    const id = `${preset.id}_${n.key}`;
    idMap[n.key] = id;
    engine.addElement(n.type, { id, x: n.x, y: n.y, props: n.props || {} });
    if (n.type === 'wall_switch' && n.init && n.init.on) {
      engine.setWallSwitch(id, true);
    }
  }
  for (const link of preset.links) {
    const [ka, pa, kb, pb] = link;
    const a = idMap[ka];
    const b = idMap[kb];
    if (!a || !b) continue;
    engine.addWire(a, pa, b, pb);
  }
  return true;
}

export const PRESETS = [
  /* ------------------------------------------------------------------ 1 */
  {
    id: 'door_auto',
    title: '门的自动开关应用',
    tag: '邻近开关 + 能量逆变器',
    image: 'assets/52862d014a90f603868b271e2e12b31bb051edb2.jpg',
    summary:
      '用邻近开关感知玩家位置，再经能量逆变器反相后驱动普通电门：无人时门通电关闭，玩家走进感应圈后延迟 1 秒门断电打开。',
    howto: [
      '电源同时接到「邻近开关」与「能量逆变器」的输入端。',
      '邻近开关的输出接到逆变器的控制端（ctrl）。',
      '逆变器输出接到普通电门，完成整个回路。',
      '把玩家令牌拖进/拖出感应圈，观察电门在 1 秒后开合的变化。',
    ],
    keyPoint: '关键延时在逆变器的控制端：控制信号变化后需连续保持 1 秒才真正切换。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '邻近开关', qty: 1 },
      { name: '能量逆变器', qty: 1 },
      { name: '普通电门', qty: 1 },
      { name: '玩家令牌', qty: 1 },
    ],
    nodes: [
      { key: 'power', type: 'power', x: 110, y: 470 },
      { key: 'prox', type: 'prox_switch', x: 430, y: 170 },
      { key: 'inv', type: 'inverter', x: 430, y: 330 },
      { key: 'door', type: 'door', x: 760, y: 300 },
      { key: 'player', type: 'player', x: 640, y: 140 },
    ],
    links: [
      ['power', 'out', 'prox', 'a'],
      ['power', 'out', 'inv', 'a'],
      ['prox', 'b', 'inv', 'ctrl'],
      ['inv', 'b', 'door', 'in'],
    ],
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: 'marquee_button',
    title: '延时信号传递（走马灯 · 按钮开关版）',
    tag: '按钮开关 + 3×自动开关 + 反馈',
    image: 'assets/55b55f13495409234cd9d8278558d109b3de4938.jpg',
    summary:
      '按一次按钮，信号以「每秒一跳」的节奏在三个输出端之间循环传递，形成走马灯效果；末级输出经反馈线返回首级控制端维持循环。',
    howto: [
      '电源 → 按钮开关；按钮开关输出接到自动开关 C 的控制端（ctrl），作为启动信号。',
      '电源另经「电源母线」同时接到三个自动开关的输入 a（保证电流常备）。',
      'C 输出 → B 的控制端；B 输出 → A 的控制端；A 输出再接回 C 的控制端（反馈闭环）。',
      '三个自动开关的输出各接一盏灯。',
    ],
    keyPoint: '每级自动开关延迟 1 秒，配合反馈线即可让信号自我循环；多次连按会使全部输出同时激活。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '按钮开关', qty: 1 },
      { name: '自动开关', qty: 3 },
      { name: '输出端（灯柱）', qty: 3 },
    ],
    nodes: [
      { key: 'power', type: 'power', x: 100, y: 450 },
      { key: 'btn', type: 'button', x: 280, y: 430 },
      { key: 'c', type: 'auto_switch', x: 470, y: 340 },
      { key: 'b', type: 'auto_switch', x: 660, y: 340 },
      { key: 'a', type: 'auto_switch', x: 850, y: 340 },
      { key: 'l1', type: 'lamp', x: 470, y: 180 },
      { key: 'l2', type: 'lamp', x: 660, y: 180 },
      { key: 'l3', type: 'lamp', x: 850, y: 180 },
    ],
    links: [
      ['power', 'out', 'btn', 'a'],
      ['btn', 'b', 'c', 'ctrl'],
      ['power', 'out', 'c', 'a'],
      ['power', 'out', 'b', 'a'],
      ['power', 'out', 'a', 'a'],
      ['c', 'b', 'b', 'ctrl'],
      ['b', 'b', 'a', 'ctrl'],
      ['a', 'b', 'c', 'ctrl'],
      ['c', 'b', 'l1', 'in'],
      ['b', 'b', 'l2', 'in'],
      ['a', 'b', 'l3', 'in'],
    ],
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: 'waterfall_inverter',
    title: '延时信号传递（流水灯 · 环形振荡器版）',
    tag: '能量逆变器 + 3×自动开关 环形振荡器',
    image: 'assets/f6771fd4b31c8701a21909bf307f9e2f0608ffc5.jpg',
    summary:
      '无需按钮即可自动循环的流水灯：电源先经墙壁开关总闸，再进逆变器；逆变器作为振荡源，三级自动开关把信号逐级后传，末级输出反馈回逆变器控制端。一个完整周期约 8 秒。',
    howto: [
      '电源 → 墙壁开关（总闸）→ 能量逆变器输入端 a；总闸输出同时经「电源母线」接到三级自动开关的输入 a（保证电流常备）。',
      '逆变器输出 → 自动开关 1 的控制端 ctrl；自动开关 1 输出 → 自动开关 2 控制端；自动开关 2 输出 → 自动开关 3 控制端。',
      '自动开关 3 的输出反馈回逆变器的控制端 ctrl，令逆变器周期性通断。',
      '三级自动开关的输出各接一盏灯。总闸默认合上，载入即自动循环；可点击墙壁开关亲手断/合。',
    ],
    keyPoint: '4 级 × 1 秒 × 2 = 8 秒为一个完整周期；三级灯以 1 秒为间隔依次推进，形成持续追逐的波（周期内会出现三灯同亮的相位）。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '墙壁开关（总闸）', qty: 1 },
      { name: '能量逆变器', qty: 1 },
      { name: '自动开关', qty: 3 },
      { name: '输出端（灯柱）', qty: 3 },
    ],
    nodes: [
      { key: 'power', type: 'power', x: 80, y: 480 },
      { key: 'sw', type: 'wall_switch', x: 240, y: 480, init: { on: true } },
      { key: 'inv', type: 'inverter', x: 410, y: 400 },
      { key: 's1', type: 'auto_switch', x: 560, y: 330 },
      { key: 's2', type: 'auto_switch', x: 720, y: 330 },
      { key: 's3', type: 'auto_switch', x: 880, y: 330 },
      { key: 'l1', type: 'lamp', x: 560, y: 170 },
      { key: 'l2', type: 'lamp', x: 720, y: 170 },
      { key: 'l3', type: 'lamp', x: 880, y: 170 },
    ],
    links: [
      ['power', 'out', 'sw', 'a'],
      ['sw', 'b', 'inv', 'a'],
      ['sw', 'b', 's1', 'a'],
      ['sw', 'b', 's2', 'a'],
      ['sw', 'b', 's3', 'a'],
      ['inv', 'b', 's1', 'ctrl'],
      ['s1', 'b', 's2', 'ctrl'],
      ['s2', 'b', 's3', 'ctrl'],
      ['s3', 'b', 'inv', 'ctrl'],
      ['s1', 'b', 'l1', 'in'],
      ['s2', 'b', 'l2', 'in'],
      ['s3', 'b', 'l3', 'in'],
    ],
  },

  /* ------------------------------------------------------------------ 4 */
  /* 1.0.12 重做：按教程参考图重建拓扑（3 自动开关 + 3 能量逆变器 + 无状态灯），
   * 并修正门的方向——密码正确时门「打开（通行）」，而非原来的通电关闭。
   * 元件：电源×1、墙壁开关×4、自动开关×3（aA/aB/aC 三级与链）、
   *       能量逆变器×3（inv2 / inv4 取反密码位②④，invD 末级反相驱动门）、普通电门×1。
   * 布局：底部一排 4 个墙壁开关为输入；中部取反逆变器；上方三级自动开关串成与链；
   *       末级逆变器 invD 在链尾上方，输出接右侧普通电门。 */
  {
    id: 'password_door',
    title: '简单密码门的应用',
    tag: '4×墙壁开关 逻辑与链',
    image: 'assets/82ab300f4bfbfbed48a18d266ff0f736aec31ff0.jpg',
    summary:
      '四个墙壁开关组成「开-关-开-关」的密码，三级自动开关串成逻辑与（AND）链——其中第②④位经能量逆变器取反后才算对。末级逆变器把「密码正确」反相为「门断电」，于是只有密码完全正确时电门才打开放行；其余 15 种组合门都保持通电关闭（锁住）。',
    howto: [
      '电源分两路：一路（电源母线）同时给 4 个墙壁开关、取反逆变器 inv2/inv4 和末级逆变器 invD 的电源输入端 a 供电；另一路经墙壁开关①串进逻辑与链。',
      '逻辑与链：w1.b → 自动开关 A.a → 自动开关 B.a → 自动开关 C.a → 末级逆变器 invD 的控制端 ctrl，四级串联，任一级不导通整条链就断。',
      'A 的控制端取自「逆变器 inv2」的输出（墙开②拨到「关」时 inv2 才导通，即取反）；B 的控制端直接取自墙开③（「开」才导通）；C 的控制端取自「逆变器 inv4」的输出（墙开④拨到「关」时 inv4 才导通）。',
      '末级逆变器 invD：电源接它的 a，链末级输出接它的 ctrl，它的输出 b 接普通电门。密码正确 → 链导通 → invD 收到控制信号 → 1 秒后切断 → 门断电 → 打开。',
      '正确密码：①开、②关、③开、④关。拨错任一位，链断 → invD 恢复导通 → 门重新通电关闭（锁住）。',
    ],
    keyPoint: '普通电门是反逻辑：通电 = 关闭（拦截），断电 = 打开（通行）。所以链末级必须再加一级逆变器，把「密码正确（链导通）」反相成「门断电」——这正是参考图上第 3 个逆变器的用途。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '墙壁开关', qty: 4 },
      { name: '自动开关', qty: 3 },
      { name: '能量逆变器', qty: 3 },
      { name: '普通电门', qty: 1 },
    ],
    nodes: [
      // 底部：电源 + 4 个墙壁开关（玩家输入，初始即「开-关-开-关」）
      { key: 'power', type: 'power', x: 80, y: 490 },
      { key: 'w1', type: 'wall_switch', x: 200, y: 490, init: { on: true } },
      { key: 'w2', type: 'wall_switch', x: 340, y: 490, init: { on: false } },
      { key: 'w3', type: 'wall_switch', x: 510, y: 490, init: { on: true } },
      { key: 'w4', type: 'wall_switch', x: 680, y: 490, init: { on: false } },
      // 中部：两个取反逆变器（分别在墙开②/④所在列，输出向上喂对应自动开关的 ctrl）
      { key: 'inv2', type: 'inverter', x: 340, y: 350 },
      { key: 'inv4', type: 'inverter', x: 680, y: 350 },
      // 上方：三级自动开关串成与链（信号从左往右），链尾接末级逆变器
      { key: 'aA', type: 'auto_switch', x: 340, y: 190 },
      { key: 'aB', type: 'auto_switch', x: 510, y: 190 },
      { key: 'aC', type: 'auto_switch', x: 680, y: 190 },
      // 链尾：末级反相逆变器 + 普通电门（负载在末端）
      { key: 'invD', type: 'inverter', x: 860, y: 190 },
      { key: 'door', type: 'door', x: 990, y: 250 },
    ],
    links: [
      // —— 电源母线（7 根）：4 个墙壁开关 + 2 个取反逆变器 + 末级逆变器 ——
      ['power', 'out', 'w1', 'a'],
      ['power', 'out', 'w2', 'a'],
      ['power', 'out', 'w3', 'a'],
      ['power', 'out', 'w4', 'a'],
      ['power', 'out', 'inv2', 'a'],
      ['power', 'out', 'inv4', 'a'],
      ['power', 'out', 'invD', 'a'],
      // —— 逻辑与链（4 根）：w1 → aA → aB → aC → invD.ctrl ——
      ['w1', 'b', 'aA', 'a'],
      ['aA', 'b', 'aB', 'a'],
      ['aB', 'b', 'aC', 'a'],
      ['aC', 'b', 'invD', 'ctrl'],
      // —— 门（1 根）——
      ['invD', 'b', 'door', 'in'],
      // —— 三级控制端（5 根）：②经 inv2 取反 / ③直连 / ④经 inv4 取反 ——
      ['w2', 'b', 'inv2', 'ctrl'],
      ['inv2', 'b', 'aA', 'ctrl'],
      ['w3', 'b', 'aB', 'ctrl'],
      ['w4', 'b', 'inv4', 'ctrl'],
      ['inv4', 'b', 'aC', 'ctrl'],
    ],
  },

  /* ------------------------------------------------------------------ 5 */
  {
    id: 'two_way',
    title: '双控开关应用',
    tag: '2×墙壁开关 + 2×自动开关 + 2×逆变器（XOR）',
    image: 'assets/600aefec54e736d15e7b37518c504fc2d5626900.jpg',
    summary:
      '两个墙壁开关控制同一盏灯，任一开关单独动作都能翻转灯的状态；两个都开或都关时灯灭——即异或（XOR）逻辑。布局复刻素材的「两列 + 中间 X 交叉 + 顶部输出端」。',
    howto: [
      '电源分别接到左右两个墙壁开关。',
      '墙开1 输出 → 自动开关1 → 逆变器1 → 灯；墙开2 输出 → 自动开关2 → 逆变器2 → 灯。',
      '左侧自动开关的控制端取自墙开1，右侧逆变器的控制端交叉取自墙开1（反之亦然）。',
      '点击任一墙壁开关，观察灯在「亮/灭」之间翻转。',
    ],
    keyPoint: '两条支路分别为「墙开1 且 非墙开2」与「墙开2 且 非墙开1」，并联即得 XOR。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '墙壁开关', qty: 2 },
      { name: '自动开关', qty: 2 },
      { name: '能量逆变器', qty: 2 },
      { name: '输出端（灯柱）', qty: 1 },
    ],
    nodes: [
      { key: 'power', type: 'power', x: 110, y: 480 },
      // 输出端（灯柱）下移 30px（90→120）：F6 引入重叠感知绕行后，w12(invR.b→lamp.in)
      // 的顶层长横段若仍落在 y=238（invR.a/b 同一行）会与 w10(autoR.b→invR.a) 并排压线 38px；
      // 重叠感知绕行会改道 w12，从而抹掉 two_way 设计中的两处交叉。把灯柱下移 30px 后，
      // 两条交叉线（w6×w12、w11×w12）重新落在有效交点，且全预设共线段 >26px 对数 = 0。
      { key: 'lamp', type: 'lamp', x: 480, y: 120 },
      // 说明：invR 较 invL 下移 20px（打破两列完全对称）—— 让两条「交叉控制线」
      // （w2→invL.ctrl 与 w1→invR.ctrl）的顶层水平段落在不同 y，从而在画面中部
      // 形成清晰的可见正交交叉，且两条交叉线不再并排压线（水平段重叠 0px）；
      // 20px 的错位同时避免两处交叉点过近（半径 7 的拱不会相互叠压）。
      { key: 'invL', type: 'inverter', x: 350, y: 210 },
      { key: 'invR', type: 'inverter', x: 610, y: 230 },
      { key: 'autoL', type: 'auto_switch', x: 350, y: 350 },
      { key: 'autoR', type: 'auto_switch', x: 610, y: 350 },
      { key: 'w1', type: 'wall_switch', x: 350, y: 490 },
      { key: 'w2', type: 'wall_switch', x: 610, y: 490 },
    ],
    links: [
      ['power', 'out', 'w1', 'a'],
      ['power', 'out', 'w2', 'a'],
      ['w1', 'b', 'autoL', 'a'],
      ['w1', 'b', 'autoL', 'ctrl'],
      ['autoL', 'b', 'invL', 'a'],
      ['w2', 'b', 'invL', 'ctrl'],
      ['invL', 'b', 'lamp', 'in'],
      ['w2', 'b', 'autoR', 'a'],
      ['w2', 'b', 'autoR', 'ctrl'],
      ['autoR', 'b', 'invR', 'a'],
      ['w1', 'b', 'invR', 'ctrl'],
      ['invR', 'b', 'lamp', 'in'],
    ],
  },

  /* ------------------------------------------------------------------ 6 */
  {
    id: 'strobe',
    title: '频闪灯的应用',
    tag: '墙壁开关 + 逆变器 自反馈振荡',
    image: 'assets/92946203738da977ce353d72a751f8198618e353.jpg',
    summary:
      '逆变器的输出自反馈到自己的控制端，形成一个反相延迟振荡器。合上墙壁开关后，灯以约 1 秒为半周期持续闪烁。',
    howto: [
      '电源 → 墙壁开关 → 能量逆变器输入端 a。',
      '逆变器输出 → 输出端（灯）。',
      '额外拉一根线，把逆变器输出接回它自己的控制端 ctrl。',
      '点击墙壁开关合上电源，灯随即开始闪烁；再次点击切断则停止。',
    ],
    keyPoint: '输出取反 → 延迟 1 秒 → 再次取反，如此往复，半周期恰为 1 秒。',
    parts: [
      { name: '电源', qty: 1 },
      { name: '墙壁开关', qty: 1 },
      { name: '能量逆变器', qty: 1 },
      { name: '输出端（灯柱）', qty: 1 },
    ],
    nodes: [
      { key: 'power', type: 'power', x: 300, y: 180 },
      { key: 'wall', type: 'wall_switch', x: 300, y: 360 },
      { key: 'inv', type: 'inverter', x: 560, y: 360 },
      { key: 'lamp', type: 'lamp', x: 780, y: 200 },
    ],
    links: [
      ['power', 'out', 'wall', 'a'],
      ['wall', 'b', 'inv', 'a'],
      ['inv', 'b', 'lamp', 'in'],
      ['inv', 'b', 'inv', 'ctrl'],
    ],
  },

  /* ------------------------------------------------------------------ 7 */
  {
    id: 'solar_day_night',
    title: '太阳能板的昼夜供电',
    tag: '新增元件 · 昼夜循环',
    image: 'assets/电力大图.png', // 素材里太阳能板图标的来源截图
    summary:
      '太阳能板只在白天输出电力：把时刻拖到白天，灯柱点亮；拖到夜晚，灯柱立即熄灭（无 1 秒延迟）。',
    howto: [
      '把太阳能板的输出端口 out 接到输出端（灯柱）的输入端口 in，一根线即可。',
      '拖动工具栏上的「时刻」滑块到 06:00–18:00 之间 → 灯柱点亮。',
      '拖到 18:00–06:00 之间 → 灯柱立即熄灭，说明太阳能板在夜间停止供电。',
      '勾选「昼夜循环」后，时间会自动流逝，一整天 = 60 秒（受仿真速度倍率影响）。',
    ],
    keyPoint: '昼夜切换是即时的，不经过 1 秒延迟 —— 这是它与自动开关 / 能量逆变器的根本区别。',
    parts: [
      { name: '太阳能板', qty: 1 },
      { name: '输出端（灯柱）', qty: 1 },
    ],
    // 说明：solar_panel 的 out 端口朝向设为 right（见 catalog GEOMETRY），
    // 并把太阳能板放在灯柱下方，使出线为干净的正交 L 形且不穿越灯体。
    nodes: [
      { key: 'solar', type: 'solar_panel', x: 380, y: 420 },
      { key: 'lamp', type: 'lamp', x: 700, y: 300 },
    ],
    links: [['solar', 'out', 'lamp', 'in']],
  },
];

export const PRESET_BY_ID = PRESETS.reduce((m, p) => {
  m[p.id] = p;
  return m;
}, {});

export default { PRESETS, PRESET_BY_ID, loadPreset };

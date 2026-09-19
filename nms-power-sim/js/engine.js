/**
 * engine.js — 《无人深空》电力模拟器 · 纯仿真内核
 * ---------------------------------------------------------------------------
 * 设计原则：
 *   1. 零依赖、零 DOM / 浏览器 API，可在 Node 中直接 `import` 后跑测试。
 *   2. 支持任意环路 / 反馈（自反馈、环形振荡器、交叉耦合），使用「并查集」
 *      传播通电状态，不使用递归 DFS，因此不会死循环、不会栈溢出。
 *   3. 每帧执行顺序严格固定（采样 → 推进定时器 → 并查集 → 更新设备），
 *      用「上一帧的通电集合」做采样，天然打破代数环，避免自激。
 *
 * 数据模型：
 *   Element = { id, type, x, y, props: {...}, state: {...} }
 *   Wire    = { id, a: { el, port }, b: { el, port } }
 * ---------------------------------------------------------------------------
 */

/**
 * 每种元件拥有的端口（元件的两个侧端口 a/b 是同一个开关的两端，可互换）。
 * 1.0.9：新增发光地板 glow_floor——与输出端（灯柱）完全相同的电气属性（1 个 in）。
 */
export const TYPE_PORTS = {
  power: ['out'],
  solar_panel: ['out'],
  lamp: ['in'],
  glow_floor: ['in'],
  door: ['in'],
  wall_switch: ['a', 'b'],
  prox_switch: ['a', 'b'],
  button: ['a', 'b'],
  floor_switch: ['a', 'b'],
  auto_switch: ['a', 'b', 'ctrl'],
  inverter: ['a', 'b', 'ctrl'],
  player: [],
};

/** 电源元件（网络的源）：恒电源 + 太阳能板。 */
export const SOURCE_TYPES = ['power', 'solar_panel'];

/** 游戏内一整天 = 60 真实秒（受仿真速度倍率影响）。 */
export const DAY_LENGTH_SECONDS = 60;
/** 06:00 日出：白天开始。 */
export const DAY_START_HOUR = 6;
/** 18:00 日落：白天结束。 */
export const DAY_END_HOUR = 18;
/** 终端设备（只读状态，不参与 a/b 导通）。1.0.9：发光地板同为负载。 */
export const SINK_TYPES = ['lamp', 'glow_floor', 'door'];
/** 手动即时元件：状态由玩家位置 / 点击即时决定。 */
export const MANUAL_TYPES = ['wall_switch', 'prox_switch', 'button', 'floor_switch'];
/** 延迟元件：导通状态由控制端经 1 秒延迟决定。 */
export const DELAY_TYPES = ['auto_switch', 'inverter'];
/** 拥有 a-b 内部开关边的元件（导通时 a、b 短路连通，切断时隔离）。 */
export const SWITCH_TYPES = [
  'wall_switch', 'prox_switch', 'button', 'floor_switch', 'auto_switch', 'inverter',
];

/** 延迟时长（秒）。 */
export const DELAY_SECONDS = 1.0;
/** 邻近开关默认感应半径（px）。 */
export const DEFAULT_PROX_RADIUS = 130;
/** 按钮开关默认脉冲时长（秒）。 */
export const DEFAULT_PULSE_SECONDS = 1.0;
/** 地面开关感应区半宽（px）。 */
export const FLOOR_HALF = 42;

/**
 * 发光元件可选颜色 key（1.0.9，顺序即 UI 展示顺序）。
 * 灯柱 lamp 与发光地板 glow_floor 共用；颜色纯外观，不影响仿真（lit 只由通电决定）。
 */
export const LIGHT_COLOR_KEYS = ['green', 'pink', 'yellow', 'blue', 'purple', 'white', 'red'];

/** 固定仿真步长（秒）；主循环按此步长推进。 */
export const FIXED_DT = 1 / 60;
/** 单帧最多补算的步数，避免长时间卡顿后一次补太多。 */
export const MAX_STEPS = 20;

/** 生成端口节点键：`elId:port`。 */
export function nodeKey(elId, port) {
  return `${elId}:${port}`;
}

/** 返回某类型元件的默认 props。 */
function defaultProps(type) {
  switch (type) {
    case 'prox_switch':
      return { radius: DEFAULT_PROX_RADIUS };
    case 'button':
      return { pulseSeconds: DEFAULT_PULSE_SECONDS };
    // 1.0.9：灯柱 / 发光地板默认黄色（= 保持 1.0.8 观感；旧 JSON 无 color → 自动补默认）
    case 'lamp':
    case 'glow_floor':
      return { color: 'yellow' };
    default:
      return {};
  }
}

/** 返回某类型元件的默认 state。 */
function defaultState(type) {
  const s = { conducting: false, timer: 0 };
  if (type === 'wall_switch') s.on = false;
  if (type === 'button') s.pulse = 0;
  if (type === 'lamp' || type === 'glow_floor') s.lit = false; // 1.0.9：发光地板同灯柱
  if (type === 'door') s.open = true; // 断电 = 打开（通行）
  if (type === 'solar_panel') s.supplying = false;
  if (type === 'power') s.on = true; // 恒电源默认开启，可人为关断
  return s;
}

/** 并查集：路径压缩，避免递归 dfs 造成的栈溢出。 */
function makeUnionFind(keys, parent = new Map()) {
  for (const k of keys) parent.set(k, k);
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    // 路径压缩
    let cur = k;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur);
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  return { find, union };
}

/**
 * 创建仿真引擎实例。
 * @returns {object} 引擎 API
 */
export function createEngine() {
  /** @type {Map<string, object>} id -> element */
  const elements = new Map();
  /** @type {Map<string, object>} id -> wire */
  const wires = new Map();
  /** 上一帧计算出的「已通电节点集合」@type {Set<string>} */
  let powered = new Set();
  let idSeq = 1;
  let wireSeq = 1;
  let simTime = 0;
  /** 游戏内时刻（小时，0–24）。起始 08:00，白天。 */
  let timeOfDay = 8;
  /** 是否开启昼夜自动流逝。 */
  let dayCycle = true;
  /** 走线样式（视图偏好，随序列化保存）：'straight' 直线 | 'curve' 曲线。 */
  let wireStyle = 'straight';
  /**
   * 线条隐藏偏好（1.0.8，视图偏好，随序列化保存）：true 时渲染层隐藏全部
   * 导线与交叉拱（元件保留）。纯视图态——不触碰结构 / 动态修订号（切换开关
   * 是 O(1) 类切换，禁止击穿 1.0.7 的 revision/dynRev 门控）。
   */
  let wiresHidden = false;
  /**
   * 结构修订号（1.0.5 性能修复）：任何会改变「元件集合 / 导线集合 / 元件位置 /
   * 走线样式」的操作都自增一次。渲染层用它做 O(1) 的结构变更检测，替代旧版
   * 每帧拼接大字符串的 computeStructureSig。只增不减，跨 reset 单调。
   */
  let revision = 0;
  function bumpRevision() { revision++; }
  /**
   * 动态状态修订号（1.0.6 性能修复）：任何会改变「通电集合 / 元件动态状态
   * （conducting / lit / open / supplying / 延迟计时 pending）/ props」的事情
   * 发生时自增一次。渲染层（board.refreshDynamic）用它做 O(1) 门控——
   * 修订号不变时跳过逐帧 O(N) 的通电/图标刷新。只增不减，跨 reset 单调。
   */
  let dynRev = 0;
  function bumpDyn() { dynRev++; }
  /* ---- 结构变更清单（1.0.7 增量结构更新）----
   * 每次结构性变更追加一条 {rev, kind, id}：kind ∈ 'el-add' | 'el-remove' |
   * 'el-move' | 'wire-add' | 'wire-remove' | 'full'（整表失效：reset /
   * deserialize / 走线样式切换）。渲染层 getChangesSince(rev) 聚合自某修订号
   * 以来的增量；日志超上限时丢弃最旧一半并抬高 base，过旧基线的请求返回
   * full（渲染层退化为全量重建）。moveElement 高频路径只记 id，不做重活。 */
  const changesLog = [];
  let changesLogBase = 0;
  function logChange(kind, id) {
    changesLog.push({ rev: revision, kind, id });
    if (changesLog.length > 2000) {
      changesLog.splice(0, 1000);
      changesLogBase = changesLog.length ? changesLog[0].rev - 1 : revision;
    }
  }
  /**
   * 聚合自结构修订号 rev 以来的结构变更（1.0.7）。
   * @param {number} rev 渲染层上次处理到的结构修订号（如 -1 表示从未处理）
   * @returns {{from:number, to:number, full:boolean, els:Set<string>, wires:Set<string>}}
   *   full=true 表示无法增量（整表失效 / 基线过旧 / 越界），渲染层应全量重建；
   *   els/wires 为涉及变更的元件 / 导线 id 集合（同一 id 的增删改已按最终态合并）。
   */
  function getChangesSince(rev) {
    const from = Number(rev);
    const base = Number.isFinite(from) ? from : -1;
    const els = new Set();
    const wires = new Set();
    const out = { from: base, to: revision, full: false, els, wires };
    if (base < 0 || base < changesLogBase || base > revision) {
      out.full = true;
      return out;
    }
    for (const e of changesLog) {
      if (e.rev <= base) continue;
      if (e.kind === 'full') { out.full = true; return out; }
      if (e.kind === 'el-add' || e.kind === 'el-remove' || e.kind === 'el-move') els.add(e.id);
      else wires.add(e.id);
    }
    return out;
  }
  /* ---- tick 跨帧复用容器（1.0.5 性能修复：减少每帧堆分配） ---- */
  const keysCache = [];
  let keysRevision = -1;
  const ufParent = new Map();
  let poweredScratch = new Set();

  const now = () => simTime;

  /** 当前是否为白天（06:00 ≤ t < 18:00）。 */
  function isDay() {
    return timeOfDay >= DAY_START_HOUR && timeOfDay < DAY_END_HOUR;
  }

  /**
   * 源元件在当前时刻是否「可供电」。
   * 恒电源取决于其 on 开关（默认开，可人为关断）；太阳能板仅在白天为真。
   * @param {object} el 元件对象
   * @returns {boolean}
   */
  function isSourceActive(el) {
    if (!el) return false;
    if (el.type === 'power') return el.state.on !== false;
    if (el.type === 'solar_panel') return isDay();
    return false;
  }

  /** 生成唯一元件 id。 */
  function nextElementId(type) {
    let id;
    do {
      id = `${type}_${idSeq++}`;
    } while (elements.has(id));
    return id;
  }

  /**
   * 新增元件。
   * @param {string} type 元件类型
   * @param {{ id?:string, x?:number, y?:number, props?:object }} [opts]
   * @returns {object|null} 新建的元件（类型非法时返回 null）
   */
  function addElement(type, opts = {}) {
    if (!TYPE_PORTS[type]) return null;
    const id = opts.id && !elements.has(opts.id) ? opts.id : nextElementId(type);
    const el = {
      id,
      type,
      x: Number.isFinite(opts.x) ? opts.x : 0,
      y: Number.isFinite(opts.y) ? opts.y : 0,
      props: Object.assign(defaultProps(type), opts.props || {}),
      state: defaultState(type),
    };
    elements.set(id, el);
    bumpRevision();
    logChange('el-add', id);
    return el;
  }

  /** 删除元件（同时删除其所有导线）。 */
  function removeElement(id) {
    if (!elements.has(id)) return false;
    elements.delete(id);
    const removedWires = [];
    for (const [wid, w] of [...wires]) {
      if (w.a.el === id || w.b.el === id) { wires.delete(wid); removedWires.push(wid); }
    }
    // 同步清理 powered 中的残留键
    for (const key of [...powered]) {
      if (key.startsWith(`${id}:`)) powered.delete(key);
    }
    bumpRevision();
    logChange('el-remove', id);
    for (const wid of removedWires) logChange('wire-remove', wid);
    return true;
  }

  /** 判断端口是否合法。 */
  function isValidPort(elId, port) {
    const el = elements.get(elId);
    if (!el) return false;
    return (TYPE_PORTS[el.type] || []).includes(port);
  }

  /**
   * 连接两个端口（允许同一端口接多根线）。
   * @returns {object|null} 新建的导线（端口非法时返回 null）
   */
  function addWire(aEl, aPort, bEl, bPort) {
    if (!isValidPort(aEl, aPort) || !isValidPort(bEl, bPort)) return null;
    if (aEl === bEl && aPort === bPort) return null;
    const id = `w${wireSeq++}`;
    const w = { id, a: { el: aEl, port: aPort }, b: { el: bEl, port: bPort } };
    wires.set(id, w);
    bumpRevision();
    logChange('wire-add', id);
    return w;
  }

  /** 删除导线。 */
  function removeWire(id) {
    const removed = wires.delete(id);
    if (removed) {
      bumpRevision();
      logChange('wire-remove', id);
    }
    return removed;
  }

  /** 查询节点（当前帧）是否通电。 */
  function getNodePowered(elId, port) {
    return powered.has(nodeKey(elId, port));
  }

  /** 设置元件坐标（拖动）。坐标实际变化才自增结构修订号（同值写回不触发重建）。 */
  function moveElement(id, x, y) {
    const el = elements.get(id);
    if (!el) return false;
    if (el.x !== x || el.y !== y) {
      bumpRevision();
      logChange('el-move', id);
    }
    el.x = x;
    el.y = y;
    return true;
  }

  /** 设置元件 props 的某个键。props 会体现在动态视图（如感应半径），自增动态修订号。 */
  function setProp(id, key, value) {
    const el = elements.get(id);
    if (!el) return false;
    el.props[key] = value;
    bumpDyn();
    return true;
  }

  /**
   * 设置发光元件（灯柱 lamp / 发光地板 glow_floor）的颜色（1.0.9）。
   * 颜色纯属外观：只改 props.color 并自增动态修订号（渲染层据此换图标母本），
   * 不触碰 state —— lit 只由通电决定，故不改仿真结果。
   * @param {string} id 元件 id
   * @param {string} colorKey 颜色 key（须为 LIGHT_COLOR_KEYS 之一）
   * @returns {boolean} 是否成功（元件不存在 / 类型不符 / key 非法 → false 且无任何副作用）
   */
  function setColor(id, colorKey) {
    const el = elements.get(id);
    if (!el) return false;
    if (el.type !== 'lamp' && el.type !== 'glow_floor') return false;
    if (!LIGHT_COLOR_KEYS.includes(colorKey)) return false;
    el.props.color = colorKey;
    bumpDyn(); // 渲染层要立刻换图标（颜色纳入图标缓存键）
    return true;
  }

  /** 设置墙壁开关状态（on = 接通）。 */
  function setWallSwitch(id, on) {
    const el = elements.get(id);
    if (!el || el.type !== 'wall_switch') return false;
    el.state.on = !!on;
    bumpDyn();
    return true;
  }

  /** 翻转墙壁开关。 */
  function toggleWallSwitch(id) {
    const el = elements.get(id);
    if (!el || el.type !== 'wall_switch') return false;
    el.state.on = !el.state.on;
    bumpDyn();
    return true;
  }

  /**
   * 设置恒电源的输出开关（on = 输出供电）。
   * @param {string} id 元件 id
   * @param {boolean} on 是否供电
   * @returns {boolean} 是否设置成功
   */
  function setPower(id, on) {
    const el = elements.get(id);
    if (!el || el.type !== 'power') return false;
    el.state.on = !!on;
    return true;
  }

  /** 翻转恒电源的输出开关。 */
  function togglePower(id) {
    const el = elements.get(id);
    if (!el || el.type !== 'power') return false;
    el.state.on = !el.state.on;
    return true;
  }

  /** 触发按钮开关：接通 1 秒后自动弹起。 */
  function triggerButton(id) {
    const el = elements.get(id);
    if (!el || el.type !== 'button') return false;
    el.state.pulse = Number(el.props.pulseSeconds) || DEFAULT_PULSE_SECONDS;
    el.state.conducting = true;
    return true;
  }

  /** 设置玩家令牌位置。位置变化同样自增结构修订号（渲染层需重摆令牌）。 */
  function setPlayerPos(id, x, y) {
    const el = elements.get(id);
    if (!el || el.type !== 'player') return false;
    if (el.x !== x || el.y !== y) {
      bumpRevision();
      logChange('el-move', id);
    }
    el.x = x;
    el.y = y;
    return true;
  }

  /** 手动即时元件的即时条件判定。 */
  function applyManual(el, dt) {
    const st = el.state;
    switch (el.type) {
      case 'wall_switch':
        st.conducting = !!st.on;
        break;
      case 'prox_switch': {
        const r = Number(el.props.radius) || DEFAULT_PROX_RADIUS;
        let inside = false;
        for (const p of elements.values()) {
          if (p.type !== 'player') continue;
          const dx = p.x - el.x;
          const dy = p.y - el.y;
          if (dx * dx + dy * dy <= r * r) {
            inside = true;
            break;
          }
        }
        st.conducting = inside;
        break;
      }
      case 'floor_switch': {
        let on = false;
        for (const p of elements.values()) {
          if (p.type !== 'player') continue;
          if (Math.abs(p.x - el.x) <= FLOOR_HALF && Math.abs(p.y - el.y) <= FLOOR_HALF) {
            on = true;
            break;
          }
        }
        st.conducting = on;
        break;
      }
      case 'button': {
        // 默认切断；触发后接通满 1 秒再弹起。
        // 注意：此处不做「同帧钳位」，让计时自然越过 0，保证恰好占满 60 个采样帧，
        // 从而能可靠地驱动「1 秒延迟」的自动开关 / 逆变器。
        if (st.pulse > 0) {
          st.conducting = true;
          st.pulse -= dt;
        } else {
          st.conducting = false;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 推进一帧仿真。
   * @param {number} dt 步长（秒），主循环固定使用 1/60
   */
  function tick(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    simTime += dt;

    // ---------- 步骤 0：推进昼夜时间 ----------
    // 一天 = DAY_LENGTH_SECONDS 真实秒 → 每小时占 DAY_LENGTH_SECONDS/24 秒。
    if (dayCycle) timeOfDay = (timeOfDay + (dt / DAY_LENGTH_SECONDS) * 24) % 24;

    // ---------- 步骤 1 + 2：采样控制端（用上一帧的通电集合）+ 推进定时器 ----------
    for (const el of elements.values()) {
      const type = el.type;
      if (DELAY_TYPES.includes(type)) {
        const ctrlPowered = powered.has(nodeKey(el.id, 'ctrl'));
        const target = type === 'auto_switch' ? ctrlPowered : !ctrlPowered;
        const st = el.state;
        if (target !== st.conducting) {
          if (st.timer === 0) bumpDyn(); // pending 计时开始（视图需显示进度条）
          st.timer += dt;
          // 阈值留半个步长的浮点余量：60 帧累计 ≈ 1.0s 可能因浮点误差略小于 1，
          // 用 dt/2 的容差可稳健判定「连续保持 1 秒」。
          if (st.timer >= DELAY_SECONDS - dt * 0.5) {
            st.conducting = target;
            st.timer = 0;
            bumpDyn(); // 延迟元件完成翻转
          }
        } else if (st.timer !== 0) {
          // 目标值又变回去 → 计时清零（pending 结束）
          st.timer = 0;
          bumpDyn();
        }
      } else if (MANUAL_TYPES.includes(type)) {
        const before = el.state.conducting;
        applyManual(el, dt);
        // 手动元件（墙壁开关 / 感应开关 / 地板开关 / 按钮）即时条件变化
        if (el.state.conducting !== before) bumpDyn();
      }
    }

    // ---------- 步骤 3：并查集求通电集合 ----------
    // keys 列表缓存（1.0.5 性能修复）：结构修订号不变时直接复用上帧列表，
    // 结构变化才重建。语义与逐帧重建完全一致。
    if (keysRevision !== revision) {
      keysCache.length = 0;
      for (const el of elements.values()) {
        const ports = TYPE_PORTS[el.type] || [];
        for (const p of ports) keysCache.push(nodeKey(el.id, p));
      }
      keysRevision = revision;
    }
    const keys = keysCache;
    // 并查集 parent Map 跨帧复用：clear 后重置所有键，避免每帧新建 Map。
    ufParent.clear();
    const uf = makeUnionFind(keys, ufParent);

    // 3a. 所有导线
    for (const w of wires.values()) {
      uf.union(nodeKey(w.a.el, w.a.port), nodeKey(w.b.el, w.b.port));
    }
    // 3b. 所有导通元件的 a-b 内部边
    for (const el of elements.values()) {
      if (SWITCH_TYPES.includes(el.type) && el.state.conducting) {
        uf.union(nodeKey(el.id, 'a'), nodeKey(el.id, 'b'));
      }
    }
    // 3c. 处于「可供电」状态的源元件 out 端口所在连通分量整体通电
    //     （太阳能板在夜间 isSourceActive 为假 → 其网络整段断电，切换无延迟）
    //     newPowered Set 跨帧复用：填入备用容器后与 powered 交换引用，零分配。
    const newPowered = poweredScratch;
    newPowered.clear();
    for (const el of elements.values()) {
      if (!SOURCE_TYPES.includes(el.type)) continue;
      if (!isSourceActive(el)) continue;
      const root = uf.find(nodeKey(el.id, 'out'));
      for (const k of keys) {
        if (uf.find(k) === root) newPowered.add(k);
      }
    }
    const prevPowered = powered;
    // 3d. 通电变化检测（1.0.6）：任一节点通电状态翻转 → 自增动态修订号。
    //     这里 O(keys) 的 Set.has 比对，换来渲染层稳态零开销的动态刷新门控。
    for (const k of keys) {
      if (newPowered.has(k) !== prevPowered.has(k)) { bumpDyn(); break; }
    }
    powered = newPowered;
    poweredScratch = prevPowered; // 下一帧复用（届时 clear）

    // ---------- 步骤 4：更新设备 ----------
    for (const el of elements.values()) {
      // 1.0.9：灯柱与发光地板同分支——按 in 端口通电设 lit，翻转时自增动态修订号
      if (el.type === 'lamp' || el.type === 'glow_floor') {
        const lit = powered.has(nodeKey(el.id, 'in'));
        if (el.state.lit !== lit) { el.state.lit = lit; bumpDyn(); }
      } else if (el.type === 'door') {
        const open = !powered.has(nodeKey(el.id, 'in'));
        if (el.state.open !== open) { el.state.open = open; bumpDyn(); }
      } else if (el.type === 'solar_panel') {
        const d = isDay();
        if (el.state.conducting !== d || el.state.supplying !== d) {
          el.state.conducting = d;
          el.state.supplying = d;
          bumpDyn();
        }
      }
    }
  }

  /** 返回元件视图（供渲染层使用，不暴露内部引用）。 */
  function getElementView(id) {
    const el = elements.get(id);
    if (!el) return null;
    const ports = {};
    for (const p of TYPE_PORTS[el.type] || []) {
      ports[p] = { powered: powered.has(nodeKey(el.id, p)) };
    }
    const view = {
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      props: Object.assign({}, el.props),
      state: Object.assign({}, el.state),
      conducting: !!el.state.conducting,
      lit: !!el.state.lit,
      open: !!el.state.open,
      supplying: !!el.state.supplying,
      isDay: isDay(),
      ports,
      timer: Number(el.state.timer) || 0,
      timerProgress: 0,
      pending: false,
      target: !!el.state.conducting,
    };
    if (DELAY_TYPES.includes(el.type)) {
      const ctrlPowered = powered.has(nodeKey(el.id, 'ctrl'));
      const target = el.type === 'auto_switch' ? ctrlPowered : !ctrlPowered;
      view.target = target;
      view.pending = target !== el.state.conducting;
      view.timerProgress = view.pending
        ? Math.min(1, (Number(el.state.timer) || 0) / DELAY_SECONDS)
        : 0;
    }
    return view;
  }

  /** 返回全部元件视图数组。 */
  function getElementViews() {
    const out = [];
    for (const el of elements.values()) out.push(getElementView(el.id));
    return out;
  }

  /** 返回元件原始对象的浅引用（仅供渲染层读取坐标 / 类型）。 */
  function getElements() {
    return [...elements.values()];
  }

  /** 返回全部导线。 */
  function getWires() {
    return [...wires.values()];
  }

  /** 当前仿真时间（秒）。 */
  function getSimTime() {
    return simTime;
  }

  /** 当前游戏内时刻（小时，0–24）。 */
  function getTimeOfDay() {
    return timeOfDay;
  }

  /**
   * 设置游戏内时刻，自动取模到 [0, 24)。
   * @param {number} h 小时
   * @returns {boolean} 是否设置成功
   */
  function setTimeOfDay(h) {
    const v = Number(h);
    if (!Number.isFinite(v)) return false;
    let t = v % 24;
    if (t < 0) t += 24;
    timeOfDay = t;
    return true;
  }

  /** 当前是否为白天。 */
  function getIsDay() {
    return isDay();
  }

  /** 是否开启昼夜自动流逝。 */
  function getDayCycle() {
    return dayCycle;
  }

  /** 设置昼夜自动流逝开关。 */
  function setDayCycle(b) {
    dayCycle = !!b;
    return true;
  }

  /**
   * 当前走线样式（'straight' 直线 | 'curve' 曲线）。
   * @returns {string}
   */
  function getWireStyle() {
    return wireStyle;
  }

  /**
   * 设置走线样式（仅接受 'straight' / 'curve'，其余值被拒绝）。
   * @param {string} s 走线样式
   * @returns {boolean} 是否设置成功
   */
  function setWireStyle(s) {
    if (s !== 'straight' && s !== 'curve') return false;
    if (wireStyle !== s) {
      wireStyle = s;
      bumpRevision();
      logChange('full', null); // 走线样式切换：全部导线几何重算，渲染层整表重建
    }
    return true;
  }

  /**
   * 当前是否隐藏线条（1.0.8 视图偏好）。
   * @returns {boolean}
   */
  function getWiresHidden() {
    return wiresHidden;
  }

  /**
   * 设置线条隐藏偏好（1.0.8）。仅存偏好，不自增修订号——渲染层通过 board 的
   * O(1) 类切换响应，不触发结构重建 / 动态刷新门控失效。
   * @param {boolean} b 是否隐藏线条
   * @returns {boolean} 是否设置成功
   */
  function setWiresHidden(b) {
    wiresHidden = b === true;
    return true;
  }

  /** 清空画布并复位。 */
  function reset() {
    elements.clear();
    wires.clear();
    powered = new Set();
    idSeq = 1;
    wireSeq = 1;
    simTime = 0;
    timeOfDay = 8;
    dayCycle = true;
    bumpRevision(); // 只增不减，跨 reset 单调
    bumpDyn(); // 动态状态全部复位，通知渲染层做一次全量动态刷新
    logChange('full', null); // 整表失效：渲染层全量重建
  }

  /** 序列化为普通对象。 */
  function serialize() {
    return {
      version: 1,
      simTime,
      timeOfDay,
      dayCycle,
      wireStyle,
      wiresHidden, // 1.0.8：线条隐藏偏好随序列化保存（旧 JSON 无此字段 → 默认显示）
      idSeq,
      wireSeq,
      elements: getElements().map((el) => ({
        id: el.id,
        type: el.type,
        x: el.x,
        y: el.y,
        props: Object.assign({}, el.props),
        state: Object.assign({}, el.state),
      })),
      wires: getWires().map((w) => ({
        id: w.id,
        a: Object.assign({}, w.a),
        b: Object.assign({}, w.b),
      })),
    };
  }

  /** 序列化为 JSON 字符串。 */
  function serializeJSON() {
    return JSON.stringify(serialize(), null, 2);
  }

  /** 反序列化（接受对象或 JSON 字符串）。 */
  function deserialize(data) {
    let obj = data;
    if (typeof data === 'string') {
      try {
        obj = JSON.parse(data);
      } catch (e) {
        return false;
      }
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.elements)) return false;
    reset();
    for (const raw of obj.elements) {
      if (!TYPE_PORTS[raw.type]) continue;
      const el = {
        id: raw.id,
        type: raw.type,
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        props: Object.assign(defaultProps(raw.type), raw.props || {}),
        state: Object.assign(defaultState(raw.type), raw.state || {}),
      };
      elements.set(el.id, el);
    }
    for (const raw of Array.isArray(obj.wires) ? obj.wires : []) {
      if (!raw || !raw.a || !raw.b) continue;
      if (!isValidPort(raw.a.el, raw.a.port) || !isValidPort(raw.b.el, raw.b.port)) continue;
      // id 只求值一次，保证 Map 键与 wire.id 完全一致（否则 removeWire 会失败）
      const wid = raw.id || `w${wireSeq++}`;
      wires.set(wid, {
        id: wid,
        a: { el: raw.a.el, port: raw.a.port },
        b: { el: raw.b.el, port: raw.b.port },
      });
    }
    idSeq = Number(obj.idSeq) || elements.size + 1;
    wireSeq = Number(obj.wireSeq) || wires.size + 1;
    simTime = Number(obj.simTime) || 0;
    // 昼夜状态：缺省 8:00 / 开启循环
    const t = Number(obj.timeOfDay);
    timeOfDay = Number.isFinite(t) ? ((t % 24) + 24) % 24 : 8;
    dayCycle = obj.dayCycle !== false;
    // 走线样式：仅接受合法值，缺省 / 旧 JSON 回退直线
    wireStyle = obj.wireStyle === 'curve' ? 'curve' : 'straight';
    // 线条隐藏：仅接受 true，缺省 / 旧 JSON 回退显示（1.0.8 向后兼容）
    wiresHidden = obj.wiresHidden === true;
    powered = new Set();
    bumpRevision();
    bumpDyn(); // 反序列化后动态状态全新，通知渲染层做一次全量动态刷新
    logChange('full', null); // 整表失效：渲染层全量重建
    return true;
  }

  return {
    // 数据操作
    addElement,
    removeElement,
    addWire,
    removeWire,
    moveElement,
    setProp,
    /** 设置发光元件颜色（1.0.9，纯外观，不改仿真）。 */
    setColor,
    setWallSwitch,
    toggleWallSwitch,
    triggerButton,
    setPower,
    togglePower,
    setPlayerPos,
    // 查询
    getNodePowered,
    /** 当前结构修订号（1.0.5）：渲染层做 O(1) 结构变更检测用。 */
    getRevision: () => revision,
    /** 当前动态状态修订号（1.0.6）：渲染层跳过无变化的逐帧动态刷新用。 */
    getDynRev: () => dynRev,
    /** 聚合自某结构修订号以来的结构变更（1.0.7 增量结构更新）。 */
    getChangesSince,
    getElementView,
    getElementViews,
    getElements,
    getWires,
    /** 导线是否存在（1.0.5：渲染层每帧自愈检查用，避免 getWires() 每帧建大数组）。 */
    hasWire: (id) => wires.has(id),
    getSimTime,
    getTimeOfDay,
    setTimeOfDay,
    getIsDay,
    getDayCycle,
    setDayCycle,
    getWireStyle,
    setWireStyle,
    /** 线条隐藏偏好（1.0.8 视图偏好，随序列化保存）。 */
    getWiresHidden,
    setWiresHidden,
    hasElement: (id) => elements.has(id),
    getElement: (id) => elements.get(id) || null,
    // 仿真
    tick,
    reset,
    // 持久化
    serialize,
    serializeJSON,
    deserialize,
  };
}

export default {
  createEngine, TYPE_PORTS, SOURCE_TYPES, FIXED_DT, MAX_STEPS, DELAY_SECONDS, nodeKey,
  DAY_LENGTH_SECONDS, DAY_START_HOUR, DAY_END_HOUR, LIGHT_COLOR_KEYS,
};

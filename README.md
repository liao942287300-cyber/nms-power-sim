# 无人深空电力模拟器 (NMS Power Simulator)

一个致敬《无人深空》(No Man's Sky) 电力系统的**电路搭建与仿真模拟器**。在画布上摆放电源、开关、逆变器、电灯等元器件，用直线或曲线线缆把它们连成电路，实时观察电流传播与灯光明灭——纯前端实现，零依赖，打开即用。

## ✨ 功能特性

- **11 种元器件**：太阳能板、能量逆变器、电力脉冲、按钮开关、自动开关、邻近开关、延迟门（缓冲级/反相级）、电灯等
- **实时电路仿真**：基于并查集的电流传播引擎，1 秒延迟语义忠实还原游戏内自动开关/逆变器的时序行为
- **两种走线模式**：直线（带跳线拱防歧义）与贝塞尔曲线，线缆置顶显示不被元件遮挡
- **框选批量移动**：左→右完全包含、右→左相交即选，刚体移动保持组内相对位置
- **撤销 / 重做**：快照式历史，最多 50 步（Ctrl+Z / Ctrl+Y）
- **实例库**：把搭建好的电路存入本地实例库，下次一键载入；偏好（走线样式、线条隐藏）随实例持久化
- **隐藏线条开关**：一键隐去所有线缆与交叉拱，专注查看元件布局
- **7 个内置实例**：日光供电、逆变器逻辑、延迟门、HELLO 滚动屏等，开箱即玩
- **大电路性能优化**：结构修订号 O(1) 比对、增量 DOM 更新、视口剔除、低缩放装饰削减、手势 rAF 合帧——数百元件/六百余导线的电路依然流畅

## 🚀 快速开始

### 方式一：直接使用（推荐）

从 [Releases](https://github.com/liao942287300-cyber/nms-power-sim/releases) 下载 `NMS-PowerSim-x.x.x-portable.exe`，双击即用。（GitHub 的 Release 资产名只接受 ASCII，故下载包用英文名；本地自行构建的产物名仍为 `无人深空电力模拟器-x.x.x-portable.exe`，二者内容一致。）便携版数据保存在 exe 旁边的 `NmsPowerSimData\` 目录，不污染系统，删掉 exe 即完全卸载。

### 方式二：源码运行（纯前端）

渲染端是零依赖的纯静态页面（HTML + CSS + ES Module），任意静态服务器即可：

```bash
cd nms-power-sim
python -m http.server 8900
# 浏览器打开 http://localhost:8900
```

或直接双击 `start.bat`（Windows）/ 运行 `start.sh`。

### 方式三：构建桌面便携版（Electron）

```bash
cd desktop-shell
npm install
npm run build:portable
# 产物：dist/无人深空电力模拟器-x.x.x-portable.exe
```

桌面壳基于 Electron 44，通过自定义 `app://local/` 协议加载渲染端，localStorage 数据重定向到 exe 旁目录。

## 🏗️ 目录结构

```
├── nms-power-sim/        # 渲染端源码（纯静态，零依赖）
│   ├── index.html
│   ├── css/styles.css    # 图层、主题、剔除/装饰削减样式
│   ├── js/
│   │   ├── engine.js     # 仿真内核：并查集传播、1 秒延迟、结构/动态修订号
│   │   ├── board.js      # 画布：SVG 渲染、增量更新、视口剔除、手势合帧
│   │   ├── app.js        # 应用层：工具栏、实例库、撤销重做、检查器
│   │   ├── catalog.js    # 元件目录定义
│   │   └── presets.js    # 7 个内置实例
│   ├── tests/            # 1000+ 断言的回归测试（详见下文）
│   └── assets/           # 游戏内元件参考图
├── desktop-shell/        # Electron 便携壳
│   ├── main.js           # 主进程：app:// 协议、数据目录重定向
│   ├── scripts/          # renderer 同步 / 便携校验 / 图标生成
│   └── build/icon.ico
└── examples/             # 可导入的大电路实例
    ├── hello-scroll-screen.json   # HELLO 滚动文字屏（82 元件 / 129 线）
    └── moj-scroll-screen.json     # MOJ 滚动大屏幕（376 元件 / 620 线）
```

## 🧪 测试

测试全部使用原生 Node + headless 浏览器（CDP 协议）编写，无第三方测试框架：

```bash
# 内核单元测试（192 断言）
node tests/engine.test.mjs

# 浏览器全链路冒烟（200 断言，需先起本地静态服务）
python -m http.server 8900 &
node tests/browser.smoke.mjs

# 性能回归（对比 tests/perf_scroll.baseline.json）
node tests/perf_scroll.mjs
```

`tests/` 内其余 `qa_*` / `qa2_*` / `qa_eng_*` 脚本为各版本交付时的专项回归（拖拽机制自证、滚动屏逐秒比对、便携 exe 验证等），可按需运行。

## 🎮 玩法示例：MOJ 滚动大屏幕

导入 `examples/moj-scroll-screen.json`，点 START，约 35 秒后一块 5 行 × 32 列的灯阵大屏进入稳定循环，"MOJ MOJ MOJ…" 以每秒 1 列的速度向右滚动（周期 18 秒）。电路结构：

- 每行灯配一条 32 格「移位链」，每格由自动开关延迟 1 秒，模拟内容逐列传递
- 下方「字库区」用自动开关摆出 M、O、J 字形，由 18 拍扫描环按流位置取字
- 全部 376 元件 / 620 导线可在 1.0.8 版上流畅拖拽与缩放

## 📜 开源协议

[MIT](LICENSE)

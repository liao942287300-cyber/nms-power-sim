# 无人深空 · 电力模拟器 —— Windows 桌面版（便携）

把《无人深空》电力逻辑元件的教学 + 仿真工具（原生 HTML + CSS + ES Module 静态站点）
封装为 **Windows 便携版 exe**：双击即用、独立窗口、无黑窗口、无浏览器、无需安装。

当前版本：**1.0.12**

## 直接使用

双击 `dist\无人深空电力模拟器-1.0.12-portable.exe` 即可（首次启动稍慢，属正常）。
1.0.11 修复「导出 JSON 弹出两个文件保存窗口」的问题：现在只弹一个原生保存框。
1.0.12 修正「简单密码门的应用」实例：按教程参考图重建为 3 个自动开关 + 3 个能量逆变器，并修正门的方向（密码「开-关-开-关」正确时门打开放行，其余组合门保持关闭锁住）。

- 全部数据（窗口尺寸/位置等）保存在 **exe 同目录的 `NmsPowerSimData\`** 下，
  exe 和该目录一起拷贝到别的机器仍可用，卸载直接删除这两个即可。
- 顶部菜单栏：文件 / 编辑 / 视图 / 帮助（默认自动隐藏，按 `Alt` 呼出）。
- 「导出 JSON」会弹出原生保存对话框，把当前电路保存到磁盘。

## 三个视图

| 视图 | 内容 |
| --- | --- |
| 元件图鉴 | 12 个电力元件（含 1.0.9 新增的「发光地板」）的原理、端口、用法 |
| 仿真实验室 | 元件库 + 电路画布 + 实时状态面板；可放置/连线/开关/导出导入 |
| 应用实例 | 7 个直接来自教程素材的电路，一键「载入实验室」上电运行 |

## 画布手势（1.0.9）

| 操作 | 效果 |
| --- | --- |
| 空白处拖拽（或鼠标中键拖拽） | 平移画布；空白处**单击** = 取消选择 |
| `Ctrl` + 拖拽 | 框选多个元件（左→右完全包含、右→左相交即选） |
| `滚轮` | 以鼠标为锚点缩放（0.25×–3×） |
| `空格` | 显示 / 隐藏全部线条 |
| `Alt` + 拖拽元件 | 复制一份并拖动副本（原元件留在原地，一次只复制一份）；`Alt` + 单击不触发开关动作 |
| `Ctrl` + `Z` / `Ctrl` + `Y` | 撤销 / 重做（含改色、复制，逐步可撤销） |

灯柱与发光地板的发光颜色可在属性面板切换绿 / 粉 / 黄 / 蓝 / 紫 / 白 / 红，多选时可批量改色。
1.0.10 起亮 / 灭在形态上即不同：点亮 = 三层同色泛光 + 白色高光芯，熄灭 = 中性深灰本体 + 一圈同色细色环，密集灯阵下也能一眼分辨。

## 开发者：如何构建

```bat
npm run sync            :: 把 ../nms-power-sim 同步到 renderer/（自动排除 tests/）
npm run icon            :: 生成 build/icon.ico（纯 Python，无需 Pillow）
npm run dev             :: 本地以开发模式启动 Electron（渲染层直接指向 ../nms-power-sim）
npm run build:portable  :: 打便携版 exe，产物在 dist/
```

无生产依赖；`electron` / `electron-builder` 均为 devDependencies。

## 技术要点

源应用使用 `import` / `export`，必须运行在 http(s) 或自定义协议下（`file://` 会被
同源策略拦截）。因此桌面壳没有使用 `loadFile()`，而是：

1. `app.whenReady` **之前** `protocol.registerSchemesAsPrivileged` 注册特权协议 `app`；
2. `whenReady` 中 `protocol.handle('app', ...)` 把 `app://local/*` 映射到渲染层目录，
   带路径穿越校验、MIME 映射、ENOENT → 404；
3. 窗口 `loadURL('app://local/index.html')`。

安全配置固定为 `nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` /
`webSecurity:true`，preload 仅暴露只读的 `window.nmsPowerSimDesktop`。

## 自动化验证

```bat
node scripts\verify-cdp.mjs --mode dev --user-data .\.verify-data
node scripts\verify-portable.mjs "dist\无人深空电力模拟器-1.0.12-portable.exe"
```

- `verify-cdp.mjs` 通过 CDP 真机断言：URL 协议、标题、三个页签、图鉴 **12** 卡、
  实例 **7** 卡且 7 张参考图 `naturalWidth > 0`、载入流水灯预设播放 12 秒灯态 ≥ 3 种组合、
  控制台错误/未捕获异常/失败请求均为 0。
- `verify-portable.mjs` 断言便携版进程存活、且 `NmsPowerSimData\` 落在 exe 同目录。

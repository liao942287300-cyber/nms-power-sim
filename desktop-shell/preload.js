const { contextBridge } = require('electron');

// 只暴露只读的环境标识，供渲染层判断当前是否运行在桌面客户端内。
// 不暴露任何可执行主进程能力的 IPC，保持最小攻击面。
contextBridge.exposeInMainWorld('nmsPowerSimDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    app: '1.0.0',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
});

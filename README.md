# 灵动笔记 · Better Notebook

适用于 Windows 的本地自由画布笔记本。支持可移动富文本卡片、截图裁剪、图片粘贴、缩放与旋转，以及 JSON 文件保存。

## 运行

需要 Windows PowerShell 5.1 和 Microsoft Edge 或 Google Chrome。日常使用不需要 Node.js，也不需要安装依赖。

运行根目录的 `launcher.ps1`，或继续使用原来的桌面快捷方式：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "完整路径\launcher.ps1"
```

应用默认访问 `http://127.0.0.1:8712/notebook.html`。不要通过双击 HTML 文件运行；拆分后的 JavaScript 模块需要通过本地服务加载。

## 数据与 Git

- `notes.json`：默认笔记，仍保存在项目根目录，兼容原有数据。
- `profile/`：应用独立的浏览器配置，包含自定义文件句柄等本机状态。
- 自定义文件：通过“打开”或“另存为”选择，位置由用户决定。
- `notes.json`、`profile/`、`backups/` 和根目录导出的笔记备份均已加入 `.gitignore`。
- Git 仓库只保存程序源码，**不能代替个人笔记备份**。备份时使用“导出”，或在退出应用后复制笔记文件。

## 项目结构

```text
better-notebook/
├── notebook.html                # 页面结构
├── icon.ico                     # 保留原快捷方式图标路径
├── launcher.ps1                 # 兼容原桌面快捷方式的入口
├── server.ps1                   # 兼容原服务启动方式的入口
├── src/
│   ├── js/
│   │   ├── app.js              # 画布、富文本、历史、文件操作与应用事件
│   │   ├── editor-sync.js      # 编辑内容与数据模型同步
│   │   └── history.js          # 文档操作历史
│   └── styles/notebook.css      # 界面样式
├── scripts/
│   ├── launcher.ps1             # 浏览器与本地服务启动
│   └── server.ps1               # 本地 HTTP 服务和默认文件读写
├── tests/                       # 保存回归测试、服务集成测试
├── docs/                        # 使用和维护说明
└── .github/workflows/test.yml   # Windows 持续集成
```

## 开发与验证

开发测试需要 Node.js 22 或更高版本，无第三方 npm 依赖：

```powershell
npm run check
npm test
```

服务集成测试在 Windows 上启动真实 PowerShell 服务，使用随机空闲端口和独立临时数据目录，不会读取或覆盖个人笔记。其他平台会跳过该项服务测试。

需要手动启动独立测试服务时：

```powershell
New-Item -ItemType Directory -Force .\test-results\notes
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server.ps1 -Port 18712 -DataDirectory .\test-results\notes
```

浏览器访问 `http://127.0.0.1:18712/notebook.html`。测试结束后关闭该服务进程。

## 维护文档

- [使用说明](docs/usage.md)
- [维护说明与后续事项](docs/maintenance.md)
- [变更记录](CHANGELOG.md)

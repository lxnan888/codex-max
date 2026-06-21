# Codex Max

Codex Max 是一个 Windows 本地版 VS Code Codex 插件控制器。它提供本地 WebUI 和 WPF 启动器，只通过 Chromium CDP 控制 VS Code 里的 Codex 插件，并从 Codex WebView GUI 实时读取会话列表、消息、回复状态、模型和推理强度。

本项目现在只服务 VS Code 中的 Codex 插件，不再支持 Codex App、Codex Desktop、macOS、系统级 GUI 自动化、远程中转或授权验证。

## 当前定位

- 只适配 Windows + VS Code Codex 插件。
- 只使用 CDP，默认端口 `9339`。
- 服务默认监听 `127.0.0.1:8787`。
- 不包含局域网入口、远程访问、授权校验、中转服务或其他桌面端兼容代码。
- 不读取本地或远端会话文件；本地目录和 SSH 工作区都以当前 VS Code Codex GUI 为准。
- 支持 WebUI 切换 VS Code Codex 会话、发送文本/附件、新建会话、停止回复、切换模型和推理强度。
- WebUI 后台同步只读取当前可见 GUI，不会自动刷新任务列表或把 VS Code 拉回列表页。

## 使用

源码运行：

```powershell
npm start
```

打开：

```text
http://127.0.0.1:8787/
```

启动器会读取 VS Code 最近的本地目录和 `vscode-remote://ssh-remote+...` 工作区。选择工作区后点击“启动 VSCode”，服务会启动或复用带 CDP 的 VS Code：

```text
Code.exe --remote-debugging-port=9339 --remote-allow-origins=http://127.0.0.1:9339
```

如果检测到 VS Code 已经在运行但没有 CDP 端口，服务不会自动关闭 VS Code，会返回明确提示。请手动关闭 VS Code 后再由启动器拉起受控 VS Code。

## Windows 启动器

启动器位于 `windows/CodexMini`，职责：

- 启动、停止、重启本地 Node 服务。
- 显示服务状态、端口、GUI 同步状态和日志入口。
- 打开/复制 `http://127.0.0.1:8787/`。
- 选择本地目录或 SSH 工作区，并调用 `/codex/cdp-launch` 检查或拉起受控 VS Code。
- 关闭启动器或点击关闭时只停止本地服务，不主动结束 VS Code 工作窗口。

构建单文件 exe：

```powershell
.\scripts\build-codex-max-windows-single-exe.ps1
```

输出位于 `dist\windows\Codex Max SingleExe\Codex Max.exe`。

## API

- `GET /codex/health`
- `GET /codex/config`
- `POST /codex/cdp-launch`
- `POST /send`
- `GET /codex/threads`
- `GET /codex/history`
- `GET /codex/status`
- `POST /codex/select`
- `POST /codex/new-thread`
- `POST /codex/model-switch`
- `POST /codex/reasoning-mode`
- `POST /codex/stop`

所有 API 都是本地直连，无访问校验。

## 不支持

- Codex App / Codex Desktop 控制。
- macOS 平台。
- 系统级鼠标键盘 GUI 回退。
- token、卡密、Pro、relay 或远程访问入口。
- 基于 `~/.codex/sessions` 的历史读取。

## 检查

```powershell
npm run check
node --check src\platform\win32.js
dotnet build windows\CodexMini\CodexMiniWin.csproj
```

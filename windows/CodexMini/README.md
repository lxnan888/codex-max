# Codex Max Windows 启动器

这个目录包含 Windows WPF 启动器。启动器只管理本地 VS Code Codex 插件控制服务：

- 准备本地服务 payload
- 启动、停止、重启 Node 服务
- 显示 CDP 状态、端口、会话数量和日志入口
- 打开或复制 `http://127.0.0.1:8787/`
- 选择最近本地目录或 SSH 工作区
- 拉起 `--remote-debugging-port=9339` 的受控 VS Code

它不负责 Codex App/Codex Desktop、macOS、卡密验证、远程访问或系统级 GUI 回退。

构建单文件 exe：

```powershell
.\scripts\build-codex-max-windows-single-exe.ps1
```

# Changelog

## Unreleased

- 重构为 Windows + VS Code Codex 插件本地版，只支持 VS Code 中的 Codex 插件。
- 删除 Codex App/Codex Desktop、macOS、系统级 GUI 回退、远程访问、授权校验、中转服务和多线路入口代码。
- WebUI 和 Windows WPF 启动器保留，入口固定为 `http://127.0.0.1:8787/`。
- 启动器增加本地目录/SSH 工作区下拉，点击“启动 VSCode”后才启动服务并拉起受控 VS Code。
- 历史、消息和状态改为从 VS Code Codex WebView GUI 实时读取，不再读取本地或远端会话文件。
- 修复 WebUI 后台轮询触发任务列表点击导致 VS Code 会话跳来跳去的问题。
- 修复会话 id 使用相对时间导致不稳定的问题，改为基于会话标题生成稳定 key。
- 修复发送时误点 composer 周边按钮、输入框残留 `/` 或旧内容混入的问题。
- 发送后改为短轮询确认提交状态，避免 VS Code 已发送但接口误报失败。

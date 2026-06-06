# Codex Max App

This folder contains the Windows client wrapper for the local Codex Max service.
It mirrors the macOS app responsibilities:

- prepare the local service payload
- generate and persist the mobile token
- start, stop, and restart the local Node service
- show HTTP health, port, thread count, latest thread title, and logs
- open the local web UI and copy the LAN entry URL

Build from the repository root on a machine with the .NET 8 SDK:

```powershell
.\scripts\build-codex-max-windows.ps1
```

The app can use `node.exe` from `PATH`. The build script copies the current
`node.exe` into the output when it can find one, or you can pass `-NodePath`.
A packaged build can also place a bundled runtime at:

```text
Resources\node\node.exe
```

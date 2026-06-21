'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

function makeError(message, code = 'VSCODE_CDP_ERROR', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runPowerShellText(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(makeError('执行 PowerShell 超时。', 'POWERSHELL_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(makeError((stderr || stdout || `PowerShell exited with ${code}`).trim(), 'POWERSHELL_FAILED'));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function runPowerShellJson(script, timeoutMs = 15000) {
  return runPowerShellText(script, timeoutMs).then(text => {
    try {
      return text ? JSON.parse(text) : null;
    } catch (error) {
      throw makeError(`PowerShell 返回的 JSON 无法解析：${error.message}`, 'POWERSHELL_BAD_JSON');
    }
  });
}

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(makeError(`CDP HTTP ${res.statusCode}: ${body.slice(0, 300)}`, 'CDP_HTTP_FAILED'));
          return;
        }
        try {
          resolve(JSON.parse(body || 'null'));
        } catch (error) {
          reject(makeError(`CDP 返回的 JSON 无法解析：${error.message}`, 'CDP_BAD_JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(makeError('连接 VSCode CDP 超时。', 'VSCODE_CDP_TIMEOUT')));
    req.on('error', reject);
  });
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw makeError('CDP WebSocket 帧过大。', 'CDP_WS_FRAME_TOO_LARGE');
      length = Number(big);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (buffer.length - offset < total) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + total);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    if (opcode === 0x1) frames.push(payload.toString('utf8'));
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class RawCdpSocket {
  constructor(webSocketUrl, timeoutMs = 4500) {
    this.url = new URL(webSocketUrl);
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const port = Number(this.url.port || 80);
      const host = this.url.hostname;
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(makeError('连接 CDP WebSocket 超时。', 'CDP_WS_TIMEOUT'));
      }, this.timeoutMs);
      socket.on('connect', () => {
        const request = [
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n');
        socket.write(request);
      });
      socket.on('data', chunk => {
        if (!this.handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const index = this.buffer.indexOf('\r\n\r\n');
          if (index < 0) return;
          const header = this.buffer.subarray(0, index).toString('utf8');
          const rest = this.buffer.subarray(index + 4);
          this.buffer = Buffer.alloc(0);
          if (!/^HTTP\/1\.1 101/i.test(header)) {
            clearTimeout(timer);
            socket.destroy();
            reject(makeError(`CDP WebSocket 握手失败：${header.split('\r\n')[0]}`, 'CDP_WS_HANDSHAKE_FAILED'));
            return;
          }
          this.handshakeDone = true;
          clearTimeout(timer);
          if (rest.length) this._handleFrames(rest);
          resolve(this);
          return;
        }
        this._handleFrames(chunk);
      });
      socket.on('error', error => {
        clearTimeout(timer);
        if (!this.handshakeDone) reject(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      });
      socket.on('close', () => {
        const error = makeError('CDP WebSocket 已关闭。', 'CDP_WS_CLOSED');
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      });
    });
  }

  _handleFrames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeWsFrames(this.buffer);
    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      let message;
      try { message = JSON.parse(frame); } catch { continue; }
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(makeError(message.error.message || 'CDP command failed.', message.error.code || 'CDP_COMMAND_FAILED'));
      } else {
        pending.resolve(message.result || {});
      }
    }
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(makeError('CDP WebSocket 未连接。', 'CDP_WS_NOT_CONNECTED'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError(`${method} 超时。`, 'CDP_COMMAND_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeWsFrame(payload));
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

function normalizeWorkspace(workspace = {}) {
  const kind = String(workspace.kind || workspace.type || '').trim().toLowerCase();
  const value = String(workspace.value || workspace.uri || workspace.path || '').trim();
  if (!value) return { kind: '', value: '', remoteAuthority: '', remoteAuthorityEncoded: '' };
  if (kind === 'remote' || value.startsWith('vscode-remote://')) {
    const authority = (value.match(/^vscode-remote:\/\/([^/]+)/i) || [])[1] || '';
    let decoded = authority;
    try { decoded = decodeURIComponent(authority); } catch {}
    return { kind: 'remote', value, remoteAuthority: decoded, remoteAuthorityEncoded: authority };
  }
  return { kind: 'local', value, remoteAuthority: '', remoteAuthorityEncoded: '' };
}

function createVscodeCdpController(options = {}) {
  const port = Number(process.env.CODEX_MAX_VSCODE_CDP_PORT || options.port || 9339);
  const host = process.env.CODEX_MAX_VSCODE_CDP_HOST || '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;
  const timeoutMs = Number(process.env.CODEX_MAX_CDP_TIMEOUT_MS || 4500);
  const editorSelector = '.ProseMirror[data-codex-composer][contenteditable="true"], [data-codex-composer].ProseMirror[contenteditable="true"], [data-codex-composer] .ProseMirror[contenteditable="true"]';
  const composerSelector = `${editorSelector}, [data-codex-composer]`;
  const editorSelectorJson = JSON.stringify(editorSelector);
  const composerSelectorJson = JSON.stringify(composerSelector);
  let preferredWorkspace = normalizeWorkspace({});
  let currentThreadId = '';
  let currentThreadTitle = '';

  async function listTargets() {
    const targets = await httpJson(`${baseUrl}/json/list`, Math.min(timeoutMs, 2500));
    return Array.isArray(targets) ? targets : [];
  }

  function targetScore(target) {
    const haystack = `${target.type || ''}\n${target.title || ''}\n${target.url || ''}`;
    if (!/openai\.chatgpt|extensionId=openai\.chatgpt/i.test(haystack)) return -1;
    let score = 10;
    if (String(target.type || '').toLowerCase() === 'iframe') score += 8;
    if (preferredWorkspace.remoteAuthority) {
      if (haystack.includes(preferredWorkspace.remoteAuthorityEncoded) || haystack.includes(encodeURIComponent(preferredWorkspace.remoteAuthority))) score += 100;
      if (haystack.includes(preferredWorkspace.remoteAuthority)) score += 80;
    }
    if (/purpose=webviewView/i.test(haystack)) score += 5;
    return score;
  }

  async function getTarget() {
    const rows = await listTargets();
    const candidates = rows
      .filter(item => item.webSocketDebuggerUrl)
      .map(item => ({ item, score: targetScore(item) }))
      .filter(row => row.score >= 0)
      .sort((a, b) => b.score - a.score);
    const target = candidates[0]?.item;
    if (!target || !target.webSocketDebuggerUrl) {
      throw makeError('VSCode CDP 已连接，但没有找到 Codex 插件 WebView。请先打开 VSCode 侧边栏里的 Codex 面板。', 'VSCODE_CODEX_TARGET_MISSING', 503);
    }
    return target;
  }

  async function startOrOpenVscode(workspace = {}) {
    const selected = normalizeWorkspace(workspace);
    if (selected.value) preferredWorkspace = selected;
    const ps = `
$ErrorActionPreference = 'Stop'
$port = ${port}
$workspaceKind = ${JSON.stringify(selected.kind)}
$workspaceValue = ${JSON.stringify(selected.value)}
function Get-CodeProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('Code.exe', 'Code - Insiders.exe') })
}
function Resolve-CodeExe {
  $process = Get-CodeProcesses | Where-Object { $_.ExecutablePath } | Select-Object -First 1
  if ($process -and (Test-Path -LiteralPath $process.ExecutablePath)) { return $process.ExecutablePath }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code\\Code.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\\Code.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw '没有找到 VSCode Code.exe。请先安装或启动一次 VSCode。'
}
$existing = @(Get-CodeProcesses)
$hasDebugArg = $false
foreach ($proc in $existing) {
  if (($proc.CommandLine -match '--remote-debugging-port=' + $port) -or ($proc.CommandLine -match '--remote-debugging-port\\s+' + $port)) {
    $hasDebugArg = $true
  }
}
if ($existing.Count -gt 0 -and -not $hasDebugArg) {
  [PSCustomObject]@{
    ok = $false
    needsRestart = $true
    message = 'VSCode 已在运行，但没有开启 CDP 调试端口。为避免关闭你的工作窗口，请手动关闭 VSCode 后，再从启动器点击“启动 VSCode”。'
    existingProcessIds = @($existing | ForEach-Object { $_.ProcessId })
    command = 'Code.exe --remote-debugging-port=' + $port + ' --remote-allow-origins=http://127.0.0.1:' + $port
  } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
$exe = Resolve-CodeExe
$argsList = @('--remote-debugging-port=' + $port, '--remote-allow-origins=http://127.0.0.1:' + $port)
if ($workspaceValue) {
  if ($workspaceKind -eq 'remote') {
    $argsList += '--folder-uri'
    $argsList += $workspaceValue
  } else {
    $argsList += $workspaceValue
  }
}
$started = Start-Process -FilePath $exe -ArgumentList $argsList -PassThru
[PSCustomObject]@{
  ok = $true
  reused = $hasDebugArg
  processId = $started.Id
  processIds = @($existing | ForEach-Object { $_.ProcessId })
  arguments = $argsList
  workspaceKind = $workspaceKind
  workspaceValue = $workspaceValue
} | ConvertTo-Json -Depth 5 -Compress
`;
    const launch = await runPowerShellJson(ps, 15000);
    if (!launch || launch.ok === false) {
      const error = makeError(launch?.message || '没有启动 VSCode CDP 受控版本。', launch?.needsRestart ? 'VSCODE_RESTART_REQUIRED' : 'VSCODE_CDP_LAUNCH_FAILED', 503);
      error.launch = launch;
      throw error;
    }
    return launch;
  }

  async function withPage(fn) {
    const target = await getTarget();
    const socket = await new RawCdpSocket(target.webSocketDebuggerUrl, timeoutMs).connect();
    try {
      return await fn(socket, target);
    } finally {
      socket.close();
    }
  }

  async function evaluateOnSocket(socket, expression, optionsOrTimeout = timeoutMs) {
    const opts = typeof optionsOrTimeout === 'object' && optionsOrTimeout ? optionsOrTimeout : { timeout: optionsOrTimeout };
    const params = { expression, awaitPromise: true, returnByValue: true };
    if (opts.contextId) params.contextId = opts.contextId;
    const result = await socket.send('Runtime.evaluate', params, opts.timeout || timeoutMs);
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'VSCode CDP JavaScript 执行失败。';
      throw makeError(message, 'VSCODE_CDP_EVALUATE_FAILED');
    }
    return result.result ? result.result.value : undefined;
  }

  async function waitForCodexContext(socket) {
    await socket.send('Page.enable', {}, timeoutMs).catch(() => {});
    await socket.send('Runtime.enable', {}, timeoutMs).catch(() => {});
    const tree = await socket.send('Page.getFrameTree', {}, timeoutMs);
    const frames = [];
    const walk = node => {
      if (!node) return;
      if (node.frame) frames.push(node.frame);
      for (const child of node.childFrames || []) walk(child);
    };
    walk(tree.frameTree);
    const ordered = [
      ...frames.filter(frame => frame.name === 'active-frame'),
      ...frames.filter(frame => /openai\.chatgpt|vscode-webview|codex/i.test(String(frame.url || frame.name || ''))),
      ...frames,
    ];
    const seen = new Set();
    for (const frame of ordered) {
      if (!frame.id || seen.has(frame.id)) continue;
      seen.add(frame.id);
      const world = await socket.send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'codex-max-vscode',
        grantUniveralAccess: true,
      }, timeoutMs).catch(() => null);
      const contextId = world && world.executionContextId;
      if (!contextId) continue;
      const result = await evaluateOnSocket(socket, `(() => {
        const composer = document.querySelector(${composerSelectorJson});
        return {
          ok: Boolean(composer),
          href: location.href,
          title: document.title,
          text: String(document.body && document.body.innerText || '').slice(0, 300)
        };
      })()`, { contextId, timeout: Math.min(timeoutMs, 2600) }).catch(() => null);
      if (result && result.ok) return { id: contextId, frameId: frame.id, url: frame.url || '', title: result.title || '', href: result.href || '' };
    }
    throw makeError('没有在 VSCode WebView 中找到 Codex 输入框。请先打开 VSCode 侧边栏里的 Codex 插件面板。', 'VSCODE_CODEX_FRAME_MISSING', 503);
  }

  async function ensureCodexReady(waitMs = 12000) {
    const startedAt = Date.now();
    let lastError = null;
    try {
      return await withPage(socket => waitForCodexContext(socket));
    } catch (error) {
      lastError = error;
    }
    while (Date.now() - startedAt <= waitMs) {
      await delay(500);
      try {
        return await withPage(socket => waitForCodexContext(socket));
      } catch (error) {
        lastError = error;
      }
    }
    throw makeError(lastError?.message || 'VSCode Codex 面板没有在限定时间内就绪。', lastError?.code || 'VSCODE_CODEX_FRAME_MISSING', lastError?.status || 503);
  }

  async function withCodexFrame(fn) {
    try {
      return await withPage(async socket => {
        const context = await waitForCodexContext(socket);
        return fn(socket, context);
      });
    } catch (error) {
      if (!['VSCODE_CODEX_FRAME_MISSING', 'VSCODE_CODEX_TARGET_MISSING'].includes(error.code)) throw error;
      await ensureCodexReady();
      return withPage(async socket => {
        const context = await waitForCodexContext(socket);
        return fn(socket, context);
      });
    }
  }

  async function evaluate(expression, timeout = timeoutMs) {
    return withCodexFrame((socket, context) => evaluateOnSocket(socket, expression, { contextId: context.id, timeout }));
  }

  const guiHelpers = `
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return Boolean(rect && rect.width >= 5 && rect.height >= 5 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
    };
    const hashText = value => {
      let hash = 2166136261;
      const text = String(value || '');
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    const threadRows = () => [...document.querySelectorAll('[role="button"]')]
      .filter(el => visible(el))
      .filter(el => el.querySelector('[data-thread-title-trigger="true"]'))
      .filter(el => !el.closest('[data-thread-find-target="conversation"]'));
    const rawThreadInfoFromRow = (el, index) => {
      const titleEl = el.querySelector('[data-thread-title-trigger="true"]');
      const title = normalize(titleEl ? titleEl.innerText || titleEl.textContent : el.innerText || el.textContent).replace(/\\s+\\d+\\s*(秒|分钟|小时|天|周|月|年|sec|min|hour|day|week|month|year)s?$/i, '').trim();
      const full = normalize(el.innerText || el.textContent);
      const updatedAtText = (full.match(/(刚刚|\\d+\\s*(秒|分钟|小时|天|周|月|年)|Yesterday|Today|\\d+\\s*(sec|min|hour|day|week|month|year)s?)/i) || [])[0] || '';
      const stableTitle = title || full || '未命名会话';
      const hash = hashText(stableTitle);
      const rect = el.getBoundingClientRect();
      return {
        id: '',
        title: stableTitle,
        name: stableTitle,
        updatedAtText,
        projectName: 'VSCode Codex',
        scope: 'gui',
        source: 'vscode-gui',
        index,
        active: el.getAttribute('aria-current') === 'true' || /active|selected|current/i.test(el.className || ''),
        top: Math.round(rect.top),
        fingerprint: hash,
      };
    };
    const threadEntries = () => {
      const rows = threadRows();
      const raw = rows.map((el, index) => ({ el, info: rawThreadInfoFromRow(el, index) }));
      const totals = new Map();
      for (const item of raw) totals.set(item.info.fingerprint, (totals.get(item.info.fingerprint) || 0) + 1);
      const seen = new Map();
      return raw.map(item => {
        const fingerprint = item.info.fingerprint;
        const duplicateIndex = seen.get(fingerprint) || 0;
        seen.set(fingerprint, duplicateIndex + 1);
        const duplicateSuffix = (totals.get(fingerprint) || 0) > 1 ? ':dup' + duplicateIndex : '';
        return {
          el: item.el,
          info: {
            ...item.info,
            id: 'gui:title:' + fingerprint + duplicateSuffix,
            duplicateIndex,
          }
        };
      });
    };
    const collectThreads = () => threadEntries().map(item => item.info);
    const clickSeeAll = async () => {
      const more = [...document.querySelectorAll('button,[role="button"],div')]
        .filter(visible)
        .find(el => /查看全部|View all|Show all/i.test(normalize(el.innerText || el.textContent)));
      if (!more) return false;
      more.click();
      await new Promise(resolve => setTimeout(resolve, 350));
      return true;
    };
    const ensureTaskList = async () => {
      if (collectThreads().length) {
        await clickSeeAll();
        return true;
      }
      const back = [...document.querySelectorAll('button')]
        .filter(visible)
        .find(el => /返回|Back/i.test(normalize([el.getAttribute('aria-label'), el.title, el.innerText, el.textContent].join(' '))));
      if (back) {
        back.click();
        const started = Date.now();
        while (Date.now() - started < 5000) {
          await new Promise(resolve => setTimeout(resolve, 180));
          if (collectThreads().length) {
            await clickSeeAll();
            return true;
          }
        }
      }
      return collectThreads().length > 0;
    };
    const currentTitle = () => {
      const candidates = [...document.querySelectorAll('button')]
        .filter(visible)
        .map(el => normalize(el.innerText || el.textContent))
        .filter(text => text && !/没有正在进行|最近任务|新聊天|完全访问|IDE 上下文|本地模式/i.test(text));
      return candidates[0] || '';
    };
    const cleanMessageText = value => normalize(value)
      .replace(/\\s*(星期[一二三四五六日天]|周[一二三四五六日天])?\\d{1,2}:\\d{2}\\s*$/u, '')
      .replace(/\\s*已处理\\s*\\d+\\s*(秒|分钟|小时|s|m|h)\\s*$/i, '')
      .trim();
    const collectMessages = () => {
      const units = [...document.querySelectorAll('[data-content-search-unit-key]')];
      const seen = new Set();
      const rows = [];
      for (const el of units) {
        const key = el.getAttribute('data-content-search-unit-key') || '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const role = /:user$/i.test(key) ? 'user' : /:assistant$/i.test(key) ? 'assistant' : '';
        if (!role) continue;
        let text = '';
        if (role === 'user') {
          const bubble = el.querySelector('[data-user-message-bubble]') || el;
          text = cleanMessageText(bubble.innerText || bubble.textContent || '');
        } else {
          const markdown = el.querySelector('[data-selected-text-overlay-target], [class*="_markdownContent"], .markdown') || el;
          text = cleanMessageText(markdown.innerText || markdown.textContent || '');
        }
        if (!text) continue;
        rows.push({ role, text, key, label: role === 'user' ? '你' : 'Codex' });
      }
      return rows;
    };
    const toolbarState = () => {
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      const triggerText = normalize(trigger ? trigger.innerText || trigger.textContent : '');
      const parts = triggerText.split(' ').filter(Boolean);
      const effort = trigger ? String(trigger.getAttribute('data-selected-reasoning-effort') || '') : '';
      const effortLabels = { low: '低', medium: '中', high: '高', xhigh: '超高' };
      return {
        model: parts[0] ? { id: parts[0], key: parts[0], label: parts[0], displayName: parts[0], source: 'gui' } : null,
        reasoningMode: effort ? { key: effort, value: effort, label: effortLabels[effort] || effort, displayName: effortLabels[effort] || effort, source: 'gui' } : null,
        triggerText,
      };
    };
    const runningState = () => {
      const bodyText = normalize(document.body && document.body.innerText || '');
      const buttons = [...document.querySelectorAll('button')].filter(visible).map(button => normalize([button.getAttribute('aria-label'), button.title, button.innerText, button.textContent].join(' ')));
      const hasStop = buttons.some(label => /停止|中止|终止|取消|Stop|Cancel|Interrupt|Abort/i.test(label));
      const saysRunning = /正在进行|运行中|Working|Running/i.test(bodyText) && !/没有正在进行/i.test(bodyText);
      return hasStop || saysRunning;
    };
    const viewState = () => {
      const messages = collectMessages();
      const threads = collectThreads();
      const view = messages.length ? 'conversation' : threads.length ? 'thread-list' : 'unknown';
      return {
        view,
        messages,
        threads,
        title: view === 'conversation' ? currentTitle() : '',
      };
    };
  `;

  async function probe() {
    try {
      const version = await httpJson(`${baseUrl}/json/version`, Math.min(timeoutMs, 1800));
      const target = await getTarget();
      const frame = await evaluate(`(() => ({
        hasComposer: Boolean(document.querySelector(${composerSelectorJson})),
        title: document.title,
        href: location.href,
        text: String(document.body && document.body.innerText || '').slice(0, 500)
      }))()`, Math.min(timeoutMs, 2600)).catch(error => ({
        hasComposer: false,
        code: error.code || 'VSCODE_CODEX_FRAME_MISSING',
        message: error.message || 'VSCode 已开启 CDP，但 Codex 插件面板没有可用输入框。',
      }));
      return {
        available: Boolean(frame && frame.hasComposer),
        cdpAvailable: true,
        codexReady: Boolean(frame && frame.hasComposer),
        port,
        browser: version.Browser || '',
        targetTitle: target.title || '',
        targetUrl: target.url || '',
        webviewTitle: frame.title || '',
        webviewUrl: frame.href || '',
        preferredWorkspace,
        code: frame.hasComposer ? '' : (frame.code || 'VSCODE_CODEX_FRAME_MISSING'),
        message: frame.hasComposer ? 'VSCode Codex 已就绪。' : (frame.message || '请打开 VSCode 侧边栏里的 Codex 插件面板。'),
      };
    } catch (error) {
      return {
        available: false,
        cdpAvailable: false,
        codexReady: false,
        port,
        preferredWorkspace,
        code: error.code || 'VSCODE_CDP_UNAVAILABLE',
        message: error.message || 'VSCode CDP 不可用。',
      };
    }
  }

  async function launchCodexCdp(options = {}) {
    const workspace = normalizeWorkspace(options.workspace || {});
    if (workspace.value) preferredWorkspace = workspace;
    const waitMs = Math.max(1000, Number(options.waitMs || process.env.CODEX_MAX_CDP_LAUNCH_WAIT_MS || 20000));
    let launch = null;
    const current = await probe();
    if (!current.cdpAvailable || workspace.value) {
      launch = await startOrOpenVscode(workspace);
    }
    const startedAt = Date.now();
    let lastProbe = current;
    while (Date.now() - startedAt <= waitMs) {
      await delay(500);
      lastProbe = await probe();
      if (lastProbe.cdpAvailable) {
        await ensureCodexReady(Math.min(8000, waitMs)).catch(() => {});
        lastProbe = await probe();
        return {
          ok: true,
          reused: Boolean(current.cdpAvailable || launch?.reused),
          alreadyAvailable: Boolean(current.cdpAvailable && !workspace.value),
          port,
          launch,
          workspace: preferredWorkspace,
          cdp: lastProbe,
          codexReady: lastProbe.codexReady,
          message: lastProbe.codexReady ? '已启动受控 VSCode Codex。' : 'VSCode 已处于 CDP 受控模式，请打开 Codex 面板后再发送消息。',
        };
      }
    }
    const error = makeError(lastProbe?.message || 'VSCode 已启动，但 CDP 没有在限定时间内就绪。', 'VSCODE_CDP_LAUNCH_PROBE_FAILED', 503);
    error.launch = launch;
    error.cdp = lastProbe;
    throw error;
  }

  async function focusComposer() {
    const result = await evaluate(`(() => {
      const editor = document.querySelector(${editorSelectorJson});
      if (!editor) return { ok: false, reason: 'editor not found' };
      editor.focus();
      return { ok: true, text: (editor.innerText || editor.value || '').trim() };
    })()`);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 VSCode Codex 输入框。', 'VSCODE_COMPOSER_MISSING', 503);
    return result;
  }

  async function clearComposer() {
    const result = await evaluate(`(() => {
      const editor = document.querySelector(${editorSelectorJson});
      if (!editor) return { ok: false, reason: 'editor not found' };
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return { ok: true, text: (editor.innerText || editor.value || '').trim() };
    })()`);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 VSCode Codex 输入框。', 'VSCODE_COMPOSER_MISSING', 503);
    return result;
  }

  async function insertText(text, options = {}) {
    await focusComposer();
    if (options.clear !== false) await clearComposer();
    return withCodexFrame(async (socket, context) => {
      await socket.send('Input.insertText', { text: String(text || '') }, timeoutMs);
      await delay(120);
      return evaluateOnSocket(socket, `(() => {
        const editor = document.querySelector(${editorSelectorJson});
        return { ok: Boolean(editor), text: editor ? (editor.innerText || editor.value || '').trim() : '' };
      })()`, { contextId: context.id, timeout: timeoutMs });
    });
  }

  async function submitComposer(expectedText = '') {
    return withCodexFrame(async (socket, context) => {
      const before = await evaluateOnSocket(socket, `(() => {
        ${guiHelpers}
        const editor = document.querySelector(${editorSelectorJson});
        if (!editor) return { ok: false, reason: 'editor not found' };
        editor.focus();
        const messages = collectMessages();
        return {
          ok: true,
          text: (editor.innerText || editor.value || '').trim(),
          lastUser: [...messages].reverse().find(item => item.role === 'user')?.text || '',
          count: messages.length,
        };
      })()`, { contextId: context.id, timeout: timeoutMs });
      if (!before || !before.ok) throw makeError(before?.reason || '没有找到 VSCode Codex 输入框。', 'VSCODE_COMPOSER_MISSING', 503);
      if (String(expectedText || '').trim() && !String(before.text || '').includes(String(expectedText || '').trim())) {
        throw makeError('VSCode Codex 输入框内容和本次发送文本不一致，已停止发送以避免串消息。', 'VSCODE_COMPOSER_TEXT_MISMATCH', 409);
      }
      await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, timeoutMs);
      await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, timeoutMs);
      const expected = String(expectedText || '').trim();
      const startedAt = Date.now();
      let after = null;
      let submitted = false;
      while (Date.now() - startedAt < 6000) {
        await delay(250);
        after = await evaluateOnSocket(socket, `(() => {
          ${guiHelpers}
          const editor = document.querySelector(${editorSelectorJson});
          const messages = collectMessages();
          const lastUser = [...messages].reverse().find(item => item.role === 'user')?.text || '';
          const running = runningState();
          return {
            ok: true,
            text: editor ? (editor.innerText || editor.value || '').trim() : '',
            lastUser,
            count: messages.length,
            running,
          };
        })()`, { contextId: context.id, timeout: timeoutMs });
        submitted = !after.text || after.running || after.count > before.count || (expected && after.lastUser.includes(expected));
        if (submitted) break;
      }
      if (!submitted) throw makeError('VSCode Codex 没有确认发送成功，已停止后续操作。', 'VSCODE_SEND_NOT_CONFIRMED', 503);
      return { ok: true, via: 'enter', before, after };
    });
  }

  async function sendText(text) {
    await ensureCodexReady();
    await insertText(text, { clear: true });
    const result = await submitComposer(text);
    await delay(450);
    return result;
  }

  async function attachFiles(attachments = []) {
    if (!Array.isArray(attachments) || !attachments.length) return { ok: true, count: 0 };
    const result = await evaluate(`(async () => {
      const attachments = ${JSON.stringify(attachments)};
      const composer = document.querySelector(${composerSelectorJson});
      const editor = document.querySelector('.ProseMirror[contenteditable="true"]') || (composer && composer.matches('[contenteditable="true"]') ? composer : null);
      const target = editor || composer;
      if (!target) return { ok: false, reason: 'composer not found' };
      target.focus();
      const b64ToBytes = value => {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      const files = attachments.map(item => new File([b64ToBytes(item.base64)], item.name || 'attachment', { type: item.type || 'application/octet-stream' }));
      const dt = new DataTransfer();
      for (const file of files) dt.items.add(file);
      const nodes = [...new Set([target, editor, composer, composer && composer.closest('[data-codex-composer]')].filter(Boolean))];
      for (const node of nodes) {
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      const visibleText = () => {
        const bodyText = String(document.body && document.body.innerText || '');
        const attrs = [...document.querySelectorAll('[aria-label], [title], [data-filename], [data-file-name], [data-name]')]
          .map(el => [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-filename'),
            el.getAttribute('data-file-name'),
            el.getAttribute('data-name'),
          ].filter(Boolean).join(' '))
          .join('\\n');
        return bodyText + '\\n' + attrs;
      };
      const startedAt = Date.now();
      let text = '';
      let attached = 0;
      while (Date.now() - startedAt < 8000) {
        await new Promise(resolve => setTimeout(resolve, 250));
        text = visibleText();
        attached = files.filter(file => text.includes(file.name)).length;
        if (attached >= files.length) break;
      }
      if (attached < files.length) return { ok: false, reason: 'attachments not visible after paste', count: files.length, attached, names: files.map(file => file.name), dispatchedTo: nodes.length };
      return { ok: true, count: files.length, attached, names: files.map(file => file.name), dispatchedTo: nodes.length };
    })()`, Math.max(timeoutMs + 2000, 9000));
    if (!result || !result.ok) throw makeError(result?.reason || 'VSCode Codex 附件注入失败。', 'VSCODE_ATTACHMENTS_FAILED', 503);
    return result;
  }

  async function sendTextWithAttachments(text, attachments = []) {
    await ensureCodexReady();
    await clearComposer();
    await attachFiles(attachments);
    if (String(text || '').trim()) await insertText(text, { clear: false });
    const sent = await submitComposer(text);
    await delay(450);
    return { ...sent, attachments: attachments.length };
  }

  async function readGuiThreads(limit = 80) {
    await ensureCodexReady();
    const result = await evaluate(`(async () => {
      ${guiHelpers}
      await ensureTaskList();
      const threads = collectThreads().slice(0, ${Math.max(1, Math.min(Number(limit) || 80, 160))});
      return {
        ok: true,
        available: true,
        view: 'thread-list',
        source: 'vscode-gui',
        threads,
        currentThreadId: '',
        title: ''
      };
    })()`, Math.max(timeoutMs, 7000));
    return result || { ok: true, available: false, threads: [] };
  }

  async function selectGuiThread(threadId, waitMs = 9000) {
    const id = String(threadId || '').trim();
    if (!id) return { ok: true, selected: false, threadId: '', message: '没有指定会话。' };
    await ensureCodexReady();
    const result = await evaluate(`(async () => {
      ${guiHelpers}
      await ensureTaskList();
      const targetId = ${JSON.stringify(id)};
      const threads = collectThreads();
      const entry = threadEntries().find(item => item.info.id === targetId);
      const row = entry && entry.el;
      if (!row) return { ok: false, reason: 'thread row not found', threads };
      const before = normalize(document.body && document.body.innerText || '').slice(0, 1000);
      row.click();
      const started = Date.now();
      while (Date.now() - started < ${Math.max(1000, Number(waitMs) || 9000)}) {
        await new Promise(resolve => setTimeout(resolve, 180));
        const afterTitle = currentTitle();
        const messages = collectMessages();
        const after = normalize(document.body && document.body.innerText || '').slice(0, 1000);
        if (messages.length || (afterTitle && after !== before)) {
          return { ok: true, threadId: targetId, title: afterTitle || entry.info.title, messages: messages.length, view: messages.length ? 'conversation' : 'unknown' };
        }
      }
      return { ok: true, threadId: targetId, title: currentTitle() || entry.info.title, pending: true, view: 'unknown' };
    })()`, Math.max(timeoutMs + 3000, waitMs + 1200));
    if (!result || !result.ok) throw makeError(result?.reason || '没有在 VSCode Codex 任务列表中找到目标会话。', 'VSCODE_GUI_THREAD_NOT_FOUND', 404);
    currentThreadId = id;
    currentThreadTitle = String(result.title || '').trim();
    return result;
  }

  async function readGuiHistory(limit = 120) {
    await ensureCodexReady();
    const result = await evaluate(`(async () => {
      ${guiHelpers}
      const state = viewState();
      if (state.view !== 'conversation') {
        return {
          ok: true,
          available: false,
          view: state.view,
          source: 'vscode-gui',
          threadId: '',
          title: '',
          messages: [],
          messageCount: 0,
          message: '当前 VSCode Codex 显示的是任务列表，请先选择一个会话。'
        };
      }
      const title = state.title;
      const scroller = document.querySelector('[data-app-action-timeline-scroll]') || document.scrollingElement;
      const originalTop = scroller ? scroller.scrollTop : 0;
      const seen = new Map();
      const collect = () => {
        for (const item of collectMessages()) {
          if (!seen.has(item.key)) seen.set(item.key, item);
        }
      };
      collect();
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 20) {
        for (let i = 0; i < 10; i += 1) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before - Math.max(260, scroller.clientHeight * 0.75);
          await new Promise(resolve => setTimeout(resolve, 90));
          collect();
          if (Math.abs(scroller.scrollTop - before) < 2) break;
        }
        scroller.scrollTop = originalTop;
      }
      const messages = [...seen.values()].slice(-${Math.max(1, Math.min(Number(limit) || 120, 240))});
      const selectedId = ${JSON.stringify(currentThreadId)};
      const selectedTitle = normalize(${JSON.stringify(currentThreadTitle)});
      const currentId = selectedId && selectedTitle && selectedTitle === normalize(title)
        ? selectedId
        : (title ? 'gui:title:' + hashText(title) : '');
      return {
        ok: true,
        available: Boolean(title || messages.length),
        view: 'conversation',
        source: 'vscode-gui',
        threadId: currentId,
        title,
        messages,
        messageCount: messages.length,
      };
    })()`, Math.max(timeoutMs + 5000, 12000));
    if (result?.threadId && !currentThreadId) {
      currentThreadId = result.threadId;
      currentThreadTitle = String(result.title || '').trim();
    }
    return result || { ok: true, available: false, source: 'vscode-gui', messages: [] };
  }

  async function readGuiStatus() {
    await ensureCodexReady();
    const result = await evaluate(`(() => {
      ${guiHelpers}
      const state = viewState();
      const messages = state.messages;
      const lastAssistant = [...messages].reverse().find(item => item.role === 'assistant');
      const lastUser = [...messages].reverse().find(item => item.role === 'user');
      const running = runningState();
      const toolbar = toolbarState();
      const title = state.view === 'conversation' ? state.title : '';
      const selectedId = ${JSON.stringify(currentThreadId)};
      const selectedTitle = normalize(${JSON.stringify(currentThreadTitle)});
      const currentId = selectedId && selectedTitle && selectedTitle === normalize(title)
        ? selectedId
        : (title ? 'gui:title:' + hashText(title) : '');
      return {
        ok: true,
        available: state.view === 'conversation' && Boolean(title || messages.length || document.querySelector(${composerSelectorJson})),
        view: state.view,
        source: 'vscode-gui',
        threadId: currentId,
        title,
        active: running,
        status: running ? 'running' : (messages.length ? 'complete' : 'idle'),
        preview: lastAssistant ? lastAssistant.text : '',
        final: running ? '' : (lastAssistant ? lastAssistant.text : ''),
        lastUser: lastUser ? lastUser.text : '',
        updatedAt: new Date().toISOString(),
        startedAt: '',
        completedAt: running ? '' : new Date().toISOString(),
        messages,
        model: toolbar.model,
        reasoningMode: toolbar.reasoningMode,
        toolbar,
      };
    })()`, Math.max(timeoutMs, 7000));
    if (result?.threadId && !currentThreadId) {
      currentThreadId = result.threadId;
      currentThreadTitle = String(result.title || '').trim();
    }
    return result || { ok: true, available: false, source: 'vscode-gui', status: 'idle', messages: [] };
  }

  async function newProjectlessThread(settleMs = 900) {
    await ensureCodexReady();
    const result = await evaluate(`(() => {
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 12 && rect.height >= 12 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const labelOf = el => normalize([el.getAttribute('aria-label'), el.innerText, el.textContent, el.title].filter(Boolean).join(' '));
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const button = buttons.find(el => /^(新聊天|新对话|New chat|New thread)$/i.test(labelOf(el))) ||
        buttons.find(el => /新聊天|新对话|New chat|New thread/i.test(labelOf(el)));
      if (!button) return { ok: false, reason: 'new chat button not found' };
      button.click();
      return { ok: true, text: normalize(button.innerText), aria: button.getAttribute('aria-label') || '' };
    })()`);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 VSCode Codex 新聊天按钮。', 'VSCODE_NEW_THREAD_BUTTON_MISSING', 503);
    currentThreadId = '';
    currentThreadTitle = '';
    await delay(settleMs);
    return result;
  }

  async function stopResponse() {
    await ensureCodexReady();
    return withCodexFrame(async (socket, context) => {
      const result = await evaluateOnSocket(socket, `(() => {
        const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = rect => rect && rect.width >= 16 && rect.height >= 16 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        const blocked = button => button.disabled || button.getAttribute('aria-disabled') === 'true';
        const buttons = [...document.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return {
            button,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
            label: normalize([button.getAttribute('aria-label'), button.title, button.getAttribute('data-testid'), button.innerText, button.textContent].filter(Boolean).join(' '))
          };
        }).filter(item => visible(item.rect) && !blocked(item.button));
        const explicit = buttons.find(item => /停止|中止|终止|取消|Stop|Cancel|Interrupt|Abort/i.test(item.label));
        if (explicit) return { ok: true, via: 'explicit', rect: explicit.rect, label: explicit.label };
        const composer = document.querySelector(${composerSelectorJson});
        const cr = composer ? composer.getBoundingClientRect() : null;
        const nearComposer = buttons
          .filter(item => cr ? item.rect.top >= cr.top - 60 && item.rect.bottom <= cr.bottom + 140 && item.rect.left >= cr.left + (cr.width * 0.45) : item.rect.bottom >= innerHeight - 180 && item.rect.left >= innerWidth * 0.45)
          .filter(item => !/模型|推理|GPT|添加|文件|上下文|model|reason|attach|file|context/i.test(item.label))
          .sort((a, b) => b.rect.left - a.rect.left || b.rect.top - a.rect.top);
        const candidate = nearComposer.find(item => item.rect.w <= 72 && item.rect.h <= 72) || nearComposer[0];
        if (candidate) return { ok: true, via: 'composer-action', rect: candidate.rect, label: candidate.label };
        return { ok: false, reason: 'stop button not found' };
      })()`, { contextId: context.id, timeout: timeoutMs });

      if (result && result.ok && result.rect) {
        const x = Number(result.rect.x) + Number(result.rect.w) / 2;
        const y = Number(result.rect.y) + Number(result.rect.h) / 2;
        await socket.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, timeoutMs);
        await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, timeoutMs);
        await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, timeoutMs);
        await delay(180);
        return result;
      }
      await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, timeoutMs);
      await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, timeoutMs);
      return { ok: true, via: 'escape', reason: result?.reason || 'stop button not found' };
    });
  }

  async function switchReasoningMode(targetKey = '') {
    await ensureCodexReady();
    const aliases = {
      low: ['低', 'Low'],
      medium: ['中', 'Medium'],
      med: ['中', 'Medium'],
      normal: ['中', 'Medium'],
      high: ['高', 'High'],
      xhigh: ['超高', 'Extra High', 'Max'],
      'x-high': ['超高', 'Extra High', 'Max'],
      ultra: ['超高', 'Extra High', 'Max'],
      max: ['超高', 'Extra High', 'Max'],
    };
    const candidates = aliases[String(targetKey || '').trim().toLowerCase()] || [String(targetKey || '').trim()];
    if (!candidates.filter(Boolean).length) throw makeError('缺少目标推理模式。', 'VSCODE_BAD_REASONING_TARGET', 400);
    const result = await evaluate(`(() => {
      const candidates = ${JSON.stringify(candidates)};
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const lowerCandidates = candidates.map(value => normalize(value).toLowerCase()).filter(Boolean);
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      if (!trigger) return { ok: false, reason: 'reasoning trigger not found' };
      trigger.click();
      return new Promise(resolve => setTimeout(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [cmdk-item], button')];
        const item = items.find(el => {
          const text = normalize(el.innerText || el.textContent);
          const lower = text.toLowerCase();
          return lowerCandidates.some(candidate => lower === candidate || lower.endsWith(candidate) || lower.includes(candidate));
        });
        if (!item) return resolve({ ok: false, reason: 'reasoning item not found', menuText: normalize(items.map(el => el.innerText || '').join('\\n')).slice(0, 600) });
        const text = normalize(item.innerText || item.textContent);
        item.click();
        setTimeout(() => resolve({ ok: true, text, triggerText: normalize(trigger.innerText || trigger.textContent) }), 250);
      }, 220));
    })()`, timeoutMs + 1000);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 VSCode Codex 推理模式菜单项。', 'VSCODE_REASONING_ITEM_MISSING', 503);
    return result;
  }

  async function switchModel(target = {}) {
    await ensureCodexReady();
    const candidates = [target.displayName, target.label, target.id, target.key]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (!candidates.length) throw makeError('缺少目标模型。', 'VSCODE_BAD_MODEL_TARGET', 400);
    const result = await evaluate(`(() => {
      const candidates = ${JSON.stringify(candidates)};
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const lowerCandidates = candidates.map(value => normalize(value).toLowerCase()).filter(Boolean);
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      if (!trigger) return { ok: false, reason: 'model trigger not found' };
      trigger.click();
      return new Promise(resolve => setTimeout(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [cmdk-item], button')];
        const item = items.find(el => {
          const text = normalize(el.innerText || el.textContent);
          const lower = text.toLowerCase();
          return lowerCandidates.some(candidate => lower === candidate || lower.includes(candidate) || candidate.includes(lower));
        });
        if (!item) return resolve({ ok: false, reason: 'model item not found', menuText: normalize(items.map(el => el.innerText || '').join('\\n')).slice(0, 800) });
        const text = normalize(item.innerText || item.textContent);
        item.click();
        setTimeout(() => resolve({ ok: true, text, triggerText: normalize(trigger.innerText || trigger.textContent) }), 250);
      }, 220));
    })()`, timeoutMs + 1000);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 VSCode Codex 模型菜单项。', 'VSCODE_MODEL_ITEM_MISSING', 503);
    return result;
  }

  return {
    port,
    baseUrl,
    probe,
    launchCodexCdp,
    ensureCodexReady,
    readGuiThreads,
    readGuiHistory,
    readGuiStatus,
    selectGuiThread,
    focusComposer,
    insertText,
    sendText,
    sendTextWithAttachments,
    attachFiles,
    newProjectlessThread,
    stopResponse,
    switchReasoningMode,
    switchModel,
  };
}

function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

module.exports = function createWin32Platform() {
  const enqueue = createQueue();
  const vscodeCdp = createVscodeCdpController();

  return {
    name: 'win32',
    runExclusive(fn) {
      return enqueue(fn);
    },
    sendText(text) {
      return enqueue(() => vscodeCdp.sendText(String(text || '')));
    },
    sendTextWithAttachments(text, attachments) {
      return enqueue(() => vscodeCdp.sendTextWithAttachments(String(text || ''), attachments));
    },
    readGuiThreads(limit) {
      return enqueue(() => vscodeCdp.readGuiThreads(limit));
    },
    readGuiHistory(limit) {
      return enqueue(() => vscodeCdp.readGuiHistory(limit));
    },
    readGuiStatus() {
      return enqueue(() => vscodeCdp.readGuiStatus());
    },
    selectGuiThread(threadId) {
      return enqueue(() => vscodeCdp.selectGuiThread(threadId));
    },
    newProjectlessThread(settleMs) {
      return enqueue(() => vscodeCdp.newProjectlessThread(settleMs));
    },
    stopResponse() {
      return enqueue(() => vscodeCdp.stopResponse());
    },
    switchReasoningMode(targetKey) {
      return enqueue(() => vscodeCdp.switchReasoningMode(targetKey));
    },
    switchModel(target) {
      return enqueue(() => vscodeCdp.switchModel(target));
    },
    cdpStatus() {
      return vscodeCdp.probe();
    },
    launchCodexCdp(options) {
      return enqueue(() => vscodeCdp.launchCodexCdp(options));
    },
    cleanup() {},
  };
};

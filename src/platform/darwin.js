'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { code, stdout, stderr }));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getClickTool() {
  for (const candidate of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toCliclickAbsolutePoint(point) {
  return point.split(',').map(part => part.startsWith('-') ? `=${part}` : part).join(',');
}

module.exports = function createDarwinPlatform(env) {
  const {
    rootDir,
    delay,
    isCodexThreadId,
    codexThreadDeepLink,
    codexNewThreadDeepLink,
    CODEX_DEEPLINK_SETTLE_MS,
    CODEX_APP_FOCUS_SETTLE_MS,
    CODEX_CLICK_SETTLE_MS,
    CODEX_THREAD_SYNC_FRESH_MS,
  } = env;

  let lastCodexThreadActivation = { threadId: '', at: 0 };
  let keepAwakeProcess = null;
  let keepAwakeStartedAt = '';

  function hasFreshCodexThreadActivation(threadId) {
    return Boolean(
      isCodexThreadId(threadId) &&
      lastCodexThreadActivation.threadId === threadId &&
      Date.now() - lastCodexThreadActivation.at <= CODEX_THREAD_SYNC_FRESH_MS
    );
  }

  function isKeepAwakeActive() {
    return Boolean(keepAwakeProcess && keepAwakeProcess.exitCode === null && !keepAwakeProcess.killed);
  }

  function keepAwakeStatus() {
    return {
      enabled: isKeepAwakeActive(),
      startedAt: isKeepAwakeActive() ? keepAwakeStartedAt : '',
      command: 'caffeinate -dims',
    };
  }

  function startKeepAwake() {
    if (isKeepAwakeActive()) return keepAwakeStatus();
    const caffeinatePath = '/usr/bin/caffeinate';
    if (!fs.existsSync(caffeinatePath)) {
      const error = new Error('这台 Mac 没有找到 caffeinate，无法阻止休眠。');
      error.code = 'CAFFEINATE_NOT_FOUND';
      throw error;
    }
    const child = spawn(caffeinatePath, ['-dims'], { stdio: 'ignore' });
    keepAwakeProcess = child;
    keepAwakeStartedAt = new Date().toISOString();
    child.on('exit', () => {
      if (keepAwakeProcess === child) {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      }
    });
    child.on('error', () => {
      if (keepAwakeProcess === child) {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      }
    });
    return keepAwakeStatus();
  }

  function stopKeepAwake() {
    const child = keepAwakeProcess;
    keepAwakeProcess = null;
    keepAwakeStartedAt = '';
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
    return keepAwakeStatus();
  }

  async function copyTextToClipboard(text) {
    const filePath = path.join(os.tmpdir(), `codex-max-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
    try {
      await runProcess('/usr/bin/osascript', ['-e', `set the clipboard to (read (POSIX file "${appleScriptString(filePath)}") as «class utf8»)`]);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  async function activateCodexThread(threadId = '', options = {}) {
    if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
      await runProcess('open', ['-b', 'com.openai.codex']);
      await delay(CODEX_APP_FOCUS_SETTLE_MS);
      return;
    }

    const deepLink = codexThreadDeepLink(threadId);
    if (deepLink) {
      await runProcess('open', [deepLink]);
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    }
    await runProcess('open', ['-b', 'com.openai.codex']);
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
  }

  async function activateNewCodexThread(cwd = '') {
    const deepLink = codexNewThreadDeepLink(cwd);
    await runProcess('open', [deepLink]);
    await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
    await runProcess('open', ['-b', 'com.openai.codex']);
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    lastCodexThreadActivation = { threadId: '', at: 0 };
  }

  async function activateNewProjectlessCodexThread(anchorThreadId = '') {
    if (isCodexThreadId(anchorThreadId)) {
      await activateCodexThread(anchorThreadId);
      await pressCodexShortcut('n', ['command']);
      await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
    } else {
      await activateNewCodexThread('');
    }
    await runProcess('open', ['-b', 'com.openai.codex']);
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    lastCodexThreadActivation = { threadId: '', at: 0 };
  }

  async function focusTarget(target, threadId = '', options = {}) {
    if (target !== 'codex') return;

    await activateCodexThread(threadId, { allowCached: Boolean(options.assumeThreadSynced) });
    if (options.skipComposerClick) return;

    const pointTool = path.join(rootDir, 'bin', 'codex-window-point');
    if (!fs.existsSync(pointTool)) throw new Error(`Codex window point helper not found: ${pointTool}`);
    const { stdout } = await runProcess(pointTool, []);
    const point = stdout.trim();
    if (!/^-?\d+,-?\d+$/.test(point)) throw new Error(`Invalid Codex click point: ${point}`);

    const clickTool = getClickTool();
    if (clickTool) {
      await runProcess(clickTool, [`c:${toCliclickAbsolutePoint(point)}`]);
    } else {
      await runProcess('osascript', ['-e', `tell application "System Events" to click at {${point}}`]);
    }
    await delay(CODEX_CLICK_SETTLE_MS);
  }

  async function copyImageToClipboard(file) {
    const quoted = appleScriptString(file.filePath);
    let typeExpr = '«class PNGf»';
    if (file.mime === 'image/jpeg') typeExpr = 'JPEG picture';
    else if (file.mime === 'image/gif') typeExpr = 'GIF picture';
    else if (file.mime !== 'image/png') {
      await runProcess('osascript', ['-e', `set the clipboard to (POSIX file "${quoted}")`]);
      return;
    }
    await runProcess('osascript', ['-e', `set the clipboard to (read (POSIX file "${quoted}") as ${typeExpr})`]);
  }

  async function pressPaste() {
    await runProcess('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  }

  async function typeText(text) {
    await copyTextToClipboard(text);
    await pressPaste();
  }

  async function pressEnter() {
    await runProcess('osascript', ['-e', 'tell application "System Events" to key code 36']);
  }

  async function pressCodexShortcut(key, modifiers = []) {
    const modifierExpr = modifiers.length ? ` using {${modifiers.map(item => `${item} down`).join(', ')}}` : '';
    await runProcess('osascript', ['-e', `tell application "System Events" to keystroke "${appleScriptString(key)}"${modifierExpr}`]);
  }

  async function pressCancelCodexResponse() {
    await runProcess('osascript', ['-e', 'tell application "System Events" to key code 53\ndelay 0.08\ntell application "System Events" to keystroke "." using command down']);
  }

  async function withClipboardPreserved(fn) {
    return fn();
  }

  async function runExclusive(fn) {
    return fn();
  }

  function cleanup() {
    stopKeepAwake();
  }

  return {
    name: 'darwin',
    focusTarget,
    activateCodexThread,
    activateNewCodexThread,
    activateNewProjectlessCodexThread,
    copyTextToClipboard,
    typeText,
    copyImageToClipboard,
    pressPaste,
    pressEnter,
    pressCodexShortcut,
    pressCancelCodexResponse,
    keepAwakeStatus,
    startKeepAwake,
    stopKeepAwake,
    withClipboardPreserved,
    runExclusive,
    cleanup,
  };
};

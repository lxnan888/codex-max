#!/usr/bin/env node
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const APP_NAME = process.env.CODEX_MAX_APP_NAME || 'Codex Max';
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = Number(process.env.CODEX_MAX_MAX_BODY_BYTES || 40 * 1024 * 1024);
const MAX_TEXT_LENGTH = 8000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 6;

const TARGET_INFO = {
  controlTarget: 'vscode',
  targetLabel: 'VSCode Codex',
  threadActivationSupported: true,
  attachmentsSupported: true,
};

const REASONING_MODE_TARGETS = {
  low: { key: 'low', value: 'low', label: '低', displayName: '低' },
  medium: { key: 'medium', value: 'medium', label: '中', displayName: '中' },
  high: { key: 'high', value: 'high', label: '高', displayName: '高' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '超高', displayName: '超高' },
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

let modelCatalogCache = { mtimeMs: -1, path: '', models: null };
const recentSendRequests = new Map();
const RECENT_SEND_TTL_MS = 5 * 60 * 1000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeControlError(message, code = 'CONTROL_ERROR', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

const platform = require('./src/platform')({ rootDir: __dirname, delay });

function truncateText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function tomlStringValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : '';
}

function labelFromModelName(name = '') {
  const text = String(name || '').trim();
  if (!text) return '';
  return text
    .replace(/\(.*?\)/g, '')
    .replace(/^GPT-/i, '')
    .replace(/^gpt-/i, '')
    .replace(/^codex-/i, '')
    .trim() || text;
}

function normalizeModelOption(row = {}) {
  const id = String(row.slug || row.id || row.model || '').trim();
  if (!id) return null;
  const displayName = String(row.display_name || row.name || row.label || id).trim();
  return {
    key: id,
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: 'local',
  };
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, 'model_catalog_json');
  const resolvedPath = catalogPath.startsWith('~') ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const fallback = () => {
    const current = tomlStringValue(configText, 'model');
    return current ? [{ key: current, id: current, label: labelFromModelName(current), displayName: current, source: 'local' }] : [];
  };
  if (!resolvedPath) return fallback();
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility !== 'hide')
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? models : fallback();
  } catch {
    return fallback();
  }
}

function findModelOption(id = '') {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  return readModelCatalogOptions().find(item => item.id === targetId || item.key === targetId) || null;
}

function modelSwitchTarget(requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const catalogTarget = findModelOption(explicit);
  if (catalogTarget) return catalogTarget;
  if (explicit) return { key: explicit, id: explicit, label: labelFromModelName(explicit), displayName: explicit, source: 'request' };
  const options = readModelCatalogOptions();
  if (options.length) return options[0];
  throw makeControlError('缺少目标模型。', 'BAD_MODEL_TARGET', 400);
}

function reasoningModeTarget(requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim().toLowerCase();
  const aliases = {
    low: 'low',
    '低': 'low',
    medium: 'medium',
    med: 'medium',
    normal: 'medium',
    '中': 'medium',
    high: 'high',
    '高': 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    ultra: 'xhigh',
    max: 'xhigh',
    '超高': 'xhigh',
  };
  const key = aliases[explicit] || explicit || 'medium';
  const target = REASONING_MODE_TARGETS[key];
  if (!target) throw makeControlError('目标推理强度不正确。', 'BAD_REASONING_TARGET', 400);
  return target;
}

function normalizeBase64(value) {
  const raw = String(value || '').trim();
  const comma = raw.indexOf(',');
  const base64 = raw.slice(0, 80).includes(';base64') && comma >= 0 ? raw.slice(comma + 1) : raw;
  return base64.replace(/\s+/g, '');
}

function normalizeAttachmentName(value, index) {
  const fallback = `attachment-${index + 1}`;
  const name = path.basename(String(value || fallback).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')).trim();
  return (name || fallback).slice(0, 180);
}

function normalizeAttachments(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > MAX_ATTACHMENT_COUNT) throw makeControlError(`一次最多发送 ${MAX_ATTACHMENT_COUNT} 个附件。`, 'ATTACHMENT_COUNT_EXCEEDED', 413);
  let total = 0;
  return input.map((item, index) => {
    const base64 = normalizeBase64(item && (item.base64 || item.data || item.content));
    if (!base64) throw makeControlError('附件内容为空。', 'BAD_ATTACHMENT', 400);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw makeControlError('附件内容不是有效的 base64。', 'BAD_ATTACHMENT_BASE64', 400);
    const buffer = Buffer.from(base64, 'base64');
    const size = buffer.length;
    if (size > MAX_ATTACHMENT_BYTES) throw makeControlError(`单个附件不能超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB。`, 'ATTACHMENT_TOO_LARGE', 413);
    total += size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw makeControlError(`单次附件总大小不能超过 ${Math.round(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB。`, 'ATTACHMENTS_TOO_LARGE', 413);
    return {
      name: normalizeAttachmentName(item && item.name, index),
      type: String((item && (item.type || item.mime)) || 'application/octet-stream').slice(0, 120) || 'application/octet-stream',
      size,
      base64: buffer.toString('base64'),
    };
  });
}

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(id) ? id : '';
}

function selectableGuiThreadId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (/^gui:title:[a-z0-9]+(?::dup\d+)?$/i.test(id)) return id;
  throw makeControlError('会话 id 不是 VSCode 左侧任务列表中的可点击项，请刷新列表后重新选择。', 'BAD_GUI_THREAD_ID', 400);
}

function cleanupRecentSendRequests() {
  const cutoff = Date.now() - RECENT_SEND_TTL_MS;
  for (const [id, entry] of recentSendRequests) {
    if (!entry || entry.createdAt < cutoff) recentSendRequests.delete(id);
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function options(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('输入太长了，请分段发送。'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonPayload(req) {
  try {
    return JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    throw makeControlError(error.message || '请求格式不正确。', 'BAD_REQUEST', error.status || 400);
  }
}

function explainTargetError(error) {
  return {
    code: error && error.code ? error.code : 'VSCODE_CONTROL_FAILED',
    message: error && error.message ? error.message : 'VSCode Codex 控制失败。',
  };
}

function getLocalApiBases() {
  return [`http://127.0.0.1:${PORT}`];
}

async function handleThreads(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const limit = Math.max(1, Math.min(160, Number(url.searchParams.get('limit')) || 80));
    const data = await platform.readGuiThreads(limit);
    return json(res, 200, { ok: true, ...TARGET_INFO, ...data, threads: data.threads || [] });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained, threads: [] });
  }
}

async function handleThreadHistory(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const limit = Math.max(1, Math.min(240, Number(url.searchParams.get('limit')) || 120));
    const data = await platform.readGuiHistory(limit);
    return json(res, 200, { ok: true, ...TARGET_INFO, ...data, threadId: data.threadId || '' });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained, messages: [] });
  }
}

async function handleCodexStatus(req, res) {
  try {
    const data = await platform.readGuiStatus();
    return json(res, 200, { ok: true, ...TARGET_INFO, ...data, threadId: data.threadId || '' });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained, available: false, status: 'error' });
  }
}

async function handleSelectThread(req, res) {
  try {
    const payload = await readJsonPayload(req);
    const threadId = selectableGuiThreadId(payload.threadId);
    const selection = await platform.selectGuiThread(threadId);
    const history = await platform.readGuiHistory(Number(payload.limit) || 120).catch(() => null);
    return json(res, 200, {
      ok: true,
      ...TARGET_INFO,
      threadId,
      activated: true,
      selection,
      history,
      message: '已在 VSCode Codex 中打开目标会话。',
    });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

async function handleNewCodexThread(req, res) {
  try {
    await readJsonPayload(req).catch(() => ({}));
    const action = await platform.newProjectlessThread(1200);
    const status = await platform.readGuiStatus().catch(() => null);
    return json(res, 200, {
      ok: true,
      ...TARGET_INFO,
      action,
      status,
      threadId: status?.threadId || '',
      source: 'vscode-gui',
      message: '已在 VSCode Codex 打开新聊天。',
    });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

async function handleSend(req, res) {
  let clientRequestId = '';
  try {
    const payload = await readJsonPayload(req);
    clientRequestId = normalizeClientRequestId(payload.clientRequestId);
    cleanupRecentSendRequests();
    if (clientRequestId) {
      const existing = recentSendRequests.get(clientRequestId);
      if (existing?.result) return json(res, 200, { ...existing.result, duplicate: true });
    }

    const text = typeof payload.text === 'string' ? payload.text : '';
    const attachments = normalizeAttachments(Array.isArray(payload.attachments) ? payload.attachments : []);
    const threadId = selectableGuiThreadId(payload.threadId);
    if (!text.trim() && !attachments.length) return json(res, 400, { ok: false, code: 'EMPTY_CONTENT', message: '请输入文字或选择附件。' });
    if (text.length > MAX_TEXT_LENGTH) return json(res, 413, { ok: false, code: 'TEXT_TOO_LONG', message: `文字太长了，请控制在 ${MAX_TEXT_LENGTH} 字以内。` });
    if (threadId) await platform.selectGuiThread(threadId);

    const sentAt = new Date().toISOString();
    const watch = { since: sentAt, threadId, source: 'vscode-gui' };
    if (clientRequestId) recentSendRequests.set(clientRequestId, { createdAt: Date.now(), sentAt, watch });

    if (attachments.length) await platform.sendTextWithAttachments(text, attachments);
    else await platform.sendText(text);

    const status = await platform.readGuiStatus().catch(() => null);
    const attachmentSummaries = attachments.map(item => ({ name: item.name, type: item.type, size: item.size }));
    const result = {
      ok: true,
      ...TARGET_INFO,
      message: attachments.length ? '已发送到 VSCode Codex，并附带文件。' : '已发送到 VSCode Codex。',
      target: 'vscode-gui',
      sentAt,
      threadId: status?.threadId || threadId || '',
      attachments: attachmentSummaries,
      watch,
      status,
    };
    if (clientRequestId) recentSendRequests.set(clientRequestId, { createdAt: Date.now(), sentAt, watch: result.watch, result });
    return json(res, 200, result);
  } catch (error) {
    if (clientRequestId) recentSendRequests.delete(clientRequestId);
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

async function handleStopCodex(req, res) {
  try {
    const payload = await readJsonPayload(req);
    const threadId = selectableGuiThreadId(payload.threadId);
    if (threadId) await platform.selectGuiThread(threadId);
    const action = await platform.stopResponse();
    const status = await platform.readGuiStatus().catch(() => null);
    return json(res, 200, { ok: true, ...TARGET_INFO, threadId, action, status, message: '已向 VSCode Codex 发送停止指令。' });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

async function handleModelSwitch(req, res) {
  try {
    const payload = await readJsonPayload(req);
    const threadId = selectableGuiThreadId(payload.threadId);
    if (threadId) await platform.selectGuiThread(threadId);
    const target = modelSwitchTarget(payload.target);
    const toolbar = await platform.switchModel(target);
    const status = await platform.readGuiStatus().catch(() => null);
    return json(res, 200, {
      ok: true,
      ...TARGET_INFO,
      verified: true,
      threadId,
      targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar,
      status,
      message: `已在 VSCode Codex 切换到 ${target.displayName}`,
    });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

async function handleReasoningMode(req, res) {
  try {
    const payload = await readJsonPayload(req);
    const threadId = selectableGuiThreadId(payload.threadId);
    if (threadId) await platform.selectGuiThread(threadId);
    const target = reasoningModeTarget(payload.target);
    const toolbar = await platform.switchReasoningMode(target.key);
    const status = await platform.readGuiStatus().catch(() => null);
    return json(res, 200, {
      ok: true,
      ...TARGET_INFO,
      verified: true,
      threadId,
      targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar,
      status,
      message: `已在 VSCode Codex 切换推理强度为 ${target.displayName}`,
    });
  } catch (error) {
    const explained = explainTargetError(error);
    return json(res, error.status || 503, { ok: false, ...TARGET_INFO, ...explained });
  }
}

function handleClientConfig(req, res) {
  return json(res, 200, {
    ok: true,
    service: 'codex-max',
    appName: APP_NAME,
    ...TARGET_INFO,
    localOnly: true,
    localApiBases: getLocalApiBases(),
    modelOptions: readModelCatalogOptions(),
  });
}

async function handleHealth(req, res) {
  let cdp = null;
  try {
    cdp = await platform.cdpStatus();
  } catch (error) {
    cdp = { available: false, code: error.code || 'CDP_STATUS_FAILED', message: error.message || 'CDP 状态读取失败。' };
  }
  return json(res, 200, {
    ok: true,
    service: 'codex-max',
    host: os.hostname(),
    platform: platform.name,
    ...TARGET_INFO,
    controlMode: cdp && (cdp.available || cdp.cdpAvailable) ? 'cdp' : 'unavailable',
    cdp,
    now: new Date().toISOString(),
  });
}

async function handleCdpLaunch(req, res) {
  try {
    const payload = await readJsonPayload(req);
    const result = await platform.launchCodexCdp({ waitMs: payload.waitMs, workspace: payload.workspace || null });
    return json(res, 200, { ...result, ...TARGET_INFO });
  } catch (error) {
    return json(res, error.status || 503, {
      ok: false,
      ...TARGET_INFO,
      code: error.code || 'CDP_LAUNCH_FAILED',
      message: error.message || '启动 VSCode CDP 受控版本失败。',
      launch: error.launch,
      cdp: error.cdp,
    });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      'content-length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return options(res);
  if (req.method === 'GET' && req.url.startsWith('/codex/health')) return handleHealth(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/config')) return handleClientConfig(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/cdp-launch')) return handleCdpLaunch(req, res);
  if (req.method === 'POST' && req.url.startsWith('/send')) return handleSend(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/threads')) return handleThreads(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/history')) return handleThreadHistory(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/status')) return handleCodexStatus(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/select')) return handleSelectThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/new-thread')) return handleNewCodexThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/model-switch')) return handleModelSwitch(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/reasoning-mode')) return handleReasoningMode(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/stop')) return handleStopCodex(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log('\nCodex Max VSCode 本地版已启动。');
  console.log(`WebUI: http://127.0.0.1:${PORT}/`);
  console.log('受控目标：VSCode Codex · CDP');
  console.log('聊天/历史/状态来源：VSCode WebView GUI');
  console.log('按 Ctrl+C 停止。\n');
});

process.on('exit', () => platform.cleanup && platform.cleanup());
process.on('SIGINT', () => {
  if (platform.cleanup) platform.cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  if (platform.cleanup) platform.cleanup();
  process.exit(143);
});

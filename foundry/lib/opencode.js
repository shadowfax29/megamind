'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const cfg = require('./config');

/**
 * Talks to a private `opencode serve` bound to 127.0.0.1. Tools are disabled on every
 * message, so the model can only return text; the foundry applies that text itself
 * through the permission broker. The model call is the only AI traffic that leaves the box.
 */
let child = null;
let base = null;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

async function ensureServer() {
  if (base) return base;
  const cwd = path.join(cfg.ROOT, 'runs', '_opencode');
  fs.mkdirSync(cwd, { recursive: true });
  const port = await freePort();
  child = spawn(`${cfg.opencodeBin} serve --port ${port} --hostname 127.0.0.1`, { cwd, shell: true, windowsHide: true, stdio: 'ignore' });
  child.on('exit', () => { child = null; base = null; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/session/status`)).ok) { base = url; return base; } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error('opencode server did not start. Is `opencode` installed and logged in?');
}

function stop() {
  if (!child) return;
  const pid = child.pid;
  child = null; base = null;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  else try { process.kill(pid); } catch { /* gone */ }
}
process.on('exit', stop);

async function api(method, p, body, signal) {
  const r = await fetch(base + p, {
    method, signal,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`opencode ${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function chat({ system, prompt, model, signal, title }) {
  await ensureServer();
  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/');
  const s = await api('POST', '/session', { title: title || 'foundry' }, signal);
  const timeout = AbortSignal.timeout(cfg.llmTimeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const r = await api('POST', `/session/${s.id}/message`, {
      model: { providerID, modelID }, system, tools: {},
      parts: [{ type: 'text', text: prompt }],
    }, sig);
    if (r?.info?.error) throw new Error(`model error: ${JSON.stringify(r.info.error).slice(0, 300)}`);
    const text = (r.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
    if (!text) throw new Error('model returned no text');
    return { text, tokens: r.info?.tokens?.total || 0 };
  } finally {
    api('DELETE', `/session/${s.id}`).catch(() => {});
  }
}

module.exports = { chat, stop, ensureServer };

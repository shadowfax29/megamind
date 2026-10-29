'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const st = require('./lib/state');
const brain = require('./lib/brain');
const { startRun, abortRun } = require('./lib/pipeline');
const oc = require('./lib/opencode');
const { Sandbox } = require('./lib/sandbox');
const { profiles } = require('./lib/agents');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 100_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const factoryOf = (id) => { const f = st.factories.get(id); if (!f) throw new Error('no such factory'); return f; };

const server = http.createServer(async (req, res) => {
  // Anti DNS-rebinding: only answer for our own loopback host names.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'POST') {
      // Custom header + JSON means a cross-site page cannot forge this without a CORS preflight, which we never grant.
      if (req.headers['x-foundry'] !== '1') return send(res, 403, { error: 'missing x-foundry header' });
      const body = await readBody(req);
      let m;
      if (p === '/api/factories') return send(res, 200, { id: st.addFactory(body.name).id });
      if ((m = p.match(/^\/api\/factories\/(\w+)\/(runs|abort|move|remove)$/))) {
        const f = factoryOf(m[1]);
        if (m[2] === 'runs') return send(res, 200, { id: startRun(f, { task: body.task, seed: body.seed || null }).id });
        if (m[2] === 'abort') return send(res, 200, { ok: abortRun(f) });
        if (m[2] === 'move') return send(res, 200, { ok: st.patchFactory(f.id, { name: body.name, x: body.x, y: body.y }) });
        const err = st.removeFactory(f.id);
        return send(res, err ? 400 : 200, err ? { error: err } : { ok: true });
      }
      if ((m = p.match(/^\/api\/approvals\/(ap_\w+)$/))) {
        return send(res, 200, { ok: st.answer(m[1], { approve: !!body.approve, text: String(body.text || '').slice(0, 2000), always: !!body.always }) });
      }
      if (p === '/api/brain/delete') return send(res, 200, { ok: brain.remove(String(body.kind), String(body.id)) });
      return send(res, 404, { error: 'not found' });
    }

    if (p === '/api/state') return send(res, 200, st.snapshot());
    if (p === '/api/brain') return send(res, 200, brain.all());
    if (p === '/api/agents') return send(res, 200, profiles());

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const w = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      w('snapshot', st.snapshot());
      w('history', st.recentEvents());
      const onEvent = (e) => w('event', e);
      const onState = () => w('snapshot', st.snapshot());
      const onBrain = () => w('brain', brain.stats());
      st.bus.on('event', onEvent); st.bus.on('state', onState); st.bus.on('brain', onBrain);
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); st.bus.off('event', onEvent); st.bus.off('state', onState); st.bus.off('brain', onBrain); });
      return;
    }

    let m;
    if ((m = p.match(/^\/api\/factories\/(\w+)\/(files|file)$/))) {
      const f = factoryOf(m[1]);
      if (!f.run) return send(res, 200, m[2] === 'files' ? [] : '');
      const box = new Sandbox(f.run.workspace);
      if (m[2] === 'files') return send(res, 200, box.tree());
      const t = box.read(url.searchParams.get('path') || '', 60000);
      return t === null ? send(res, 404, { error: 'not found' }) : send(res, 200, t, 'text/plain; charset=utf-8');
    }

    const file = p === '/' ? 'index.html' : p.slice(1);
    const full = path.resolve(PUBLIC, file);
    if (full.startsWith(PUBLIC + path.sep) && fs.existsSync(full)) return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  TapMind Agents Foundry  →  http://127.0.0.1:${cfg.port}`);
  console.log('  Local only. Every write, command and push waits for your approval.\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { oc.stop(); process.exit(0); });

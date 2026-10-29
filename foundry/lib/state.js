'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const cfg = require('./config');
const brain = require('./brain');

const bus = new EventEmitter();
bus.setMaxListeners(50);
brain.events.on('change', () => bus.emit('brain'));

const AGENT_IDS = ['cartographer', 'spec', 'architect', 'design', 'planner', 'gate', 'test_author', 'coder', 'review', 'qa', 'handoff', 'ship'];

/** Every factory is an independent line: its own run, agents, approval queue and sandbox. */
const factories = new Map();
const FILE = path.join(cfg.ROOT, 'factories.json');
let seq = 0;

function resetAgents(f) {
  for (const id of AGENT_IDS) f.agents[id] = { state: 'idle', last: '', count: 0, model: '' };
}

function make({ id, name, x = 0, y = 0 }) {
  const f = { id, name, x, y, run: null, events: [], agents: {}, approvals: new Map(), allow: new Set() };
  resetAgents(f);
  factories.set(id, f);
  return f;
}

function save() {
  const list = [...factories.values()].map(({ id, name, x, y }) => ({ id, name, x, y }));
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch { /* non-fatal */ }
}

function load() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first start */ }
  if (!Array.isArray(list) || !list.length) list = [{ id: 'f1', name: 'Factory 1', x: 0, y: 0 }];
  list.forEach(make);
}
load();

let notifyTimer = null;
function touch() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; bus.emit('state'); }, 80);
}

function addFactory(name) {
  let n = 1;
  while (factories.has('f' + n)) n++;
  const f = make({ id: 'f' + n, name: (name || '').trim().slice(0, 40) || `Factory ${n}`, x: 0, y: (n - 1) * 640 });
  save(); touch();
  return f;
}

function removeFactory(id) {
  const f = factories.get(id);
  if (!f) return 'no such factory';
  if (f.run?.status === 'running') return 'abort the run first';
  if (factories.size === 1) return 'keep at least one factory';
  factories.delete(id);
  save(); touch();
  return null;
}

function patchFactory(id, { name, x, y }) {
  const f = factories.get(id);
  if (!f) return false;
  if (typeof name === 'string' && name.trim()) f.name = name.trim().slice(0, 40);
  if (Number.isFinite(x)) f.x = Math.round(x);
  if (Number.isFinite(y)) f.y = Math.round(y);
  save(); touch();
  return true;
}

class Aborted extends Error { constructor() { super('run aborted'); this.aborted = true; } }

function emit(f, agent, kind, text, extra = {}) {
  const e = { seq: ++seq, t: Date.now(), fid: f.id, agent, kind, text, ...extra };
  f.events.push(e);
  if (f.events.length > 1500) f.events.shift();
  if (f.run?.dir) {
    try { fs.appendFileSync(path.join(f.run.dir, 'events.jsonl'), JSON.stringify(e) + '\n'); } catch { /* ignore */ }
  }
  bus.emit('event', e);
  if (kind === 'brain') bus.emit('brain-pulse', e);
  return e;
}

function setAgent(f, id, patch) {
  Object.assign(f.agents[id], patch);
  if (patch.last !== undefined) f.agents[id].lastAt = Date.now();
  touch();
}

function bump(f, id, key = 'count') {
  f.agents[id][key] = (f.agents[id][key] || 0) + 1;
  touch();
}

/**
 * The permission broker. Every write, command, git operation, import, gate and Brain write goes
 * through here and blocks until the human answers in the UI. Returns { approved, text }.
 */
function ask(f, spec) {
  if (f.run?.abort.signal.aborted) return Promise.reject(new Aborted());
  const key = spec.always;
  if (key && f.allow.has(key)) {
    emit(f, spec.agent, 'auto', `auto-approved (${key}): ${spec.title}`);
    return Promise.resolve({ approved: true, text: '', auto: true });
  }
  const id = 'ap_' + Math.random().toString(36).slice(2, 9);
  return new Promise((resolve, reject) => {
    f.approvals.set(id, {
      id, fid: f.id, kind: spec.kind, agent: spec.agent, title: spec.title, detail: spec.detail || '',
      risks: spec.risks || [], input: spec.input || null, canAlways: !!key, alwaysKey: key || null,
      files: spec.files || null, createdAt: Date.now(), resolve, reject,
    });
    setAgent(f, spec.agent, { state: 'waiting', last: `waiting: ${spec.title}` });
    emit(f, spec.agent, 'ask', spec.title, { approvalId: id });
  });
}

function answer(id, { approve, text, always }) {
  for (const f of factories.values()) {
    const a = f.approvals.get(id);
    if (!a) continue;
    f.approvals.delete(id);
    if (approve && always && a.alwaysKey) f.allow.add(a.alwaysKey);
    emit(f, a.agent, approve ? 'approved' : 'denied', a.title + (text ? ` — "${text}"` : ''));
    setAgent(f, a.agent, { state: 'working', last: approve ? 'approved' : 'denied' });
    a.resolve({ approved: !!approve, text: text || '' });
    touch();
    return true;
  }
  return false;
}

function rejectAll(f) {
  for (const a of f.approvals.values()) a.reject(new Aborted());
  f.approvals.clear();
  touch();
}

function snapshotFactory(f) {
  const r = f.run;
  return {
    id: f.id, name: f.name, x: f.x, y: f.y,
    run: r && { id: r.id, task: r.task, status: r.status, startedAt: r.startedAt, stack: r.stack, steps: r.steps, doneSteps: r.doneSteps, workspace: r.workspace },
    agents: f.agents,
    approvals: [...f.approvals.values()].map(({ resolve, reject, ...a }) => a),
    allow: [...f.allow],
  };
}

function snapshot() {
  return { factories: [...factories.values()].map(snapshotFactory), brain: brain.stats(), models: cfg.models, seq };
}

/** Bind the per-factory helpers once so pipeline code reads naturally. */
function bind(f) {
  return {
    f,
    emit: (...a) => emit(f, ...a),
    setAgent: (...a) => setAgent(f, ...a),
    bump: (...a) => bump(f, ...a),
    ask: (spec) => ask(f, spec),
    rejectAll: () => rejectAll(f),
    resetAgents: () => resetAgents(f),
    touch,
  };
}

module.exports = {
  factories, bus, snapshot, answer, bind, touch, addFactory, removeFactory, patchFactory, Aborted, AGENT_IDS,
  recentEvents: (n = 400) => [...factories.values()].flatMap((f) => f.events).sort((a, b) => a.seq - b.seq).slice(-n),
};

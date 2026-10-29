'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { EventEmitter } = require('events');

/**
 * The Brain: one local store shared by every factory. Three collections:
 *   maps    - codebase maps from the Cartographer
 *   lessons - short rules approved by the human, injected into future agent prompts
 *   runs    - archive of finished runs (task, stack, verdict, files), recalled for similar tasks
 * Plain JSON under foundry/brain. Nothing is written without a human approval (see pipeline).
 */
const events = new EventEmitter();
const KINDS = ['maps', 'lessons', 'runs'];
const file = (k) => path.join(cfg.BRAIN_DIR, `${k}.json`);
const rid = () => 'b_' + Math.random().toString(36).slice(2, 9);

function read(kind) {
  let list;
  try { list = JSON.parse(fs.readFileSync(file(kind), 'utf8')); } catch { return []; }
  if (!Array.isArray(list)) return [];
  if (list.some((x) => !x.id)) { list = list.map((x) => (x.id ? x : { id: rid(), ...x })); write(kind, list); }
  return list;
}

function write(kind, list) {
  fs.mkdirSync(cfg.BRAIN_DIR, { recursive: true });
  fs.writeFileSync(file(kind), JSON.stringify(list, null, 2));
}

function add(kind, item) {
  if (!KINDS.includes(kind)) throw new Error('bad brain collection');
  const list = read(kind);
  const row = { id: rid(), at: Date.now(), ...item };
  list.push(row);
  write(kind, list);
  events.emit('change', { kind, op: 'add' });
  return row;
}

function remove(kind, id) {
  if (!KINDS.includes(kind)) return false;
  const list = read(kind);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  write(kind, next);
  events.emit('change', { kind, op: 'remove' });
  return true;
}

function stats() {
  return { maps: read('maps').length, lessons: read('lessons').length, runs: read('runs').length };
}

function all() {
  return { maps: read('maps'), lessons: read('lessons'), runs: read('runs') };
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);

/** Past runs whose task overlaps the new one (cheap keyword overlap; no network, no embeddings). */
function similar(task, limit = 2) {
  const w = words(task);
  return read('runs')
    .map((r) => {
      const rw = words(`${r.task} ${r.summary || ''}`);
      let score = 0;
      for (const x of w) if (rw.has(x)) score++;
      return { r, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
}

module.exports = { read, add, remove, stats, all, similar, events };

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const defaults = {
  host: '127.0.0.1', // never change this to 0.0.0.0; the foundry is local-only
  port: 8790,
  // provider/model as listed by `opencode models`. "judgement" agents get the stronger model.
  models: {
    fast: 'opencode/big-pickle',
    judgement: 'opencode/big-pickle',
  },
  maxSteps: 6,
  maxFixAttempts: 2,
  llmTimeoutMs: 10 * 60 * 1000,
  cmdTimeoutMs: 120 * 1000,
  opencodeBin: 'opencode',
};

let user = {};
try {
  user = JSON.parse(fs.readFileSync(path.join(ROOT, 'foundry.config.json'), 'utf8'));
} catch { /* optional */ }

module.exports = {
  ROOT,
  RUNS_DIR: path.join(ROOT, 'runs'),
  BRAIN_DIR: path.join(ROOT, 'brain'),
  ...defaults,
  ...user,
  models: { ...defaults.models, ...(user.models || {}) },
};

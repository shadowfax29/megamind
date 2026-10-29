'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RISK_PATTERNS = [
  [/child_process|\bexecSync?\(|\bspawn(Sync)?\(|subprocess|os\.system|\bpopen\(/i, 'spawns processes'],
  [/require\(\s*['"](node:)?(https?|net|dgram|tls|dns)['"]\s*\)|from\s+['"](node:)?(https?|net|dgram|tls|dns)['"]/, 'opens network sockets'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|urllib|requests\.(get|post)|import\s+socket|http\.client/, 'makes network requests'],
  [/\brm\s+-rf\b|fs\.rm(Sync)?\(|rmSync|unlinkSync|shutil\.rmtree|os\.remove/, 'deletes files'],
  [/process\.env|os\.environ|\.ssh|\.aws|credentials/i, 'reads environment / secrets'],
  [/(fs\.\w+|open|readFile\w*|writeFile\w*|path\.(join|resolve))\([^)\n]*\.\.[\\/]/, 'touches parent directories'],
];

function scanRisks(text) {
  const out = [];
  for (const [re, label] of RISK_PATTERNS) if (re.test(text)) out.push(label);
  return out;
}

class Sandbox {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Resolve a relative path, refusing anything that escapes the sandbox. */
  resolve(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('empty path');
    rel = rel.trim().replace(/\\/g, '/');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('~')) throw new Error(`absolute path refused: ${rel}`);
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`path escapes sandbox: ${rel}`);
    const segs = rel.split('/');
    if (segs.includes('.git') || segs.includes('node_modules')) throw new Error(`protected path: ${rel}`);
    return full;
  }

  exists(rel) { try { return fs.existsSync(this.resolve(rel)); } catch { return false; } }

  read(rel, max = 40000) {
    try { return fs.readFileSync(this.resolve(rel), 'utf8').slice(0, max); } catch { return null; }
  }

  write(rel, content) {
    const full = this.resolve(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  tree(dir = '', depth = 5) {
    const out = [];
    const walk = (rel, d) => {
      let names;
      try { names = fs.readdirSync(path.join(this.root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (d < depth) walk(r, d + 1); }
        else out.push(r);
      }
    };
    walk(dir, 0);
    return out.sort();
  }

  /** Copy an external folder in (caller must have obtained approval). */
  importFrom(src) {
    const skip = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);
    let n = 0;
    const walk = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip.has(e.name) || e.isSymbolicLink()) continue;
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isDirectory()) walk(a, b);
        else if (fs.statSync(a).size < 1_000_000) { fs.copyFileSync(a, b); n++; }
      }
    };
    walk(path.resolve(src), this.root);
    return n;
  }

  /**
   * Validate a test/run command. Only interpreter invocations of files inside the
   * sandbox are allowed: no -e / -c eval, no absolute paths, no parent traversal.
   */
  checkCommand(argv) {
    const [exe, ...args] = argv;
    const bad = (m) => { throw new Error(`command refused: ${m}`); };
    for (const a of args) {
      if (/^(\/|[a-zA-Z]:|~)/.test(a) && !a.startsWith('--')) bad(`absolute path "${a}"`);
      if (a.includes('..')) bad('parent traversal');
      if (/[|&;<>`$]/.test(a)) bad('shell metacharacters');
    }
    if (exe === 'node') {
      const evil = args.find((a) => /^(-e|--eval|-p|--print|-r|--require|--import|--input-type|--loader|--experimental-loader|--inspect.*)$/.test(a));
      if (evil) bad(`node flag ${evil}`);
      if (!args.length) bad('node needs a file or --test');
    } else if (exe === 'python') {
      if (args.includes('-c')) bad('python -c');
      const ok = (args[0] === '-m' && args[1] === 'unittest') || /\.py$/.test(args[0] || '');
      if (!ok) bad('only `python -m unittest ...` or `python file.py`');
    } else {
      bad(`executable "${exe}" is not on the allowlist (node, python)`);
    }
  }

  /** Run an interpreter command inside the sandbox with a scrubbed environment. */
  run(argv, timeoutMs, signal) {
    this.checkCommand(argv);
    return this._spawn(argv, timeoutMs, signal, {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: this.root, TMP: this.root,
      HOME: this.root, USERPROFILE: this.root, PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1',
    });
  }

  /** Git with a fixed subcommand allowlist. `network` runs get the real env so the user's credential helper works. */
  git(args, timeoutMs, signal) {
    const sub = args[0];
    const allowed = ['init', 'add', 'commit', 'status', 'log', 'diff', 'branch', 'remote', 'push', 'rev-parse', 'checkout'];
    if (!allowed.includes(sub)) throw new Error(`git ${sub} is not allowed`);
    const network = sub === 'push';
    const env = network ? { ...process.env } : {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: this.root, USERPROFILE: this.root,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const ident = ['-c', 'user.name=TapMind Foundry', '-c', 'user.email=foundry@localhost', '-c', 'core.autocrlf=false'];
    return this._spawn(['git', ...ident, ...args], timeoutMs, signal, env);
  }

  _spawn(argv, timeoutMs, signal, env) {
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(argv[0], argv.slice(1), { cwd: this.root, env, shell: false, windowsHide: true });
      const cap = (d) => { if (out.length < 60000) out += d.toString(); };
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `spawn error: ${e.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code: timedOut ? -2 : code, out: out + (timedOut ? '\n[timed out]' : '') });
      });
    });
  }
}

module.exports = { Sandbox, scanRisks };

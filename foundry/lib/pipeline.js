'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { bind, Aborted } = require('./state');
const brain = require('./brain');
const { Sandbox, scanRisks } = require('./sandbox');
const oc = require('./opencode');
const { AGENTS, parseFiles, parseJson, stripFences } = require('./agents');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
const clip = (s, n = 6000) => (s && s.length > n ? s.slice(0, n) + '\n…[truncated]' : s || '');

function startRun(f, { task, seed }) {
  if (f.run && f.run.status === 'running') throw new Error('this factory already has a run in progress');
  if (!task || task.trim().length < 5) throw new Error('describe the task (at least a sentence)');
  const st = bind(f);
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + f.id + '-' + slug(task);
  const dir = path.join(cfg.RUNS_DIR, id);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  st.resetAgents();
  f.events.length = 0;
  f.allow.clear();
  f.run = { id, task: task.trim(), status: 'running', startedAt: Date.now(), dir, workspace, stack: null, steps: [], doneSteps: 0, abort: new AbortController() };
  st.emit('gate', 'run', `Run ${id} started. Sandbox: ${workspace}`);
  fs.writeFileSync(path.join(dir, 'task.txt'), f.run.task);
  execute(st, f.run, new Sandbox(workspace), seed).then(
    () => finish(st, 'done'),
    (e) => {
      if (e.aborted) finish(st, 'aborted');
      else { st.emit('gate', 'error', `Run failed: ${e.message}`); finish(st, 'failed'); }
    },
  );
  return f.run;
}

function abortRun(f) {
  if (!f.run || f.run.status !== 'running') return false;
  f.run.abort.abort();
  bind(f).rejectAll();
  return true;
}

function finish(st, status) {
  const f = st.f;
  f.run.status = status;
  for (const id of Object.keys(f.agents)) if (f.agents[id].state !== 'error') st.setAgent(id, { state: status === 'done' ? 'done' : 'idle' });
  st.emit('gate', 'run', `Run ${status}.`);
  st.touch();
}

async function execute(st, run, box, seed) {
  const { emit, setAgent, bump, ask } = st;
  const signal = run.abort.signal;
  const lessons = brain.read('lessons').slice(-10).map((l) => `- ${l.text}`).join('\n');
  const lessonBlock = lessons ? `\n\nApproved lessons from earlier runs (Brain):\n${lessons}` : '';
  const check = () => { if (signal.aborted) throw new Aborted(); };

  // ---- helpers ---------------------------------------------------------------------------
  async function think(room, key, prompt, label) {
    check();
    const def = AGENTS[key];
    const model = cfg.models[def.tier] || cfg.models.fast;
    setAgent(room, { state: 'working', last: label || def.name, model });
    emit(room, 'think', `${def.name} → ${model}: ${label || 'working'}`);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await oc.chat({ system: def.system.replace('{MAXSTEPS}', cfg.maxSteps) + lessonBlock, prompt, model, signal, title: `${room}:${run.id}` });
        emit(room, 'result', `${def.name} replied (${r.tokens} tokens)`);
        return r.text;
      } catch (e) {
        if (signal.aborted) throw new Aborted();
        lastErr = e;
        emit(room, 'warn', `${def.name} call failed (${e.message}); ${attempt ? 'giving up' : 'retrying'}`);
      }
    }
    setAgent(room, { state: 'error', last: lastErr.message });
    throw lastErr;
  }

  /** Validate, preview and write files only after the human approves. */
  async function writeFiles(room, files, title) {
    const ok = [];
    for (const f of files) {
      try { box.resolve(f.path); ok.push(f); } catch (e) { emit(room, 'warn', `dropped file "${f.path}": ${e.message}`); }
    }
    if (!ok.length) return { written: [], denied: false, empty: true };
    const risks = [...new Set(ok.flatMap((f) => scanRisks(f.content)))];
    const res = await ask({
      kind: 'write', agent: room, title: `${title}: write ${ok.length} file(s) — ${ok.map((f) => f.path).join(', ')}`,
      files: ok.map((f) => ({ path: f.path, content: clip(f.content, 12000), isNew: !box.exists(f.path) })),
      risks, always: 'write', input: { label: 'Feedback if you deny (the agent will retry with it)' },
    });
    if (!res.approved) return { written: [], denied: true, feedback: res.text };
    for (const f of ok) box.write(f.path, f.content);
    bump(room, 'files');
    emit(room, 'write', `wrote ${ok.map((f) => f.path).join(', ')}`);
    return { written: ok.map((f) => f.path), denied: false };
  }

  /** Generate files with an agent, ask, and retry with human feedback on denial. */
  async function produceFiles(room, key, basePrompt, title) {
    let prompt = basePrompt;
    for (let round = 0; round < 3; round++) {
      const text = await think(room, key, prompt, title);
      const files = parseFiles(text);
      if (!files.length) {
        emit(room, 'warn', 'no file blocks in reply; asking again');
        prompt = basePrompt + `\n\nYour previous reply contained no valid file blocks. Follow the format exactly.`;
        continue;
      }
      const r = await writeFiles(room, files, title);
      if (!r.denied) return r;
      if (!r.feedback) return r;
      prompt = basePrompt + `\n\nThe human rejected your previous attempt with this feedback:\n${r.feedback}\nProduce a corrected version.`;
    }
    return { written: [], denied: true };
  }

  async function writeDoc(room, name, text) {
    const r = await writeFiles(room, [{ path: name, content: stripFences(text) }], name);
    return !r.denied;
  }

  async function cmd(room, argv, title) {
    check();
    const line = argv.join(' ');
    try { box.checkCommand(argv); } catch (e) { emit(room, 'warn', e.message); return { code: -1, out: e.message }; }
    const res = await ask({
      kind: 'cmd', agent: room, title: `${title || 'Run'}: ${line}`, detail: `cwd: ${box.root}\nEnvironment is scrubbed. Interpreter only, no shell.`,
      risks: [], always: `cmd:${line}`,
    });
    if (!res.approved) { emit(room, 'warn', `command denied: ${line}`); return { code: -3, out: 'command denied by human', denied: true }; }
    setAgent(room, { state: 'working', last: line });
    const r = await box.run(argv, cfg.cmdTimeoutMs, signal);
    emit(room, 'cmd', `$ ${line}  → exit ${r.code}\n${clip(r.out, 3000)}`);
    return r;
  }

  async function git(room, args, title, opts = {}) {
    check();
    const line = 'git ' + args.join(' ');
    if (!opts.silent) {
      const res = await ask({
        kind: 'git', agent: room, title: `${title || 'Git'}: ${line}`, detail: opts.detail || `cwd: ${box.root}`,
        risks: opts.risks || [], always: opts.network ? null : `git:${args[0]}`,
      });
      if (!res.approved) return { code: -3, out: 'denied', denied: true };
    }
    const r = await box.git(args, cfg.cmdTimeoutMs, signal);
    emit(room, 'cmd', `$ ${line}  → exit ${r.code}\n${clip(r.out, 1500)}`);
    return r;
  }

  const testCmd = () => (run.stack === 'python' ? ['python', '-m', 'unittest', 'discover', '-v'] : ['node', '--test']);

  // ---- 0. import + git init --------------------------------------------------------------
  if (seed) {
    const abs = path.resolve(seed);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`seed folder not found: ${abs}`);
    const res = await ask({
      kind: 'import', agent: 'cartographer', title: `Copy an existing project INTO the sandbox: ${abs}`,
      detail: 'Files (excluding .git, node_modules, build output, symlinks, files > 1MB) are copied. The original is never modified.',
      risks: ['reads outside the sandbox'],
    });
    if (!res.approved) throw new Aborted();
    emit('cartographer', 'write', `imported ${box.importFrom(abs)} files from ${abs}`);
  }
  await git('ship', ['init'], 'Initialise repo');

  // ---- 1. cartographer -------------------------------------------------------------------
  setAgent('cartographer', { state: 'working', last: 'mapping workspace' });
  const tree = box.tree();
  let map = 'GREENFIELD';
  if (tree.length) {
    const key = ['package.json', 'README.md', 'pyproject.toml'].filter((f) => box.exists(f)).map((f) => `--- ${f}\n${clip(box.read(f), 2000)}`).join('\n');
    map = await think('cartographer', 'cartographer', `File tree:\n${tree.slice(0, 200).join('\n')}\n\n${key}`, 'mapping codebase');
  }
  emit('cartographer', 'result', map === 'GREENFIELD' ? 'Greenfield project: nothing to map.' : map);
  // Brain recall (read-only, local): earlier runs with a similar task.
  const recalled = brain.similar(run.task);
  let recallBlock = '';
  if (recalled.length) {
    recallBlock = `\n\nSIMILAR PAST RUNS FROM THE BRAIN (for reference, do not copy blindly):\n${recalled.map((r) => `- "${r.task}" (${r.stack}, QA ${r.verdict}): ${clip(r.summary || '', 400)}`).join('\n')}`;
    emit('cartographer', 'brain', `Brain recalled ${recalled.length} similar run(s): ${recalled.map((r) => r.task.slice(0, 50)).join(' | ')}`);
  }
  bump('cartographer', 'maps');
  setAgent('cartographer', { state: 'done', last: `${tree.length} files mapped${recalled.length ? ` · recalled ${recalled.length}` : ''}` });

  // ---- 2. spec ---------------------------------------------------------------------------
  const projectCtx = `TASK:\n${run.task}\n\nEXISTING CODEBASE MAP:\n${map}${recallBlock}`;
  let specText = await think('spec', 'spec', projectCtx, 'writing SPEC');
  if (/^NEEDS_INPUT:/m.test(specText)) {
    const qs = specText.split('\n').filter((l) => /^\s*[-*]/.test(l)).map((l) => l.replace(/^\s*[-*]\s*/, '')).slice(0, 3);
    const answers = [];
    for (const q of qs) {
      const r = await ask({ kind: 'question', agent: 'spec', title: `Spec needs your input: ${q}`, input: { label: 'Your answer' } });
      answers.push(`Q: ${q}\nA: ${r.text || '(no answer; use your best judgement)'}`);
    }
    specText = await think('spec', 'spec', `${projectCtx}\n\nClarifications from the human:\n${answers.join('\n')}\n\nNow write the spec.`, 'writing SPEC');
  }
  specText = stripFences(specText);
  if (!(await writeDoc('spec', 'SPEC.md', specText))) throw new Aborted();
  bump('spec', 'specs');
  setAgent('spec', { state: 'done', last: 'SPEC.md written' });

  // ---- 3. architect ----------------------------------------------------------------------
  const archText = stripFences(await think('architect', 'architect', `${projectCtx}\n\nSPEC:\n${specText}`, 'designing architecture'));
  run.stack = /^STACK:\s*python/im.test(archText) ? 'python' : 'node';
  emit('architect', 'result', `stack: ${run.stack}`);
  if (!(await writeDoc('architect', 'ARCHITECTURE.md', archText))) throw new Aborted();
  setAgent('architect', { state: 'done', last: `stack: ${run.stack}` });

  // ---- 4. design -------------------------------------------------------------------------
  const designText = stripFences(await think('design', 'design', `${projectCtx}\n\nSPEC:\n${specText}\n\nARCHITECTURE:\n${archText}`, 'drafting DESIGN'));
  if (!(await writeDoc('design', 'DESIGN.md', designText))) throw new Aborted();
  bump('design', 'designs');
  setAgent('design', { state: 'done', last: 'DESIGN.md written' });

  // ---- 5. planner + Gate A ---------------------------------------------------------------
  const docs = `SPEC:\n${clip(specText, 4000)}\n\nARCHITECTURE:\n${clip(archText, 4000)}\n\nDESIGN:\n${clip(designText, 2500)}`;
  let plan = null, feedback = '';
  for (let attempt = 0; attempt < 3 && !plan; attempt++) {
    let steps;
    for (let tries = 0; tries < 2 && !steps; tries++) {
      const raw = await think('planner', 'planner', `${docs}\n\nStack: ${run.stack}${feedback ? `\n\nHuman feedback on the previous plan (apply it):\n${feedback}` : ''}${tries ? '\n\nReturn ONLY valid JSON.' : ''}`, 'planning steps');
      try {
        const j = parseJson(raw);
        steps = (j.steps || []).slice(0, cfg.maxSteps).filter((s) => s.title && s.impl_files?.length && s.test_files?.length);
        if (!steps.length) steps = undefined;
      } catch (e) { emit('planner', 'warn', `plan was not valid JSON: ${e.message}`); }
    }
    if (!steps) throw new Error('planner could not produce a valid plan');
    steps = steps.map((s, i) => ({ ...s, id: i + 1, status: 'pending' }));
    const text = steps.map((s) => `${s.id}. ${s.title}\n   impl: ${s.impl_files.join(', ')}\n   tests: ${s.test_files.join(', ')}\n   ${s.notes || ''}`).join('\n');
    setAgent('planner', { state: 'done', last: `${steps.length} steps planned` });
    run.steps = steps;
    st.touch();
    const gate = await ask({ kind: 'gate', agent: 'gate', title: `Gate A — approve the plan (${steps.length} steps)?`, detail: text, input: { label: 'Feedback (if rejecting, the planner revises)' } });
    if (gate.approved) { plan = steps; fs.writeFileSync(path.join(box.root, 'PLAN.md'), `# Plan\n\n${text}\n`); }
    else if (!gate.text) throw new Aborted();
    else feedback = gate.text;
  }
  if (!plan) throw new Error('plan not approved after 3 revisions');
  setAgent('gate', { state: 'done', last: 'Gate A approved' });

  // ---- 6. build loop ---------------------------------------------------------------------
  for (const step of plan) {
    check();
    step.status = 'building';
    emit('coder', 'step', `Step ${step.id}/${plan.length}: ${step.title}`);
    const stepCtx = `${docs}\n\nSTACK: ${run.stack}\nSTEP ${step.id}: ${step.title}\nimpl files: ${step.impl_files.join(', ')}\ntest files: ${step.test_files.join(', ')}\nnotes: ${step.notes || ''}\n\nCurrent workspace files:\n${box.tree().join('\n')}`;

    const t = await produceFiles('test_author', 'test_author', `${stepCtx}\n\nWrite the test file(s) for this step now.`, `Step ${step.id} tests`);
    bump('test_author', 'tests');
    const testSrc = [...new Set([...step.test_files, ...t.written])].map((p) => `--- ${p}\n${clip(box.read(p) || '', 6000)}`).join('\n');
    setAgent('test_author', { last: `step ${step.id} tests ${t.denied ? 'denied' : 'written'}` });

    const c = await produceFiles('coder', 'coder', `${stepCtx}\n\nTests to satisfy:\n${testSrc}\n\nExisting implementation files:\n${step.impl_files.map((p) => `--- ${p}\n${box.read(p) || '(new)'}`).join('\n')}\n\nImplement the step now.`, `Step ${step.id} code`);
    setAgent('coder', { last: `step ${step.id} ${c.denied ? 'denied' : 'implemented'}` });

    let result = await cmd('review', testCmd(), `Step ${step.id} tests`);
    for (let fix = 1; result.code !== 0 && !result.denied && fix <= cfg.maxFixAttempts; fix++) {
      bump('review', 'attempts');
      const files = [...new Set([...step.impl_files, ...step.test_files])].map((p) => `--- ${p}\n${clip(box.read(p) || '(missing)', 6000)}`).join('\n');
      const diagnosis = await think('review', 'reviewer', `${stepCtx}\n\nTest output (exit ${result.code}):\n${clip(result.out, 4000)}\n\nFiles:\n${files}`, `diagnosing step ${step.id} (attempt ${fix})`);
      emit('review', 'result', diagnosis);
      await produceFiles('review', 'fixer', `${stepCtx}\n\nReviewer diagnosis:\n${diagnosis}\n\nTest output:\n${clip(result.out, 3000)}\n\nFiles:\n${files}\n\nReturn the corrected full files.`, `Step ${step.id} fix #${fix}`);
      result = await cmd('review', testCmd(), `Step ${step.id} re-test`);
    }
    if (result.code !== 0 && !result.denied) {
      const g = await ask({ kind: 'gate', agent: 'review', title: `Step ${step.id} still failing after ${cfg.maxFixAttempts} fix attempts. Give a hint to try once more, or deny to continue anyway.`, detail: clip(result.out, 3000), input: { label: 'Hint for the fixer' } });
      if (g.approved && g.text) {
        const files = [...new Set([...step.impl_files, ...step.test_files])].map((p) => `--- ${p}\n${clip(box.read(p) || '(missing)', 6000)}`).join('\n');
        await produceFiles('review', 'fixer', `${stepCtx}\n\nHuman hint:\n${g.text}\n\nTest output:\n${clip(result.out, 3000)}\n\nFiles:\n${files}\n\nReturn the corrected full files.`, `Step ${step.id} guided fix`);
        result = await cmd('review', testCmd(), `Step ${step.id} re-test`);
      }
    }
    step.status = result.code === 0 ? 'done' : 'failing';
    run.doneSteps = plan.filter((s) => s.status === 'done').length;
    bump('review', 'reviews');
    setAgent('review', { last: `step ${step.id} ${step.status}` });
    emit('coder', 'step', `Step ${step.id} ${step.status}`);

    await git('ship', ['add', '-A'], `Stage step ${step.id}`);
    await git('ship', ['commit', '-m', `step ${step.id}: ${step.title}${step.status === 'failing' ? ' (tests failing)' : ''}`], `Commit step ${step.id}`);
    bump('coder', 'commits');
  }
  setAgent('test_author', { state: 'done' }); setAgent('coder', { state: 'done' });

  // ---- 7. QA -----------------------------------------------------------------------------
  const full = await cmd('qa', testCmd(), 'Full test suite');
  const qaText = stripFences(await think('qa', 'qa', `SPEC:\n${clip(specText, 4000)}\n\nFull test output (exit ${full.code}):\n${clip(full.out, 5000)}\n\nFiles:\n${box.tree().join('\n')}`, 'verifying acceptance criteria'));
  await writeDoc('qa', 'QA.md', qaText);
  const verdict = /VERDICT:\s*PASS/i.test(qaText) && full.code === 0 ? 'PASS' : 'FAIL';
  setAgent('qa', { state: 'done', last: `verdict ${verdict}` });
  emit('qa', 'result', `QA verdict: ${verdict}`);

  // ---- 8. handoff + lessons --------------------------------------------------------------
  const hand = await think('handoff', 'handoff', `Task: ${run.task}\nStack: ${run.stack}\nSteps: ${plan.map((s) => `${s.id}. ${s.title} [${s.status}]`).join('; ')}\nQA verdict: ${verdict}\nFiles:\n${box.tree().join('\n')}`, 'writing HANDOFF');
  const [handDoc, lessonPart = ''] = hand.split(/^LESSONS:\s*$/m);
  await writeDoc('handoff', 'HANDOFF.md', handDoc);
  const lessons2 = lessonPart.split('\n').filter((l) => /^\s*[-*]/.test(l)).map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).slice(0, 3);
  const summary = clip(handDoc.replace(/\s+/g, ' ').trim(), 700);
  const brainRes = await ask({
    kind: 'brain', agent: 'handoff', title: 'Store this run in the Brain (shared by all factories, recalled for similar tasks)?',
    detail: `RUN SUMMARY\n  task: ${run.task}\n  stack: ${run.stack}, QA ${verdict}, ${box.tree().length} files, steps ${run.doneSteps}/${plan.length}\n  ${summary}\n\nCODEBASE MAP\n  ${clip(map, 300)}\n\nLESSONS (injected into every future agent prompt)\n${lessons2.length ? lessons2.map((l) => `  - ${l}`).join('\n') : '  (none proposed)'}`,
    input: { label: 'Optional: edit/add a lesson (one line) to store as well' },
  });
  if (brainRes.approved) {
    const src = { run: run.id, factory: st.f.name };
    brain.add('runs', { ...src, task: run.task, stack: run.stack, verdict, files: box.tree().length, steps: `${run.doneSteps}/${plan.length}`, summary });
    brain.add('maps', { ...src, task: run.task, files: box.tree().length, summary: clip(map === 'GREENFIELD' ? `Built from scratch: ${box.tree().join(', ')}` : map, 1500) });
    [...lessons2, brainRes.text.trim()].filter(Boolean).forEach((text) => brain.add('lessons', { ...src, text }));
    emit('handoff', 'brain', 'Stored run, map and lessons in the Brain.');
    bump('handoff', 'brain');
  }
  setAgent('handoff', { state: 'done', last: 'HANDOFF.md written' });
  await git('ship', ['add', '-A'], 'Stage docs');
  await git('ship', ['commit', '-m', 'docs: spec, architecture, design, QA, handoff'], 'Commit docs');

  // ---- 9. Gate B: push to GitHub ---------------------------------------------------------
  const log = (await git('ship', ['log', '--oneline'], '', { silent: true })).out;
  const gateB = await ask({
    kind: 'push', agent: 'ship', title: `Gate B — QA ${verdict}. Push to GitHub?`,
    detail: `Commits:\n${log}\nFiles:\n${box.tree().join('\n')}\n\nNothing leaves this machine unless you approve and give a remote URL. Leave the URL blank to keep everything local at:\n${box.root}`,
    input: { label: 'GitHub remote URL, e.g. https://github.com/you/repo.git' },
  });
  const url = (gateB.text || '').trim();
  if (!gateB.approved || !url) {
    setAgent('ship', { state: 'done', last: 'kept local' });
    emit('ship', 'result', `Kept local. Repo is at ${box.root}`);
    return;
  }
  if (!/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?|git@github\.com:[\w.-]+\/[\w.-]+(\.git)?)$/.test(url)) throw new Error(`remote must be a github.com URL, got: ${url}`);
  const conf = await ask({
    kind: 'push', agent: 'ship', title: `FINAL CONFIRM — send this repo to ${url}`,
    detail: `Will run:\n  git branch -M main\n  git remote add origin ${url}\n  git push -u origin main\n\nPush uses your machine's existing git credentials.`,
    risks: ['NETWORK: uploads the repository to github.com'],
  });
  if (!conf.approved) { emit('ship', 'result', 'Push cancelled; repo kept local.'); setAgent('ship', { state: 'done', last: 'push cancelled' }); return; }
  await git('ship', ['branch', '-M', 'main'], '', { silent: true });
  await git('ship', ['remote', 'add', 'origin', url], '', { silent: true });
  const push = await git('ship', ['push', '-u', 'origin', 'main'], '', { silent: true, network: true });
  if (push.code !== 0) { setAgent('ship', { state: 'error', last: 'push failed' }); throw new Error(`git push failed:\n${clip(push.out, 800)}`); }
  setAgent('ship', { state: 'done', last: 'pushed to GitHub' });
  emit('ship', 'result', `Pushed to ${url}`);
}

module.exports = { startRun, abortRun };

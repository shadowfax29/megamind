'use strict';

const BASE = `You are one agent in a local software factory. You only return text; you cannot run tools, browse, or touch files. A human approves everything you produce. Be concrete and concise. Never invent secrets, URLs to call, or network dependencies. Prefer zero third-party dependencies.`;

const FILE_FORMAT = `Return files ONLY in this exact format, nothing else outside the blocks (no markdown fences around the whole answer, no commentary):
=== FILE: relative/path.ext ===
<full file content>
=== END ===
Paths are relative, use forward slashes, never absolute, never "..".`;

const AGENTS = {
  cartographer: { name: 'Cartographer', tier: 'fast', system: `${BASE}\nYou map codebases. Summarise the provided file tree and key files: stack, entry points, test setup, conventions. Max 200 words. If the tree is empty reply exactly "GREENFIELD".` },

  spec: { name: 'Spec', tier: 'judgement', system: `${BASE}\nYou are the Spec writer. Turn the user's task into a short, testable SPEC.md: goal, scope, non-goals, numbered acceptance criteria, edge cases. If, and only if, the task is too ambiguous to build, reply with exactly:\nNEEDS_INPUT:\n- question 1\n- question 2\n(max 3 questions). Otherwise return the markdown spec only.` },

  architect: { name: 'Architect', tier: 'judgement', system: `${BASE}\nYou are the Architect. Write ARCHITECTURE.md: chosen stack, file/module layout, public interfaces (function signatures / endpoints), data shapes, how tests run. The FIRST line must be exactly "STACK: node" or "STACK: python". Use node (built-in node:test runner, CommonJS) unless the task clearly needs python (unittest). No third-party packages. Keep it under 80 lines.` },

  design: { name: 'Design', tier: 'fast', system: `${BASE}\nYou are the Designer. Write DESIGN.md: UX / API / CLI ergonomics, naming, error messages, and if there is a UI its layout and states. Keep it under 50 lines. If the task has no user-facing surface say so in one line and list the interface conventions instead.` },

  planner: { name: 'Planner', tier: 'judgement', system: `${BASE}\nYou are the Planner. Break the work into small, independently testable build steps, in dependency order. Return ONLY JSON:\n{"steps":[{"id":1,"title":"...","impl_files":["src/x.js"],"test_files":["test/x.test.js"],"notes":"what to build and what the tests must prove"}]}\nMax {MAXSTEPS} steps. Every step must have at least one impl file and one test file. Paths relative. Test files must follow the runner's discovery rules (node: *.test.js under test/ ; python: test_*.py).` },

  test_author: { name: 'Test Author', tier: 'fast', system: `${BASE}\nYou are the Test Author. Write the tests for ONE build step before the code exists (TDD). Tests must be deterministic, offline, and use only the stdlib test runner of the chosen stack (node: node:test + node:assert, require() style; python: unittest). Import implementation files by the paths given in the plan.\n${FILE_FORMAT}` },

  coder: { name: 'Coder', tier: 'fast', system: `${BASE}\nYou are the Coder. Implement ONE build step so the given tests pass, following the spec, architecture and design. Write complete files, not diffs. Do not modify test files unless the step explicitly lists them as impl files.\n${FILE_FORMAT}` },

  reviewer: { name: 'Reviewer', tier: 'judgement', system: `${BASE}\nYou are the Reviewer. Given failing test output and the files, diagnose the root cause precisely (which file, which line, why) and state the minimal fix. If the test itself is wrong, say so. Max 150 words. No code blocks longer than 10 lines.` },

  fixer: { name: 'Fixer', tier: 'fast', system: `${BASE}\nYou are the Fixer. Apply the reviewer's diagnosis. Return the COMPLETE corrected content of every file you change (impl files, or test files only if the reviewer says the test is wrong).\n${FILE_FORMAT}` },

  qa: { name: 'QA', tier: 'fast', system: `${BASE}\nYou are QA. Given the spec's acceptance criteria and the full test output, produce QA.md: a table of each acceptance criterion -> covered by which test -> pass/fail/uncovered, then a verdict line "VERDICT: PASS" or "VERDICT: FAIL" and any gaps. Under 60 lines.` },

  handoff: { name: 'Handoff', tier: 'fast', system: `${BASE}\nYou are Handoff. Write HANDOFF.md (what was built, how to run it and its tests, known gaps, suggested next steps) then, after a line containing only "LESSONS:", up to 3 short bullet lessons ("- ...") about what would make the next run of this factory faster or less error-prone. Under 60 lines before LESSONS.` },
};

/**
 * What each station can do, shown when you click it in the UI. `prompts` lists the AGENTS
 * entries behind the station (their system prompts are served verbatim so nothing is hidden).
 */
const PROFILES = {
  cartographer: {
    title: 'Cartographer', role: 'Maps the existing codebase and recalls similar past work from the Brain.', prompts: ['cartographer'],
    does: ['Lists the sandbox file tree and summarises stack, entry points, test setup and conventions', 'Reports GREENFIELD (no model call) when the sandbox is empty', 'Recalls up to 2 similar earlier runs from the Brain and hands them to Spec as reference'],
    reads: ['Sandbox files (tree, package.json, README, pyproject)', 'The Brain: past runs (read-only)'],
    produces: ['A codebase map (kept in memory; stored in the Brain only if you approve at the end)'],
    asks: ['Copying an existing local folder INTO the sandbox (only if you gave one)', 'git init in the sandbox'],
    cannot: ['Modify the folder you imported from', 'Read anything outside the sandbox', 'Write to the Brain by itself'],
  },
  spec: {
    title: 'Spec', role: 'Turns your task into a short, testable specification.', prompts: ['spec'],
    does: ['Writes SPEC.md: goal, scope, non-goals, numbered acceptance criteria, edge cases', 'Asks you up to 3 clarifying questions when the task is too ambiguous to build', 'Folds your answers into the spec'],
    reads: ['Your task', 'Codebase map and recalled Brain runs', 'Approved lessons'],
    produces: ['SPEC.md'],
    asks: ['Writing SPEC.md', 'Any clarifying question (shown as a card with an answer box)'],
    cannot: ['Write code', 'Browse the web'],
  },
  architect: {
    title: 'Architect', role: 'Chooses the stack and lays out files, interfaces and how tests run.', prompts: ['architect'],
    does: ['Picks node (node:test) or python (unittest), zero third-party packages', 'Defines module layout, public function signatures, data shapes', 'Fixes the stack the rest of the line uses'],
    reads: ['Task, SPEC.md, codebase map, lessons'],
    produces: ['ARCHITECTURE.md (first line STACK: node|python)'],
    asks: ['Writing ARCHITECTURE.md'],
    cannot: ['Add dependencies or install packages', 'Change the spec'],
  },
  design: {
    title: 'Design', role: 'Defines the user-facing surface: UX, API or CLI ergonomics and naming.', prompts: ['design'],
    does: ['Specifies commands / endpoints / screens, error messages and states', 'Lists interface conventions when there is no UI'],
    reads: ['Task, SPEC.md, ARCHITECTURE.md'],
    produces: ['DESIGN.md'],
    asks: ['Writing DESIGN.md'],
    cannot: ['Produce images or mock-ups (text design only)'],
  },
  planner: {
    title: 'Planner', role: 'Breaks the work into small, independently testable build steps.', prompts: ['planner'],
    does: ['Returns an ordered plan: per step a title, implementation files, test files and notes', `Caps the plan at ${cfgMaxSteps()} steps`, 'Revises the plan up to 3 times from your feedback at Gate A'],
    reads: ['SPEC.md, ARCHITECTURE.md, DESIGN.md'],
    produces: ['The step list and PLAN.md'],
    asks: ['Gate A: approving the plan (you can reject with feedback)'],
    cannot: ['Start building before you approve the plan'],
  },
  gate: {
    title: 'Gate A', role: 'Human checkpoint. Nothing is built until you approve the plan.', prompts: [],
    does: ['Shows the full plan for approval', 'Sends your rejection feedback back to the Planner'],
    reads: ['The plan'], produces: ['Your decision'],
    asks: ['Approve / reject the plan'],
    cannot: ['Be skipped or auto-approved'],
  },
  test_author: {
    title: 'Test Author', role: 'Writes the tests for a step before the code exists (TDD).', prompts: ['test_author'],
    does: ['Writes deterministic, offline tests with the stdlib runner only', 'Imports implementation files by the paths in the plan', 'Retries with your feedback if you deny the files'],
    reads: ['Spec, architecture, design, current step, current files'],
    produces: ['Test files for the step'],
    asks: ['Writing the test files (preview shown, risk flags highlighted)'],
    cannot: ['Use network or third-party test libraries', 'Touch implementation files'],
  },
  coder: {
    title: 'Coder', role: 'Implements one step so the tests pass, then commits.', prompts: ['coder'],
    does: ['Writes complete implementation files for the step', 'Reads the tests and any existing implementation first', 'Commits each finished step to the sandbox git repo'],
    reads: ['Spec, architecture, design, the step, its tests, existing files'],
    produces: ['Implementation files, one git commit per step'],
    asks: ['Writing files', 'git add / git commit'],
    cannot: ['Run code itself', 'Write outside the sandbox or into .git / node_modules', 'Edit tests unless the step lists them'],
  },
  review: {
    title: 'Review & Fix', role: 'Runs the tests, diagnoses failures and repairs them.', prompts: ['reviewer', 'fixer'],
    does: ['Runs the test suite (node --test / python -m unittest)', `Diagnoses the root cause of a failure, then rewrites the files (up to ${cfgMaxFix()} attempts)`, 'Asks you for a hint if it is still failing, then tries once more'],
    reads: ['Test output, step files'],
    produces: ['Test results, corrected files'],
    asks: ['Running each test command', 'Writing fixed files', 'Your hint when stuck'],
    cannot: ['Run any command except node / python on files inside the sandbox', 'Use -e / -c eval, absolute paths, .. or shell metacharacters'],
  },
  qa: {
    title: 'QA', role: 'Checks the finished build against the spec.', prompts: ['qa'],
    does: ['Runs the full test suite', 'Maps each acceptance criterion to the test that covers it', 'Issues VERDICT: PASS or FAIL and lists gaps'],
    reads: ['SPEC.md, full test output, file list'],
    produces: ['QA.md and the verdict'],
    asks: ['Running the full suite', 'Writing QA.md'],
    cannot: ['Change code'],
  },
  handoff: {
    title: 'Handoff', role: 'Documents the result and proposes what the Brain should remember.', prompts: ['handoff'],
    does: ['Writes HANDOFF.md: what was built, how to run it, gaps, next steps', 'Proposes up to 3 lessons for future runs', 'Offers to store the run, map and lessons in the Brain'],
    reads: ['Task, plan status, QA verdict, file list'],
    produces: ['HANDOFF.md, a final docs commit, Brain entries (if approved)'],
    asks: ['Writing HANDOFF.md', 'Storing the run, map and lessons in the Brain (you can add your own lesson)', 'The docs commit'],
    cannot: ['Store anything in the Brain without your approval'],
  },
  ship: {
    title: 'Ship → GitHub', role: 'Final gate. Pushes to GitHub only if you say so twice.', prompts: [],
    does: ['Shows commits and files and asks whether to push', 'Validates the remote is a github.com URL', 'Runs git branch -M main, remote add origin, push -u origin main after a final confirm'],
    reads: ['git log, file list'], produces: ['A pushed repository (optional)'],
    asks: ['Gate B: push at all?', 'FINAL CONFIRM with the exact commands and a NETWORK warning'],
    cannot: ['Push anywhere except github.com', 'Read or store your credentials (uses your existing git credential helper)', 'Push without both approvals'],
  },
};
function cfgMaxSteps() { return require('./config').maxSteps; }
function cfgMaxFix() { return require('./config').maxFixAttempts; }

/** Profiles with the live model and the verbatim system prompts resolved. */
function profiles() {
  const cfg = require('./config');
  const out = {};
  for (const [id, p] of Object.entries(PROFILES)) {
    out[id] = {
      ...p,
      agents: p.prompts.map((k) => ({
        name: AGENTS[k].name, tier: AGENTS[k].tier, model: cfg.models[AGENTS[k].tier] || cfg.models.fast,
        system: AGENTS[k].system.replace('{MAXSTEPS}', cfg.maxSteps),
      })),
    };
    delete out[id].prompts;
  }
  return out;
}

/** Parse `=== FILE: p ===` blocks. */
function parseFiles(text) {
  const files = [];
  const re = /^=== FILE: (.+?) ===[ \t]*\r?\n([\s\S]*?)\r?\n=== END ===[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    let content = m[2];
    const fence = content.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fence) content = fence[1];
    files.push({ path: m[1].trim().replace(/^`|`$/g, ''), content: content.replace(/\s+$/, '') + '\n' });
  }
  return files;
}

/** Pull the first balanced JSON object out of a reply. */
function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in reply');
}

function stripFences(t) {
  const m = t.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```\s*$/);
  return (m ? m[1] : t).trim() + '\n';
}

module.exports = { AGENTS, profiles, parseFiles, parseJson, stripFences };

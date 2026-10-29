# TapMind Agents Foundry

A local software factory. You describe a task; a line of agents takes it from planning to a pushed GitHub repo.
Everything runs on your machine, and **nothing happens without your click.**

```
Cartographer → Spec → Architect → Design → Planner → Gate A (you)
   → per step: Test Author → Coder → test run → Reviewer/Fixer loop → commit
   → QA → Handoff (+ lessons) → Gate B (you) → push to GitHub
```

## Run it

```
cd megamind
npm start            # or: node foundry/server.js
```
Open http://127.0.0.1:8790, type the task, press **Start the line**. Needs Node 20+ and `opencode` on PATH (already logged in / using its free models).

## How the rules you asked for are enforced

| Requirement | How |
|---|---|
| Asks permission for everything | One broker (`lib/state.js` `ask()`) blocks every file write, command, git operation, folder import, lesson save and push until you answer in the UI. "Approve all of this kind for this run" is opt-in, per kind, and never offered for pushes. |
| Stays in a local sandbox | Each run lives in `foundry/runs/<id>/workspace`. All paths are resolved against it; absolute paths, `..`, `.git` and `node_modules` are refused. Commands are interpreter-only (`node`, `python`), no shell, no `-e`/`-c`, scrubbed environment. Git is allow-listed. |
| Nothing leaves unless you say so | The web server binds `127.0.0.1` only, checks the Host header (anti DNS-rebinding) and requires a custom header on POSTs. The only egress is the model call and, if you approve twice at Gate B, `git push`. Files with network/process/delete patterns are flagged red in the approval card. |
| Uses the OpenCode API | The foundry starts a private `opencode serve` on a random loopback port and sends each agent's prompt through its session API with **tools disabled**, so the model can only return text; the foundry applies it after you approve. |
| Local info only | Agents see only the task, the sandbox contents and lessons you approved. The optional "existing folder" import copies files *into* the sandbox after you approve it; the original is never touched. |

## Honest limits

- It is a process-level sandbox, not a VM. Approved code runs as you, with a scrubbed env, and node/python can still open network sockets if code you approved does so. The risk flags exist so you can spot that before approving. For hard isolation, run the foundry inside Docker/WSL with networking off.
- `git push` uses your machine's existing git credentials. The foundry never reads or stores tokens.

## Config

Optional `foundry.config.json` in the repo root:
```json
{ "models": { "fast": "opencode/big-pickle", "judgement": "opencode/big-pickle" }, "maxSteps": 6, "maxFixAttempts": 2 }
```
List available models with `opencode models`. "judgement" agents (Spec, Architect, Planner, Reviewer) use the `judgement` model, the rest use `fast`.

## Layout

- `foundry/server.js`: HTTP + SSE + approval API
- `foundry/lib/pipeline.js`: the agent line and gates
- `foundry/lib/agents.js`: agent prompts and output parsers
- `foundry/lib/sandbox.js`: path confinement, command and git policy, risk scan
- `foundry/lib/opencode.js`: private OpenCode server client
- `foundry/public/index.html`: the floor UI
- `foundry/brain/`: codebase maps and lessons you approved (local JSON)
- `foundry/runs/`: one folder per run (workspace, events log)

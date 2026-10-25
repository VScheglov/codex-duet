#!/usr/bin/env node
// Fake `codex` for tests: replays scripted reviewer replies and records every call.
//   FAKE_CODEX_SCRIPT  JSON array, one entry per call:
//                        {"reply": {...}}                   answer
//                        {"reply": {...}, "delayMs": 1500}  answer after a pause
//                        {"hang": true}                     never answer (dies on SIGTERM)
//                        {"hang": true, "ignoreTerm": true} never answer, ignore SIGTERM
//                        {"fail": "message"}                exit 1 with the message on stderr
//                      any entry may add "descendant": "stdout" | "quiet": a child that ignores
//                      SIGTERM and either keeps our stdout open or holds no pipe at all,
//                      "write": {"file": "text"}: files the implementer writes (build mode),
//                      "commands": [{"command": "node --test", "exit_code": 0, "status": "completed"}]:
//                      shell events only (never executed); completed: false emits just the start,
//                      rawCommand overrides the usual /bin/zsh -lc wrapper for shell-format tests,
//                      and "tier": "priority": the service tier logged for the turn, as Codex 0.160 logs it
//                      in $CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl before the thread is named;
//                      a "hang" entry with "started": true names its thread (and logs a "tier") first,
//                      like a Codex cut off midway through its work
//   FAKE_CODEX_STATE   JSON file where calls (args, prompt, cwd) are appended; descendants' pids go to <file>.pids
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const script = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCRIPT, 'utf8'));
const statePath = process.env.FAKE_CODEX_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { calls: [] };
const step = script[state.calls.length];
state.calls.push({ args, prompt, cwd: process.cwd() });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

// Like a stuck MCP server: ignores SIGTERM, outlives us.
function stubbornDescendant(kind) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: kind === 'stdout' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  });
  child.unref();
  fs.appendFileSync(`${statePath}.pids`, `${child.pid}\n`);
}

// One log file per thread, appended to on every turn, like Codex's own.
function logSettings(threadId, tier) {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '04');
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_id: threadId, thread_settings: { model: 'gpt-6.1-sol', service_tier: tier } },
  };
  fs.appendFileSync(path.join(dir, `rollout-2026-10-04T00-00-00-${threadId}.jsonl`), `${JSON.stringify(record)}\n`);
}

if (!step || step.fail) {
  console.error(step?.fail || 'fake codex: no scripted reply left');
  process.exit(1);
}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
function emitCommands() {
  for (const [i, entry] of (step.commands ?? []).entries()) {
    const command = entry.rawCommand ?? `/bin/zsh -lc '${entry.command.replace(/'/g, "'\\''")}'`;
    const item = { id: `command_${i}`, type: 'command_execution', command };
    emit({ type: 'item.started', item: { ...item, exit_code: null, status: 'in_progress' } });
    if (entry.completed === false) continue;
    const exit_code = Object.hasOwn(entry, 'exit_code') ? entry.exit_code : 0;
    emit({ type: 'item.completed', item: { ...item, exit_code, status: entry.status ?? (exit_code === 0 ? 'completed' : 'failed') } });
  }
}
const resume = args[0] === 'exec' && args[1] === 'resume';
const threadId = resume ? args[2] : crypto.randomUUID();
if (step.hang) {
  if (step.started) {
    if (step.tier) logSettings(threadId, step.tier);
    emit({ type: 'thread.started', thread_id: threadId });
  }
  emitCommands();
  if (step.descendant) stubbornDescendant(step.descendant);
  if (step.ignoreTerm) process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  if (step.tier) logSettings(threadId, step.tier);
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emitCommands();
  if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  // build mode: the implementer edits files in its working directory, the worktree
  for (const [file, text] of Object.entries(step.write ?? {})) fs.writeFileSync(path.join(process.cwd(), file), text);
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(step.reply));
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(step.reply) } });
  emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } });
  if (step.descendant) stubbornDescendant(step.descendant);
}

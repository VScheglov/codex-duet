#!/usr/bin/env node
// codex-duet runner. One invocation runs at most one Codex turn:
// Codex reviews with the owner's own Codex setup, sandbox included unless --sandbox says
// otherwise; Claude answers every issue; scripts/policy.mjs decides whether to go on.
// All state lives in $CODEX_DUET_HOME/<session>/ (default ~/.local/state/codex-duet).

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const SCHEMA = path.join(ROOT, 'schemas', 'review.schema.json');
const BUILD_SCHEMA = path.join(ROOT, 'schemas', 'build.schema.json');
const AUDIT_SCHEMA = path.join(ROOT, 'schemas', 'audit.schema.json');
const PROMPTS = path.join(ROOT, 'prompts');
const HOME = process.env.CODEX_DUET_HOME
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-duet');
const CODEX_BIN = process.env.CODEX_DUET_CODEX_BIN || 'codex';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CLAUDE_SESSION = process.env.CLAUDE_CODE_SESSION_ID || null; // set by Claude Code in every Bash call
const MODEL_RE = /^[\w.:/-]+$/;
const EFFORT_RE = /^[a-z]+$/;
const POLICY = process.env.CODEX_DUET_POLICY || path.join(ROOT, 'scripts', 'policy.mjs');

const EMBED_LIMIT = 150_000; // max chars of subject content or diff inlined into one prompt
const KILL_GRACE_MS = Number(process.env.CODEX_DUET_KILL_GRACE_MS) || 5000; // SIGTERM → SIGKILL, exit → pipes closed
const TIER_POLL_MS = 3000; // a running turn's log is read for its service tier this often,
const TIER_LOOKS = 20; // this many times at most, and once more when the turn is over
const KINDS = ['plan', 'code', 'file', 'build', 'audit'];
const SANDBOXES = ['inherit', 'read-only', 'workspace-write', 'danger-full-access'];
const ACTIONS = ['fixed', 'disputed', 'needs-user', 'owner-decided'];
const STATUSES = ['open', 'resolved', 'withdrawn'];
const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const PHASE_BY_ACTION = { continue: 'awaiting-author', done: 'done', escalate: 'escalated' };

const USAGE = `Usage: duet.mjs <command> [options]

  start   --kind plan|code|file [--subject <path>|-]... [--base <ref>] [--focus <text>]
          [--brief <file>|-]  owner's request, accepted amendments and claimed result
          [--max-rounds 10] [--model <name>] [--effort <level>] [--timeout-min 0]
          (--timeout-min: minutes per Codex turn; 0, the default, is no limit)
          [--sandbox inherit|read-only|workspace-write|danger-full-access]
          (inherit, the default: whatever the owner's Codex config allows)
  start   --kind build --subject <spec>|- [--base <ref>] [--branch <name>] [...the options above]
          Codex implements the spec in a worktree on a new branch; Claude reviews
          The spec needs a non-empty ## Owner's request section; --brief is for reviews only
  start   --kind audit --subject <task>|- [--model <name>] [--effort <level>] [--timeout-min 0]
          Codex examines what the task asks about in the current directory, always read-only, and
          reports findings with evidence: one turn, nothing to answer, the report is the result
  reply   --responses <file>|- [--session <id>] [--max-rounds <n>]     (review sessions)
  review  --issues <file>|- [--session <id>] [--max-rounds <n>]        (build sessions)
  finish  [--session <id>] [--unreviewed]   build: commit only approved content and remove the worktree
          --unreviewed: only on the owner's explicit word, commit without an approval check
  verify  [--session <id>]     code/build: compare current content with the approved tree (foreground)
  discard [--session <id>]     build: remove the worktree and delete its branch
  retry   [--session <id>] [--fresh]   re-run a Codex round that failed; a turn Codex had begun goes on
          in its own thread, with what it did and read; --fresh starts the turn over
          reply, review and retry also take --model, --effort and --timeout-min: the session's Codex
          switches from its next turn on. Models and efforts are checked against the owner's Codex
          (models_cache.json). Run start, reply, review and retry in the background: a Codex turn
          outlasts the 10-minute limit of a foreground Bash call
  status  [--session <id>]     re-print the latest round summary
  report  [--session <id>]     print the full report
  list    [--all]              sessions for this directory (or all of them)

Without --session the newest session for the current directory is used.`;

class UsageError extends Error {}

// ---------------------------------------------------------------- CLI

const BOOLEAN_FLAGS = new Set(['all', 'fresh', 'unreviewed']);
const cliError = (message) => Object.assign(new UsageError(message), { showUsage: true });

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const o = { subject: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw cliError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      o[key] = true;
      continue;
    }
    i += 1;
    const value = rest[i];
    if (value === undefined) throw cliError(`missing value for --${key}`);
    if (key === 'subject') o.subject.push(value);
    else o[key] = value;
  }
  return { cmd, o };
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

// A whole number that may be 0, where 0 means "no limit".
function toCount(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number (0: no limit)`);
  return n;
}

function checkSandbox(value) {
  if (!SANDBOXES.includes(value)) throw new UsageError(`--sandbox must be one of: ${SANDBOXES.join(', ')}`);
  return value;
}

function checkToken(value, name, re) {
  if (value == null || value === '') return null;
  if (!re.test(value)) throw new UsageError(`invalid --${name}: ${value}`);
  return value;
}

// What the owner's Codex offers: its model cache (each model with the efforts and the service tiers it takes)
// and the defaults at the top of config.toml. Either may be missing; then nothing is checked and Codex itself
// has the last word. Defaults under a selected profile are not resolved: with `profile = …` they count as unknown.
function codexCatalog() {
  let models = null;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'models_cache.json'), 'utf8'));
    if (Array.isArray(cache.models)) {
      models = cache.models.filter((m) => typeof m?.slug === 'string').map((m) => ({
        slug: m.slug,
        name: String(m.display_name ?? m.slug),
        efforts: (m.supported_reasoning_levels ?? []).map((level) => level?.effort ?? level).filter((e) => typeof e === 'string'),
        // the tiers beyond the standard one; Fast is {id: "priority", name: "Fast"}
        tiers: [...(m.service_tiers ?? []).map((tier) => tier?.id), ...(m.additional_speed_tiers ?? [])].filter((t) => typeof t === 'string'),
        isListed: m.visibility !== 'hide',
      }));
    }
  } catch {}
  const defaults = { model: null, effort: null, tier: null };
  try {
    const top = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8').split(/^\s*\[/m)[0]; // keys before the first table
    if (!/^\s*profile\s*=/m.test(top)) {
      defaults.model = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
      defaults.effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
      defaults.tier = /^\s*service_tier\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
    }
  } catch {}
  return { models, defaults };
}

// Refuses a model or an effort the owner's Codex does not have, before a round is spent on a typo; the
// refusal lists what there is. A display name ("GPT-6-Astra") resolves to its id. An unset model or effort
// is checked as config.toml sets it, so a model that cannot take the default effort is caught too.
function checkCodexChoice(model, effort) {
  const { models, defaults } = codexCatalog();
  if (!models?.length) return { model, effort };
  let id = model;
  if (model) {
    const lower = model.toLowerCase();
    const found = models.find((m) => m.slug === model)
      ?? models.find((m) => m.slug.toLowerCase() === lower || m.name.toLowerCase() === lower);
    if (!found) throw new UsageError(`unknown Codex model: ${model}; available: ${models.filter((m) => m.isListed).map((m) => m.slug).join(', ')}`);
    id = found.slug;
  }
  const known = [...new Set(models.flatMap((m) => m.efforts))];
  if (effort && known.length && !known.includes(effort)) throw new UsageError(`unknown effort: ${effort}; known: ${known.join(', ')}`);
  const target = models.find((m) => m.slug === (id ?? defaults.model));
  const level = effort ?? defaults.effort;
  if (target?.efforts.length && level && !target.efforts.includes(level)) {
    const from = effort ? '' : ` (the default in ${path.join(CODEX_HOME, 'config.toml')})`;
    throw new UsageError(`${target.slug} does not take effort "${level}"${from}; it takes: ${target.efforts.join(', ')}. Pass --effort <level>`);
  }
  return { model: id, effort };
}

// --model/--effort from the command line over `base` (the environment at start, the session's own later).
function codexChoice(o, base) {
  const model = checkToken(o.model ?? base.model, 'model', MODEL_RE);
  const effort = o.effort ?? base.effort;
  return checkCodexChoice(model, checkToken(effort == null ? effort : String(effort).toLowerCase(), 'effort', EFFORT_RE));
}

// On reply, review or retry: the session's Codex switches from its next turn on. --timeout-min too, so a
// session started with an old limit can drop it (0).
function switchCodex(st, o) {
  if (o['timeout-min'] != null) st.codex.timeoutMin = toCount(o['timeout-min'], 'timeout-min');
  if (o.model == null && o.effort == null) return;
  Object.assign(st.codex, codexChoice(o, st.codex));
}

// What a Codex turn runs on: the session's choice, else config.toml's default at this moment. A turn
// records it when it starts, so the pane and the round history show the truth after config.toml changes.
function turnModel(st) {
  const { models, defaults } = codexCatalog();
  const model = st.codex.model ?? defaults.model ?? null;
  const m = {
    model,
    effort: st.codex.effort ?? defaults.effort ?? null,
    fromConfig: [...(st.codex.model ? [] : ['model']), ...(st.codex.effort ? [] : ['effort'])],
  };
  // A tier (Fast is "priority") comes from config.toml alone and counts only when the model's catalog entry
  // offers it. While the turn runs, Codex's own log may confirm or correct it (watchTier in runCodex).
  if (defaults.tier && models?.find((x) => x.slug === model)?.tiers.includes(defaults.tier)) {
    m.tier = defaults.tier;
    m.fromConfig.push('tier');
  }
  return m;
}

const isFastTier = (tier) => tier === 'priority' || tier === 'fast';

function modelLine(st) {
  const m = turnModel(st);
  const show = (value, key, fallback) => (value ? `${value}${m.fromConfig.includes(key) ? ' (config)' : ''}` : fallback);
  const fast = isFastTier(m.tier) ? ` · ⚡ ${show('Fast', 'tier')}` : '';
  return `Model: ${show(m.model, 'model', 'Codex default')} · ${show(m.effort, 'effort', 'default effort')}${fast}`;
}

// Never read stdin unless asked to: an unclosed stdin would block forever.
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new UsageError('stdin is a terminal: pass the input with a heredoc'));
      return;
    }
    let data = '';
    const timer = setTimeout(() => reject(new UsageError('no input on stdin: pass it with a heredoc')), 10_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      clearTimeout(timer);
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Markdown headings inside fenced examples are data, not sections. A request section ends
// at the next level-1 or level-2 heading; subsections still belong to the request.
function hasOwnerRequest(text) {
  let inRequest = false;
  let content = [];
  let fence = null;
  const nonEmpty = () => content.some((line) => line.replace(/^[ \t]*(?:>[ \t]*)+/, '').trim());
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      if (inRequest) content.push(line);
      continue;
    }
    const opening = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1];
      if (inRequest) content.push(line);
      continue;
    }
    const heading = /^[ \t]*(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (heading && heading[1].length <= 2) {
      if (inRequest && nonEmpty()) return true;
      const title = (heading[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim().toLowerCase().replace(/[\u2019\u02bc]/g, "'");
      inRequest = heading[1].length === 2 && title === "owner's request";
      content = [];
    } else if (inRequest) content.push(line);
  }
  return inRequest && nonEmpty();
}

// ---------------------------------------------------------------- state

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sessionDir = (id) => path.join(HOME, id);
const statePath = (id) => path.join(sessionDir(id), 'state.json');

function writeJSON(file, value) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

// Only commands that move a session save it, so the Claude session that ran the last of them owns the
// review: the pane, band, toasts and sounds follow it there. A call from a plain shell keeps the owner.
function saveState(st) {
  if (CLAUDE_SESSION) st.owner = CLAUDE_SESSION;
  st.updatedAt = now();
  writeJSON(statePath(st.id), st);
}

function loadState(id) {
  if (!/^[\w-]+$/.test(id)) throw new UsageError(`bad session id: ${id}`);
  if (!fs.existsSync(statePath(id))) throw new UsageError(`session not found: ${id}`);
  return readJSON(statePath(id));
}

function allSessions() {
  if (!fs.existsSync(HOME)) return [];
  return fs.readdirSync(HOME)
    .filter((d) => fs.existsSync(statePath(d)))
    .map((d) => {
      try {
        return readJSON(statePath(d));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const covers = (st, dir) => dir === st.cwd || dir.startsWith(st.cwd + path.sep);

function resolveSession(id) {
  if (id) return loadState(id);
  const here = fs.realpathSync(process.cwd());
  const st = allSessions().find((s) => covers(s, here));
  if (!st) throw new UsageError('no codex-duet session for this directory; pass --session <id> (see: duet.mjs list --all)');
  return st;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const lockFile = (id) => path.join(sessionDir(id), 'lock');

function lockOwner(id) {
  try {
    return Number(fs.readFileSync(lockFile(id), 'utf8')) || null;
  } catch {
    return null;
  }
}

function lockHolder(st) {
  const pid = lockOwner(st.id);
  return pid && isAlive(pid) ? pid : null;
}

// open(2) on macOS and the BSDs takes an exclusive flock atomically with O_EXLOCK, and the kernel
// drops it when the process dies: a crashed run leaves no lock that anyone has to break.
const O_EXLOCK = ['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform) ? 0x20 : 0;

// One codex-duet call per session at a time, held from loading the state to writing it back.
// The file also carries the holder's pid, for `status` and the UI.
function acquireLock(id) {
  const file = lockFile(id);
  const busy = () => {
    const pid = lockOwner(id);
    return new UsageError(`session ${id} is busy: another codex-duet call is running${pid ? ` (pid ${pid})` : ''}; wait for it to finish`);
  };
  if (O_EXLOCK) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | O_EXLOCK, 0o644);
    } catch (err) {
      if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') throw busy();
      throw err;
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, String(process.pid));
    return () => {
      fs.ftruncateSync(fd, 0);
      fs.closeSync(fd);
    };
  }
  // Elsewhere an exclusive create. A stale lock is never broken automatically, because the
  // check-then-remove cannot be made atomic; the error says how to clear it by hand.
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = lockOwner(id);
    if (pid && isAlive(pid)) throw busy();
    throw new UsageError(`session ${id} has a stale lock${pid ? ` from pid ${pid}` : ''}: make sure no codex-duet call is running, then delete ${file}`);
  }
  return () => {
    if (lockOwner(id) === process.pid) fs.rmSync(file, { force: true });
  };
}

// ---------------------------------------------------------------- the queue of Codex turns

// At most MAX_PARALLEL Codex turns run at once on this machine, across all sessions: each turn starts
// the owner's whole MCP set and spends the same quota. A turn holds a slot, a kernel lock on a slot file,
// only while Codex works; the slot frees when the turn ends or its process dies. Waiting turns go in the
// order they queued: each waits with a ticket named by its queue time and holding its pid.
const MAX_PARALLEL = Math.max(1, Number(process.env.CODEX_DUET_MAX_PARALLEL) || 10);
const QUEUE_POLL_MS = Number(process.env.CODEX_DUET_QUEUE_POLL_MS) || 3000;
const slotDir = () => path.join(HOME, '.slots');
const ticketDir = () => path.join(HOME, '.queue');

// Slot i, locked by this process; null while another process holds it. Returns the release.
function trySlot(i) {
  const file = path.join(slotDir(), `slot-${i}`);
  if (O_EXLOCK) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | O_EXLOCK, 0o644);
      return () => fs.closeSync(fd);
    } catch (err) {
      if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') return null;
      throw err;
    }
  }
  // Elsewhere a pid file, taken over once its holder is gone.
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return () => fs.rmSync(file, { force: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
    if (pid && isAlive(pid)) return null;
    fs.rmSync(file, { force: true });
    return null; // free on the next poll
  }
}

function freeSlots() {
  let free = 0;
  for (let i = 1; i <= MAX_PARALLEL; i += 1) {
    const release = trySlot(i);
    if (release) {
      free += 1;
      release();
    }
  }
  return free;
}

// The waiting turns in queue order; a ticket whose process is gone is dropped.
function liveTickets() {
  return fs.readdirSync(ticketDir()).sort().filter((name) => {
    const file = path.join(ticketDir(), name);
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, 'utf8')) || 0;
    } catch {
      return false; // removed meanwhile
    }
    if (pid && isAlive(pid)) return true;
    fs.rmSync(file, { force: true });
    return false;
  });
}

// Waits for a slot and returns its release. While it waits, the session reads `queued` (with the round's
// own payload, so `retry` can run it if this process dies); a turn that finds a free slot never queues.
async function takeSlot(st, round, extra) {
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.mkdirSync(ticketDir(), { recursive: true });
  const ticket = `${String(Date.now()).padStart(15, '0')}-${st.id}`;
  fs.writeFileSync(path.join(ticketDir(), ticket), String(process.pid));
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    for (;;) {
      const ahead = liveTickets().indexOf(ticket);
      if (ahead >= 0 && ahead < freeSlots()) {
        for (let i = 1; i <= MAX_PARALLEL; i += 1) {
          const release = trySlot(i);
          if (release) return release;
        }
      }
      if (st.phase !== 'queued') {
        st.phase = 'queued';
        st.pending = { round, queuedAt: now(), ...extra };
        saveState(st);
      }
      await sleep(QUEUE_POLL_MS + Math.floor(Math.random() * 300));
      if (cancelled) {
        st.phase = 'codex-failed';
        st.pending.error = 'cancelled while waiting in the queue';
        saveState(st);
        throw new Error(`round ${round} failed: cancelled while waiting in the queue\n`
          + `Run again with: node "${SELF}" retry --session ${st.id}`);
      }
    }
  } finally {
    fs.rmSync(path.join(ticketDir(), ticket), { force: true });
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

// Checked under the lock: a round that started but never finished has to be retried first.
function guardIdle(st) {
  if (st.phase !== 'awaiting-codex' && st.phase !== 'codex-failed' && st.phase !== 'queued') return;
  const why = st.pending?.error ? `: ${st.pending.error}` : '';
  throw new UsageError(`round ${st.pending?.round} did not complete${why}. Fix the cause, then run: node "${SELF}" retry --session ${st.id}`);
}

// ---------------------------------------------------------------- git & files

function git(args, { cwd, env, allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r;
}

const hasHead = (cwd) => git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, allowFail: true }).status === 0;

// Tree object of the whole working tree (tracked + untracked, minus ignored) without
// touching the user's index, stash or branches: a throwaway index file does the work.
// It starts as a copy of the user's index, so force-added ignored files and
// `git rm --cached` removals count exactly as staged.
function snapshotTree(st, round) {
  const index = path.join(sessionDir(st.id), `snapshot-${round}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const userIndex = path.resolve(st.cwd, git(['rev-parse', '--git-path', 'index'], { cwd: st.cwd }).stdout.trim());
    if (fs.existsSync(userIndex)) {
      fs.copyFileSync(userIndex, index);
      // Keep the original mtime: git's racy-entry check compares entries against the index
      // file's own mtime, and a fresh one would let a same-second, same-size edit look unchanged.
      const { atime, mtime } = fs.statSync(userIndex);
      fs.utimesSync(index, atime, mtime);
    } else {
      git(hasHead(st.cwd) ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { cwd: st.cwd, env });
    }
    git(['add', '-A', '--', '.'], { cwd: st.cwd, env });
    return git(['write-tree'], { cwd: st.cwd, env }).stdout.trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function takeSnapshot(st, round) {
  if (st.kind === 'code' || st.kind === 'build') return { tree: snapshotTree(st, round) };
  const dir = path.join(sessionDir(st.id), 'snapshots', `r${round}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    docs: st.subject.paths.map((file, i) => {
      const exists = fs.existsSync(file);
      const snap = path.join(dir, `${i}${path.extname(file) || '.txt'}`);
      fs.writeFileSync(snap, exists ? fs.readFileSync(file) : '');
      return { path: file, snap, exists };
    }),
  };
}

// All comparisons use immutable tree objects, including modes and deletions. Renames
// count by path; -z keeps tabs, newlines and git's path quoting out of the classifier.
function pathStates(st, approved, current) {
  const cwd = st.kind === 'build' ? st.subject.repo : st.cwd;
  const changed = (from, to) => new Set(git([
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', from, to, '--',
  ], { cwd }).stdout.split('\0').filter(Boolean));
  const reviewed = changed(st.subject.base, approved);
  const edited = changed(approved, current);
  return [...new Set([...reviewed, ...edited])].sort().map((file) => ({
    path: file,
    state: reviewed.has(file) ? (edited.has(file) ? 'edited-after-review' : 'covered') : 'never-reviewed',
  }));
}

const pathStateLines = (paths) => paths.map((p) => `- ${p.state}: ${JSON.stringify(p.path)}`);

function compareApproval(st, tree, approval = st.approval) {
  const paths = pathStates(st, approval?.tree ?? st.subject.base, tree);
  return { tree, approval, paths, matches: Boolean(approval && approval.tree === tree) };
}

function currentApprovalCheck(st) {
  const onBranch = st.kind === 'build' && !fs.existsSync(st.subject.worktree);
  const tree = onBranch
    ? git(['rev-parse', '--verify', `${st.subject.branch}^{tree}`], { cwd: st.subject.repo }).stdout.trim()
    : snapshotTree(st, `check-${process.pid}`);
  return { ...compareApproval(st, tree), source: onBranch ? `Branch commit (${st.subject.branch})` : 'Working tree' };
}

function approvalVerdict(check) {
  if (check.matches) return 'matches the approved tree';
  const n = check.paths.filter((p) => p.state !== 'covered').length;
  return `differs from the approved tree: ${n} path(s)${check.approval ? '' : ' (no approval recorded)'}`;
}

function clearApproval(st) {
  // Keep the last witness for an explicit unreviewed finish, even after a later
  // decision or post-approval round invalidated the active approval.
  if (st.approval) st.lastApproval = st.approval;
  delete st.approval;
}

function recordApproval(st) {
  if (!['code', 'build'].includes(st.kind)) return;
  if (st.decision.action !== 'done') {
    clearApproval(st);
    return;
  }
  st.approval = { tree: st.rounds.at(-1).snapshot.tree, round: st.round, at: now() };
}

function unifiedDiff(before, after, label) {
  const r = spawnSync('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, before, after], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status === 0) return '';
  if (r.status === 1) return r.stdout;
  throw new Error(`diff failed: ${(r.stderr || '').trim()}`);
}

const clip = (text) => (text.length <= EMBED_LIMIT
  ? text
  : `${text.slice(0, EMBED_LIMIT)}\n... (truncated at ${EMBED_LIMIT} chars: inspect the rest directly)`);

const tag = (name, attrs, text) => `<${name}${attrs}>\n${text.replace(/\n?$/, '\n')}</${name}>`;

// ---------------------------------------------------------------- prompts

function codeSubject(st, snap, prev) {
  const { base } = st.subject;
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M'];
  const stat = git([...diffArgs, '--stat=200', base, snap.tree], { cwd: st.cwd }).stdout.trim();
  const header = [
    `Git repository: ${st.cwd}`,
    `Target: ${st.subject.target}`,
    `Base: ${base}`,
    `Current state snapshot (git tree object): ${snap.tree}`,
    `Full diff: git diff -M ${base} ${snap.tree}   One file as of the snapshot: git show ${snap.tree}:<path>`,
  ].join('\n');
  if (!prev) {
    const status = git(['status', '--short', '--untracked-files=all'], { cwd: st.cwd }).stdout.trim();
    const diff = git([...diffArgs, base, snap.tree], { cwd: st.cwd }).stdout;
    const body = [
      tag('git_status', '', status || '(clean)'),
      tag('diffstat', '', stat || '(empty)'),
      diff.length <= EMBED_LIMIT
        ? tag('diff', '', diff)
        : `The diff is too large to inline (${diff.length} chars). Inspect it with the commands above.`,
    ].join('\n\n');
    return { header, body, delta: '', empty: !stat };
  }
  const inter = git([...diffArgs, prev.tree, snap.tree], { cwd: st.cwd }).stdout;
  return {
    header,
    body: tag('diffstat_of_the_whole_change', '', stat || '(empty)'),
    delta: inter ? clip(inter) : '(no code changes since the previous round)',
    empty: !stat,
  };
}

function docSubject(st, snap, prev) {
  const label = (file) => {
    const rel = path.relative(st.cwd, file);
    return rel.startsWith('..') ? file : rel;
  };
  const header = [
    `Working directory: ${st.cwd}`,
    `${st.kind === 'plan' ? 'Plan file' : 'Files'} under review:`,
    ...snap.docs.map((d) => `- ${d.path}${d.exists ? '' : ' (DELETED)'}`),
  ].join('\n');
  const size = snap.docs.reduce((n, d) => n + (d.exists ? fs.statSync(d.snap).size : 0), 0);
  const body = size <= EMBED_LIMIT
    ? snap.docs.filter((d) => d.exists)
      .map((d) => tag('subject_file', ` path="${label(d.path)}"`, fs.readFileSync(d.snap, 'utf8')))
      .join('\n\n')
    : `The files are too large to inline (${size} bytes). Read them from disk with read-only commands.`;
  let delta = '';
  if (prev) {
    const parts = snap.docs.map((d, i) => unifiedDiff(prev.docs[i].snap, d.snap, label(d.path))).filter(Boolean);
    delta = parts.length ? clip(parts.join('\n')) : '(no changes since the previous round)';
  }
  return { header, body, delta, empty: snap.docs.every((d) => !d.exists) };
}

const template = (name) => fs.readFileSync(path.join(PROMPTS, name), 'utf8');
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? String(vars[key]) : ''));
const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
const nextId = (st) => `C${Math.max(0, ...Object.keys(st.issues).map(idNum)) + 1}`;
const indent = (text, pad = '    ') => String(text).trim().replace(/\n/g, `\n${pad}`);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// What the reviewer may run, told to it in round 1; sessions from before --sandbox ran read-only.
function toolingNote(st) {
  if ((st.codex.sandbox ?? 'read-only') === 'read-only') {
    return 'The shell sandbox is read-only: read and run read-only commands, nothing that writes files.';
  }
  return 'You may run whatever helps to verify the subject: tests, builds, linters, scripts. Temporary files, '
    + 'caches and build output are fine; for anything heavier (installing dependencies, generating code) use a '
    + 'throwaway copy, e.g. `git worktree add "$TMPDIR/review-copy"`. This runs on the owner\'s desktop: never start a '
    + 'program that signs in through the macOS keychain (claude, gh, git credential helpers, `security`) with HOME '
    + 'pointed at a temporary directory, as each try opens a system dialog on the owner\'s screen. Pass its credentials '
    + 'through the environment (claude: `CLAUDE_CODE_OAUTH_TOKEN`, gh: `GH_TOKEN`), or leave that check out and say so.';
}

function buildPrompt(st, round, snap, prev, payload) {
  const subject = st.kind === 'code' ? codeSubject(st, snap, prev) : docSubject(st, snap, prev);
  if (round === 1) {
    if (subject.empty) throw new UsageError('nothing to review: the subject is empty');
    return fill(template('round1.md'), {
      SUBJECT_HEADER: subject.header,
      TOOLING: toolingNote(st),
      KIND_GUIDANCE: template(`kind-${st.kind}.md`).trim(),
      FOCUS: st.focus || '(none: review everything material)',
      OWNER_BRIEF: st.brief ? fs.readFileSync(st.brief, 'utf8').replace(/\n?$/, '\n') : '(none given)\n',
      SUBJECT_BODY: subject.body,
    });
  }
  const responses = payload.responses.map((r) => {
    const issue = st.issues[r.id];
    return `- ${r.id} [${issue.severity}] ${issue.title}\n  action: ${r.action}\n  note: ${indent(r.note, '  ')}`;
  });
  return fill(template('roundN.md'), {
    ROUND: round,
    SUBJECT_HEADER: subject.header,
    CHANGES: String(payload.changes || '').trim() || '(no summary given)',
    RESPONSES: responses.join('\n') || '(no issues were open: re-review the current state)',
    DELTA: subject.delta,
    NEXT_ID: nextId(st),
    SUBJECT_BODY: subject.body,
    REQUEST_RULING: requestRulingLine(st),
  });
}

// ---------------------------------------------------------------- codex

function codexArgs(st, outFile, threadId, schema) {
  const sandbox = st.codex.sandbox ?? 'read-only'; // sessions from before --sandbox ran read-only
  const common = [
    '--skip-git-repo-check',
    '-c', 'approval_policy="never"', // unattended: nobody is there to answer an approval request
    '--json',
    '--output-schema', schema,
    '-o', outFile,
  ];
  // inherit: no sandbox flags at all, the owner's Codex config decides, as in their own sessions.
  // An explicit mode goes through config on every turn, because `exec resume` has no --sandbox flag.
  if (sandbox !== 'inherit') common.push('-c', `sandbox_mode="${sandbox}"`);
  if (st.codex.model) common.push('-m', st.codex.model);
  if (st.codex.effort) common.push('-c', `model_reasoning_effort="${st.codex.effort}"`);
  return threadId
    ? ['exec', 'resume', threadId, ...common, '-']
    : ['exec', '-C', st.cwd, ...(sandbox === 'inherit' ? [] : ['-s', sandbox]), ...common, '-'];
}

// Codex's own log of a thread, ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, searched from the
// newest day back. The session keeps the path: a resumed thread writes on in the same file.
function rolloutOf(st, threadId) {
  const known = st.codex.rollout;
  if (known?.endsWith(`-${threadId}.jsonl`) && fs.existsSync(known)) return known;
  const list = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const below = (dir) => list(dir).filter((name) => /^\d+$/.test(name)).sort().reverse().map((name) => path.join(dir, name));
  for (const year of below(path.join(CODEX_HOME, 'sessions'))) {
    for (const month of below(year)) {
      for (const day of below(month)) {
        const name = list(day).find((n) => n.endsWith(`-${threadId}.jsonl`));
        if (name) return (st.codex.rollout = path.join(day, name));
      }
    }
  }
  return null;
}

// The service tier Codex itself applied to a turn that began at `sinceMs` ("priority" is Fast, "default" the
// standard one): the last thread_settings_applied record written since. Codex 0.160 writes one whenever a turn
// resumes a thread; a thread's first turn may have none, and then config.toml's word stands.
function appliedTier(st, threadId, sinceMs) {
  const file = rolloutOf(st, threadId);
  let text = '';
  try {
    if (file) text = fs.readFileSync(file, 'utf8');
  } catch {}
  let tier = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"thread_settings_applied"')) continue;
    try {
      const record = JSON.parse(line);
      const value = record.payload?.thread_settings?.service_tier;
      if (typeof value === 'string' && Date.parse(record.timestamp) >= sinceMs) tier = value;
    } catch {} // a line still being written
  }
  return tier;
}

// What Codex's log says beats what config.toml asked for: the running turn records it, so the pane shows ⚡
// for Fast while it runs, and the round keeps it.
function noteTier(st, tier) {
  const m = st.pending?.codexModel;
  if (!m) return;
  m.tier = tier;
  m.fromConfig = m.fromConfig.filter((key) => key !== 'tier');
  saveState(st);
}

// The prompt goes through stdin, which is then closed: `codex exec` waits for EOF on a piped stdin.
function runCodex(st, round, prompt, threadId, schema = SCHEMA) {
  const dir = sessionDir(st.id);
  const out = path.join(dir, `round-${round}.codex.json`);
  const errPath = path.join(dir, `round-${round}.stderr.txt`);
  fs.writeFileSync(path.join(dir, `round-${round}.prompt.md`), prompt);
  fs.rmSync(out, { force: true });
  const events = fs.createWriteStream(path.join(dir, `round-${round}.events.jsonl`));
  const errors = fs.createWriteStream(errPath);

  return new Promise((resolve) => {
    const result = { threadId, out, errPath, usage: null, turnFailed: null, lastError: null, timedOut: false, cancelled: false };
    // The tier the turn got shows only in Codex's log, once the turn has begun: looked for as soon as Codex
    // names the thread, then every few seconds for a minute, and once more when the turn is over.
    const sinceMs = Date.now();
    let tierTimer = null;
    let tierLooks = 0;
    const lookForTier = () => {
      clearTimeout(tierTimer);
      if (!result.threadId || result.tier) return;
      const tier = appliedTier(st, result.threadId, sinceMs);
      if (tier) {
        result.tier = tier;
        noteTier(st, tier);
      } else if (++tierLooks < TIER_LOOKS) {
        tierTimer = setTimeout(lookForTier, TIER_POLL_MS);
      }
    };
    // A process group of its own: timeout and cancel take down the whole tree (the codex
    // wrapper, its native binary, MCP servers, shell commands), not only the wrapper.
    const child = spawn(CODEX_BIN, codexArgs(st, out, threadId, schema), {
      cwd: st.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    // false once nothing of the group is left; signal 0 only asks
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    };
    let terminatedAt = 0;
    let killer = null;
    const terminate = () => {
      if (terminatedAt) return;
      terminatedAt = Date.now();
      signalGroup('SIGTERM');
      killer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS); // for a leader that ignores SIGTERM
    };
    // Whatever is left of the group belongs to this run: it gets the rest of the grace period,
    // then SIGKILL. This happens before the promise resolves, because the runner may exit right
    // after, and a pending timer would die with it.
    const reap = async () => {
      if (!signalGroup(0)) return;
      if (!terminatedAt) {
        terminatedAt = Date.now();
        signalGroup('SIGTERM');
      }
      while (signalGroup(0) && Date.now() - terminatedAt < KILL_GRACE_MS) await sleep(50);
      signalGroup('SIGKILL');
    };
    // No limit unless one was asked for (--timeout-min): a turn at high effort can run for hours, and a
    // background Bash call has its own ceiling anyway (2 hours, or BASH_MAX_TIMEOUT_MS).
    result.timeoutMs = Number(process.env.CODEX_DUET_TIMEOUT_MS) || (st.codex.timeoutMin ?? 0) * 60_000;
    const timer = result.timeoutMs > 0 ? setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, result.timeoutMs) : null;
    const cancel = () => {
      result.cancelled = true;
      terminate();
    };
    let drain = null;
    let isSettling = false;
    const finish = async (extra) => {
      if (isSettling) return;
      isSettling = true;
      clearTimeout(timer);
      clearTimeout(drain);
      clearTimeout(killer);
      await reap();
      tierLooks = TIER_LOOKS; // the last look: a short turn ends before the next one is due
      lookForTier();
      child.stdout?.destroy();
      child.stderr?.destroy();
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      if (buffer) events.write(buffer); // a last line without its newline, as it came
      events.end();
      errors.end();
      resolve({ ...result, ...extra });
    };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        let event;
        try {
          event = JSON.parse(line);
        } catch {}
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          events.write(`${line}\n`);
          continue;
        }
        // Codex's events carry no time: each gets the moment it came (_at), so the pane can tell how old
        // Codex's last words are.
        events.write(`${JSON.stringify({ ...event, _at: now() })}\n`);
        if (event.type === 'thread.started' && event.thread_id) {
          result.threadId = event.thread_id;
          lookForTier();
        } else if (event.type === 'turn.completed') result.usage = event.usage ?? null;
        else if (event.type === 'turn.failed') result.turnFailed = event.error?.message || 'turn failed';
        else if (event.type === 'error' && event.message) result.lastError = event.message;
      }
    });
    child.stderr.on('data', (chunk) => errors.write(chunk));
    child.on('error', (err) => { void finish({ code: null, spawnError: `cannot run ${CODEX_BIN}: ${err.message}` }); });
    // 'close' waits for the pipes, and a leftover descendant can hold them open forever: after
    // the exit, wait a grace period for them, then finish anyway (reap clears out the group).
    child.on('exit', (code, signal) => {
      drain = setTimeout(() => { void finish({ code, signal }); }, KILL_GRACE_MS);
    });
    child.on('close', (code, signal) => { void finish({ code, signal }); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function stderrTail(file, lines = 15) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim() && !l.startsWith('Reading additional input from stdin'))
      .slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function validRequestCheck(value, allowNoBrief = true) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && ['matches', 'narrowed', 'unclear', ...(allowNoBrief ? ['no-brief'] : [])].includes(value.status)
    && typeof value.notes === 'string';
}

function normalizeRequestCheck(value, allowNoBrief = true) {
  return validRequestCheck(value, allowNoBrief)
    ? { status: value.status, notes: value.notes.trim() }
    : { status: 'unclear', notes: '(not reported)' };
}

function validOwnerRequestCheck(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.owner === true
    && ['matches', 'narrowed-accepted'].includes(value.status)
    && typeof value.notes === 'string' && value.notes.trim().length > 0;
}

// Only Claude's review command may relay this flag; Codex checks still use
// normalizeRequestCheck, which cannot grant an owner ruling or its extra status.
function normalizeBuildReviewCheck(value) {
  return validOwnerRequestCheck(value)
    ? { status: value.status, notes: value.notes.trim(), owner: true }
    : normalizeRequestCheck(value, false);
}

function normalizeReply(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a JSON object');
  if (!['approve', 'revise'].includes(raw.verdict)) throw new Error(`bad verdict: ${raw.verdict}`);
  if (!Array.isArray(raw.issues)) throw new Error('"issues" is not an array');
  const issues = new Map();
  for (const it of raw.issues) {
    const m = /^C-?(\d+)$/i.exec(String(it.id || '').trim());
    if (!m) throw new Error(`bad issue id: ${it.id}`);
    if (!STATUSES.includes(it.status)) throw new Error(`bad status for ${it.id}: ${it.status}`);
    const id = `C${Number(m[1])}`;
    if (issues.has(id)) throw new Error(`issue ${id} appears more than once`);
    issues.set(id, {
      id,
      status: it.status,
      severity: it.severity in SEVERITY_RANK ? it.severity : 'medium',
      title: String(it.title || '').trim() || id,
      body: String(it.body || '').trim(),
      location: String(it.location || '').trim(),
      recommendation: String(it.recommendation || '').trim(),
      confidence: Number.isFinite(it.confidence) ? it.confidence : null,
      reply: String(it.reply || '').trim(),
      owner: it.owner === true, // build mode: the reviewer relays the owner's final ruling
    });
  }
  return {
    verdict: raw.verdict,
    summary: String(raw.summary || '').trim(),
    issues: [...issues.values()],
    request_check: normalizeRequestCheck(raw.request_check),
  };
}

// ---------------------------------------------------------------- ledger

function recordRequestRuling(st, { status, notes }) {
  st.requestRuling = { status, notes: notes.trim(), round: st.round };
  const last = st.rounds.at(-1);
  if (last) last.request_ruling = st.requestRuling;
}

function applyResponses(st, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.responses)) {
    throw new UsageError('responses must look like {"changes": "...", "responses": [{"id", "action", "note"}]}');
  }
  if (Object.hasOwn(payload, 'request_ruling')
    && (typeof payload.request_ruling !== 'string' || !payload.request_ruling.trim())) {
    throw new UsageError('request_ruling must be a non-empty string conveying the owner\'s decision');
  }
  const seen = new Set();
  for (const r of payload.responses) {
    const m = /^C-?(\d+)$/i.exec(String(r.id || '').trim());
    const id = m ? `C${Number(m[1])}` : null;
    if (!id || !st.issues[id]) throw new UsageError(`unknown issue id: ${r.id}`);
    if (seen.has(id)) throw new UsageError(`more than one response for ${id}`);
    if (!ACTIONS.includes(r.action)) throw new UsageError(`${id}: action must be one of ${ACTIONS.join(', ')}`);
    if (st.issues[id].status !== 'open') throw new UsageError(`${id} is already ${st.issues[id].status}`);
    if (!String(r.note || '').trim()) throw new UsageError(`${id}: a note is required`);
    seen.add(id);
    r.id = id;
    r.note = String(r.note).trim();
  }
  const missing = Object.values(st.issues)
    .filter((i) => i.status === 'open' && !i.parked && !seen.has(i.id))
    .map((i) => i.id);
  if (missing.length) throw new UsageError(`answer every open issue; missing: ${missing.join(', ')}`);
  if (Object.hasOwn(payload, 'request_ruling')) {
    recordRequestRuling(st, { notes: payload.request_ruling });
  }
  for (const r of payload.responses) {
    const issue = st.issues[r.id];
    issue.author = { action: r.action, note: r.note, round: st.round };
    issue.parked = r.action === 'needs-user';
    issue.history.push({ round: st.round, by: authorOf(st), action: r.action, note: r.note });
  }
}

function mergeReply(st, reply, round) {
  const added = [];
  const closed = [];
  const seen = new Set();
  for (const it of reply.issues) {
    seen.add(it.id);
    const issue = st.issues[it.id];
    if (!issue) {
      if (it.status !== 'open') continue; // "closing" something never raised: ignore
      st.issues[it.id] = {
        id: it.id,
        severity: it.severity,
        title: it.title,
        body: it.body,
        location: it.location,
        recommendation: it.recommendation,
        confidence: it.confidence,
        status: 'open',
        parked: false,
        disputes: 0,
        reopened: 0,
        openedRound: round,
        closedRound: null,
        author: null,
        codexReply: '',
        history: [{ round, by: reviewerOf(st), status: 'open' }],
      };
      added.push(it.id);
      continue;
    }
    let { status } = it;
    const action = issue.author?.action;
    if (it.owner) {
      // The reviewer relays the owner's ruling: final, it unparks the issue and ends the dispute.
      Object.assign(issue, { parked: false, disputes: 0, ownerRuled: true });
      issue.history.push({ round, by: 'duet', note: `owner decision relayed by the reviewer → ${status}` });
    } else {
      if (action === 'owner-decided' && status === 'open') status = 'withdrawn'; // the owner's word is final
      if (issue.parked && status !== 'open') {
        // Only the owner closes a parked issue: the author answers it once the owner has decided.
        issue.history.push({ round, by: 'duet', note: `the reviewer marked this parked issue ${status}; kept open for the owner` });
        status = 'open';
      }
      if (status === 'open' && issue.status === 'open' && action === 'disputed') issue.disputes += 1;
    }
    if (status === 'open' && issue.status !== 'open') {
      issue.reopened += 1;
      issue.closedRound = null;
      issue.author = null;
    }
    if (status !== 'open' && issue.status === 'open') {
      issue.closedRound = round;
      issue.parked = false;
      closed.push(issue.id);
    }
    Object.assign(issue, {
      status,
      severity: it.severity,
      location: it.location || issue.location,
      body: it.body || issue.body,
      recommendation: it.recommendation || issue.recommendation,
      confidence: it.confidence ?? issue.confidence,
      codexReply: it.reply,
    });
    issue.history.push({ round, by: reviewerOf(st), status, reply: it.reply });
  }
  for (const issue of Object.values(st.issues)) {
    if (seen.has(issue.id) || issue.status !== 'open' || issue.openedRound >= round) continue;
    if (issue.author?.action === 'owner-decided') {
      Object.assign(issue, { status: 'withdrawn', closedRound: round, parked: false });
      closed.push(issue.id);
      issue.history.push({ round, by: 'duet', status: 'withdrawn', note: 'owner decision is final' });
    } else if (!issue.parked) {
      issue.history.push({ round, by: 'duet', note: 'the reviewer did not mention this issue; kept open' });
    }
  }
  return { added, closed };
}

const rank = (issue) => SEVERITY_RANK[issue.severity] ?? 0;
const byPriority = (a, b) => rank(b) - rank(a) || idNum(a.id) - idNum(b.id);
const openIssues = (st) => Object.values(st.issues).filter((i) => i.status === 'open' && !i.parked).sort(byPriority);
const parkedIssues = (st) => Object.values(st.issues).filter((i) => i.status === 'open' && i.parked).sort(byPriority);

function buildView(st, reply) {
  const pick = (i) => ({
    id: i.id,
    severity: i.severity,
    title: i.title,
    disputes: i.disputes,
    lastAction: i.author?.action ?? null,
    openedRound: i.openedRound,
  });
  return {
    round: st.round,
    maxRounds: st.maxRounds,
    verdict: reply.verdict,
    open: openIssues(st).map(pick),
    parked: parkedIssues(st).map(pick),
    closedThisRound: Object.values(st.issues).filter((i) => i.closedRound === st.round).map((i) => ({ ...pick(i), status: i.status })),
    history: st.rounds.map((r) => ({ round: r.n, open: r.open })),
  };
}

// The policy decides; the invariants below hold whatever it returns.
async function decide(st, reply) {
  const view = buildView(st, reply);
  let d;
  try {
    const { decideNextStep } = await import(pathToFileURL(POLICY).href);
    d = decideNextStep(structuredClone(view));
  } catch (err) {
    d = { action: 'escalate', reason: `policy error: ${err.message}` };
  }
  if (!d || !(d.action in PHASE_BY_ACTION)) {
    d = { action: 'escalate', reason: `policy returned an invalid result: ${JSON.stringify(d)}` };
  }
  d = { action: d.action, reason: String(d.reason || '').trim() || '(no reason given)', issues: Array.isArray(d.issues) ? d.issues : [] };
  if (d.action === 'continue' && view.open.length === 0) {
    d = view.parked.length
      ? { action: 'escalate', reason: 'only issues parked for the owner remain', issues: view.parked.map((i) => i.id), enforced: true }
      : { action: 'done', reason: 'no open issues left', issues: [], enforced: true };
  }
  if (d.action === 'continue' && view.round >= view.maxRounds) {
    d = { action: 'escalate', reason: `round limit ${view.maxRounds} reached`, issues: view.open.map((i) => i.id), enforced: true };
  }
  if (d.action === 'escalate' && !view.open.length && !view.parked.length) {
    d = { action: 'done', reason: `nothing is left for the owner to decide (policy: ${d.reason})`, issues: [], enforced: true };
  }
  // Apply request checks last: a policy conversion to DONE must not erase a narrowing.
  if (d.action === 'done' && !st.requestRuling) {
    const last = st.rounds.at(-1);
    if (st.kind !== 'build' && normalizeRequestCheck(last?.request_check).status === 'narrowed') {
      d = { action: 'escalate', reason: "the reviewer reports the subject narrows the owner's request", issues: [], enforced: true };
    } else if (st.kind === 'build' && reply.verdict === 'approve'
      && normalizeRequestCheck(last?.request_check, false).status === 'matches'
      && ['narrowed', 'unclear'].includes(codexRequestCheck(st).status)) {
      d = { action: 'escalate', reason: "Codex and Claude disagree on whether the work delivers the owner's request", issues: [], enforced: true };
    }
  }
  if (d.action === 'escalate' && !d.issues.length) d.issues = [...view.open, ...view.parked].map((i) => i.id);
  return d;
}

// ---------------------------------------------------------------- rounds

// Why a Codex turn produced no usable reply, or null when it did.
function turnProblem(res, round) {
  // Codex may exit 0 on SIGTERM; the cause must still read as a cancel, not as a missing reply.
  if (res.cancelled) {
    return 'cancelled: codex-duet received SIGINT or SIGTERM (often the Bash tool\'s limit: run rounds in the background '
      + 'with timeout 43200000, which BASH_MAX_TIMEOUT_MS in ~/.claude/settings.json must allow; retry continues the cut-off turn)';
  }
  if (res.timedOut) {
    const limit = res.timeoutMs >= 60_000 ? `${Math.round(res.timeoutMs / 60_000)} min` : `${res.timeoutMs} ms`;
    return `Codex did not finish within ${limit}`;
  }
  const problem = res.spawnError || res.turnFailed || null;
  if (problem) return problem;
  if (res.code !== 0) return `codex exited with ${res.signal || `code ${res.code}`}${res.lastError ? `: ${res.lastError}` : ''}`;
  if (round === 1 && !res.threadId) return 'Codex did not report a thread id';
  return null;
}

// Keep a failed turn for `retry` and stop with the reason. A turn Codex had begun keeps its thread, so the
// retry can continue it.
function failTurn(st, round, problem, res) {
  st.phase = 'codex-failed';
  st.pending.error = problem;
  if (res.threadId) st.pending.threadId = res.threadId;
  saveState(st);
  const tail = stderrTail(res.errPath);
  throw new Error(`round ${round} failed: ${problem}${tail ? `\n--- codex stderr (tail) ---\n${tail}` : ''}\n`
    + `Fix the cause, then run: node "${SELF}" retry --session ${st.id}`);
}

// A retried turn that Codex had begun before it was cut off (a time limit, a stop) goes on in that turn's own
// thread with a short "carry on" prompt, so the work and the context built in it are kept, a first round's
// too. Only while Codex's log of that thread exists; else, and after `retry --fresh`, the turn starts over.
function interruptedThread(st) {
  const id = st.pending?.threadId;
  return id && rolloutOf(st, id) ? id : null;
}

// The caller holds the session lock for the whole round.
async function runRound(st, round, payload) {
  clearApproval(st);
  const prev = st.rounds.at(-1)?.snapshot ?? null;
  const snap = takeSnapshot(st, round);
  const cutOff = interruptedThread(st);
  const prompt = cutOff ? template('resume.md') : buildPrompt(st, round, snap, prev, payload);
  const release = await takeSlot(st, round, { payload, threadId: cutOff ?? undefined });
  const startedAt = now();
  st.phase = 'awaiting-codex';
  st.pending = { round, startedAt, payload, codexModel: turnModel(st) };
  saveState(st);

  let res;
  try {
    res = await runCodex(st, round, prompt, cutOff ?? (round === 1 ? null : st.codex.threadId));
  } finally {
    release();
  }
  let problem = turnProblem(res, round);
  let reply = null;
  if (!problem) {
    try {
      reply = normalizeReply(readJSON(res.out));
    } catch (err) {
      problem = `unreadable Codex reply: ${err.message}`;
    }
  }
  if (problem) failTurn(st, round, problem, res);

  if (round === 1) st.codex.threadId = res.threadId;
  const delta = mergeReply(st, reply, round);
  st.round = round;
  st.rounds.push({
    n: round,
    verdict: reply.verdict,
    summary: reply.summary,
    request_check: reply.request_check,
    snapshot: snap,
    startedAt,
    finishedAt: now(),
    usage: res.usage,
    codexModel: st.pending?.codexModel ?? null,
    added: delta.added,
    closed: delta.closed,
    open: openIssues(st).length,
    parked: parkedIssues(st).length,
  });
  delete st.pending;
  await settle(st, reply);
}

// Decide what comes next, persist it, and print the summary (plus the report when the loop stops).
async function settle(st, reply) {
  st.decision = await decide(st, reply);
  st.phase = PHASE_BY_ACTION[st.decision.action];
  recordApproval(st);
  saveState(st);
  if (st.phase !== 'awaiting-author') fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), renderReport(st));
  process.stdout.write(`${renderSummary(st)}\n`);
}

// At the round limit the owner's final word needs no reviewer: record it and decide again.
async function recordOwnerDecisions(st, payload) {
  applyResponses(st, payload);
  for (const r of payload.responses) {
    const issue = st.issues[r.id];
    Object.assign(issue, { status: 'withdrawn', closedRound: st.round, parked: false });
    issue.history.push({ round: st.round, by: 'duet', status: 'withdrawn', note: 'owner decision recorded at the round limit, without another Codex round' });
  }
  await settle(st, { verdict: st.rounds.at(-1).verdict });
}

// ---------------------------------------------------------------- build mode
// The roles swap: Codex implements in a worktree on a branch of its own, Claude reviews.

const reviewerOf = (st) => (st.kind === 'build' ? 'claude' : 'codex');
const authorOf = (st) => (st.kind === 'build' ? 'codex' : 'claude');
const REVIEW_DIFF_LIMIT = 40_000; // chars of a round's diff printed for the reviewer; the rest is one command away

async function initBuildSubject(st, o, dir) {
  if (o.subject.length !== 1) throw new UsageError('--kind build needs one --subject: the specification file, or - for stdin');
  const top = git(['rev-parse', '--show-toplevel'], { cwd: st.cwd, allowFail: true });
  if (top.status !== 0) throw new UsageError('--kind build runs inside a git repository');
  const repo = fs.realpathSync(top.stdout.trim());
  const base = git(['rev-parse', '--verify', '-q', `${o.base || 'HEAD'}^{commit}`], { cwd: repo, allowFail: true });
  if (base.status !== 0) throw new UsageError(o.base ? `unknown --base: ${o.base}` : '--kind build needs a commit to branch from');
  const spec = o.subject[0] === '-' ? await readStdin() : fs.readFileSync(path.resolve(st.cwd, o.subject[0]), 'utf8');
  if (!hasOwnerRequest(spec)) throw new UsageError("add a non-empty `## Owner's request` section (ASCII apostrophe) to the specification, quoting the owner's own words");
  fs.writeFileSync(path.join(dir, 'spec.md'), spec);
  st.brief = path.join(dir, 'spec.md');
  const branch = checkToken(o.branch, 'branch', /^[\w./-]+$/) ?? `codex-duet/${st.id}`;
  const worktree = path.join(dir, 'worktree');
  const added = git(['worktree', 'add', '-q', '-b', branch, worktree, base.stdout.trim()], { cwd: repo, allowFail: true });
  if (added.status !== 0) throw new UsageError(`cannot create the worktree: ${(added.stderr || '').trim()}`);
  st.subject = {
    repo,
    worktree: fs.realpathSync(worktree),
    branch,
    base: base.stdout.trim(),
    spec: path.join(dir, 'spec.md'),
    mainDirty: git(['status', '--porcelain'], { cwd: repo }).stdout.trim() !== '',
  };
  st.cwd = st.subject.worktree;
}

function removeWorktree(st, { deleteBranch }) {
  const { repo, worktree, branch } = st.subject;
  git(['worktree', 'remove', '--force', worktree], { cwd: repo, allowFail: true });
  git(['worktree', 'prune'], { cwd: repo, allowFail: true });
  if (deleteBranch) git(['branch', '-D', branch], { cwd: repo, allowFail: true });
}

function normalizeAuthorReply(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a JSON object');
  const responses = new Map();
  for (const r of Array.isArray(raw.responses) ? raw.responses : []) {
    const m = /^C-?(\d+)$/i.exec(String(r.id || '').trim());
    if (!m) throw new Error(`bad issue id: ${r.id}`);
    const id = `C${Number(m[1])}`;
    if (responses.has(id)) throw new Error(`issue ${id} is answered more than once`);
    if (!['fixed', 'disputed', 'needs-user'].includes(r.action)) throw new Error(`bad action for ${id}: ${r.action}`);
    responses.set(id, { id, action: r.action, note: String(r.note || '').trim() });
  }
  return {
    summary: String(raw.summary || '').trim() || '(no summary)',
    tests: String(raw.tests || '').trim() || '(not reported)',
    responses: [...responses.values()],
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map((q) => String(q).trim()).filter(Boolean),
    request_check: normalizeRequestCheck(raw.request_check, false),
  };
}

// Codex answers the review: answers to closed or unknown issues are dropped, unanswered ones stay open.
function applyAuthorReply(st, reply, round) {
  const answered = [];
  for (const r of reply.responses) {
    const issue = st.issues[r.id];
    if (!issue || issue.status !== 'open') continue;
    issue.author = { action: r.action, note: r.note, round };
    issue.parked = r.action === 'needs-user';
    issue.history.push({ round, by: 'codex', action: r.action, note: r.note });
    answered.push(r.id);
  }
  for (const issue of openIssues(st)) {
    if (!answered.includes(issue.id)) issue.history.push({ round, by: 'duet', note: 'the implementer did not answer this issue' });
  }
}

function workspaceText(st) {
  const { worktree, branch, base, repo } = st.subject;
  return `Worktree (work only here): ${worktree}\nBranch: ${branch}, started from ${base.slice(0, 10)} of the repository ${repo}`;
}

function issuesForAuthor(st) {
  const lines = [];
  for (const i of openIssues(st)) {
    lines.push(`- ${i.id} [${i.severity}] ${i.title}${i.location ? ` — ${i.location}` : ''}`);
    if (i.body) lines.push(`  problem: ${indent(i.body, '  ')}`);
    if (i.recommendation) lines.push(`  suggested fix: ${indent(i.recommendation, '  ')}`);
    // codexReply holds the reviewer's latest reply: Claude's, in build mode
    if (i.codexReply) lines.push(`  ${i.ownerRuled ? 'Owner decision (final)' : 'architect on your last answer'}: ${indent(i.codexReply, '  ')}`);
  }
  return lines.join('\n') || '(no open issues: check your work against the specification once more)';
}

// One implementation turn of Codex. The caller holds the session lock.
async function runBuildTurn(st, round, review) {
  clearApproval(st);
  const cutOff = interruptedThread(st);
  const prompt = cutOff
    ? template('resume.md')
    : round === 1
      ? fill(template('build-round1.md'), { WORKSPACE: workspaceText(st), SPEC: fs.readFileSync(st.subject.spec, 'utf8').trim() })
      : fill(template('build-roundN.md'), {
        ROUND: round,
        VERDICT: review.verdict,
        SUMMARY: review.summary || '(no summary)',
        ISSUES: issuesForAuthor(st),
        REQUEST_RULING: requestRulingLine(st),
      });
  const release = await takeSlot(st, round, { review, threadId: cutOff ?? undefined });
  const startedAt = now();
  st.phase = 'awaiting-codex';
  st.pending = { round, startedAt, review, codexModel: turnModel(st) };
  saveState(st);

  let res;
  try {
    res = await runCodex(st, round, prompt, cutOff ?? (round === 1 ? null : st.codex.threadId), BUILD_SCHEMA);
  } finally {
    release();
  }
  let problem = turnProblem(res, round);
  let reply = null;
  if (!problem) {
    try {
      reply = normalizeAuthorReply(readJSON(res.out));
    } catch (err) {
      problem = `unreadable Codex reply: ${err.message}`;
    }
  }
  if (problem) failTurn(st, round, problem, res);

  if (round === 1) st.codex.threadId = res.threadId;
  applyAuthorReply(st, reply, round);
  st.round = round;
  st.rounds.push({
    n: round,
    author: { summary: reply.summary, tests: reply.tests, questions: reply.questions, request_check: reply.request_check },
    snapshot: takeSnapshot(st, round),
    startedAt,
    finishedAt: now(),
    usage: res.usage,
    codexModel: st.pending?.codexModel ?? null,
    verdict: null,
    summary: '',
    open: openIssues(st).length,
    parked: parkedIssues(st).length,
  });
  delete st.pending;
  st.phase = 'awaiting-review';
  saveState(st);
  process.stdout.write(`${renderBuildSummary(st)}\n`);
}

function renderBuildSummary(st, approvalCheck = null) {
  const last = st.rounds.at(-1);
  const { worktree, branch, base } = st.subject;
  const L = [
    `## codex-duet ${st.id} · build · round ${st.round}/${st.maxRounds} (${duration(last.startedAt, last.finishedAt)})`,
    `Worktree: ${worktree} (branch ${branch})`,
    modelLine(st),
    ...requestCheckLines(st),
  ];
  if (st.phase === 'awaiting-review') {
    L.push(`${last.kind === 'post-approval' ? 'Changes' : 'Codex'}: ${indent(last.author.summary)}`, `Tests: ${indent(last.author.tests)}`);
    if (last.pathStates) L.push(...pathStateLines(last.pathStates));
    if (last.author.questions.length) L.push('Questions:', ...last.author.questions.map((q) => `- ${indent(q)}`));
    const answers = Object.values(st.issues).filter((i) => i.author?.round === st.round).sort(byPriority);
    if (answers.length) {
      L.push('', '### Codex on your issues');
      for (const i of answers) L.push(`- ${i.id} [${i.severity}] ${i.title} → ${i.author.action}: ${indent(i.author.note)}`);
    }
    const silent = openIssues(st).filter((i) => i.author?.round !== st.round);
    if (silent.length) L.push(`Not answered by Codex: ${silent.map((i) => i.id).join(', ')}`);
    const prev = last.diffBase ?? st.rounds.at(-2)?.snapshot.tree ?? base;
    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M'];
    const stat = git([...diffArgs, '--stat=200', base, last.snapshot.tree], { cwd: worktree }).stdout.trim();
    const diff = git([...diffArgs, prev, last.snapshot.tree], { cwd: worktree }).stdout;
    L.push(
      '',
      `### Branch vs base (git diff ${base.slice(0, 10)} ${last.snapshot.tree.slice(0, 10)})`,
      stat || '(no changes)',
      '',
      `### This round (git -C "${worktree}" diff ${prev.slice(0, 10)} ${last.snapshot.tree.slice(0, 10)} -- <path>)`,
      '```diff',
      diff.length > REVIEW_DIFF_LIMIT ? `${diff.slice(0, REVIEW_DIFF_LIMIT)}\n... (truncated: inspect the rest per file with the command above)` : (diff.trim() || '(no changes)'),
      '```',
      '',
      "Next: review (read files in the worktree where needed, run the tests there), independently check the owner's request and accepted amendments in the spec, then run:",
      'Approval requires request_check; if narrowed, raise an issue for each gap instead of approving.',
      '```bash',
      `node "${SELF}" review --session ${st.id} --issues - <<'DUET_JSON'`,
      '{"verdict": "approve|revise", "summary": "<one or two sentences>",',
      ' "request_check": {"status": "matches|narrowed|unclear", "notes": "<your independent check>"}, "issues": [',
      '  {"id": "C1", "status": "open|resolved|withdrawn", "severity": "critical|high|medium|low", "title": "…", "body": "…", '
        + '"location": "path:line", "recommendation": "…", "confidence": 0.8, "reply": "", "owner": false}',
      ']}',
      'DUET_JSON',
      '```',
    );
    return L.join('\n');
  }
  const d = st.decision;
  if (last.verdict) L.push(`Your verdict: ${last.verdict} — ${last.summary}`);
  if (d) L.push(`Decision: ${d.action.toUpperCase()} — ${d.reason}${d.enforced ? ' (enforced by duet.mjs)' : ''}`);
  const open = openIssues(st);
  const parked = parkedIssues(st);
  if (open.length) L.push('', `### Open (${open.length})`, ...open.map((i) => `- ${i.id} [${i.severity}] ${i.title}`));
  if (parked.length) L.push('', `### Parked for the owner (${parked.length})`, ...parked.map((i) => `- ${i.id} [${i.severity}] ${i.title} — Codex: ${indent(i.author?.note || '')}`));
  if (d?.action === 'escalate') {
    L.push('', "### Needs the owner's decision");
    for (const id of d.issues) {
      const i = st.issues[id];
      if (i) L.push(`- **${i.id}** [${i.severity}] ${i.title}`, `  Codex: ${indent(i.author?.note || '(no answer)')}`, `  Claude: ${indent(i.codexReply || i.recommendation || i.body)}`);
    }
  }
  if (d?.action === 'done') {
    L.push('', `Base: ${base}`, `Approved tree: ${st.approval?.tree ?? 'none'}`);
    if (approvalCheck && !approvalCheck.matches) {
      L.push('The worktree already differs from the reviewed snapshot; finish will send these paths back for review.',
        ...pathStateLines(approvalCheck.paths));
    }
    L.push('', `Ready. Ask the owner, then: node "${SELF}" finish --session ${st.id} (commit on ${branch}, remove the worktree) or discard`);
  }
  L.push('', `Report: ${path.join(sessionDir(st.id), 'report.md')}`);
  return L.join('\n');
}

async function cmdReview(o) {
  if (!o.issues) throw new UsageError('pass --issues <file>, or --issues - with a heredoc');
  const { id } = resolveSession(o.session);
  const raw = o.issues === '-' ? await readStdin() : fs.readFileSync(path.resolve(o.issues), 'utf8');
  let review;
  try {
    const parsed = JSON.parse(raw);
    const check = parsed?.request_check;
    if (check?.owner != null && typeof check.owner !== 'boolean') throw new Error('request_check.owner must be a boolean');
    if (check?.owner === true && !validOwnerRequestCheck(check)) {
      throw new Error('an owner ruling in request_check needs status matches or narrowed-accepted and non-empty decision notes');
    }
    if (check?.status === 'narrowed-accepted' && check.owner !== true) {
      throw new Error('request_check narrowed-accepted requires owner: true to relay an owner ruling');
    }
    if (parsed?.verdict === 'approve' && check?.owner !== true) {
      if (!validRequestCheck(parsed.request_check, false)) {
        throw new Error("approve requires a valid request_check: independently check the work against the owner's request and accepted amendments in the spec");
      }
      if (parsed.request_check.status === 'narrowed') {
        throw new Error('approve with request_check narrowed is refused: raise an issue for each gap instead');
      }
    }
    review = normalizeReply(parsed);
    review.request_check = normalizeBuildReviewCheck(check);
  } catch (err) {
    throw new UsageError(`the review is not valid: ${err.message}`);
  }
  const release = acquireLock(id);
  try {
    const st = loadState(id);
    if (st.kind === 'audit') throw new UsageError(AUDIT_HAS_NO_ROUNDS);
    if (st.kind !== 'build') throw new UsageError('review is for --kind build sessions; answer a Codex review with reply');
    guardIdle(st);
    if (!['awaiting-review', 'escalated', 'done'].includes(st.phase)) throw new UsageError(`nothing to review now (phase: ${st.phase})`);
    switchCodex(st, o);
    if (o['max-rounds']) st.maxRounds = toInt(o['max-rounds'], 'max-rounds');
    if (review.request_check.owner === true) recordRequestRuling(st, review.request_check);
    mergeReply(st, review, st.round);
    Object.assign(st.rounds.at(-1), {
      verdict: review.verdict,
      summary: review.summary,
      request_check: review.request_check,
      open: openIssues(st).length,
      parked: parkedIssues(st).length,
    });
    st.decision = await decide(st, review);
    // The owner has ruled: Codex gets a turn to act on it, whatever the stall rule thinks of the history.
    const ruled = review.issues.some((i) => i.owner) && openIssues(st).length > 0;
    if (ruled && st.decision.action === 'escalate' && st.round < st.maxRounds) {
      st.decision = { action: 'continue', reason: 'the owner ruled; Codex acts on it', issues: [], enforced: true };
    }
    recordApproval(st);
    if (st.decision.action === 'continue') {
      saveState(st);
      await runBuildTurn(st, st.round + 1, review);
      return;
    }
    st.phase = PHASE_BY_ACTION[st.decision.action];
    const approvalCheck = st.approval ? currentApprovalCheck(st) : null;
    saveState(st);
    fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), renderReport(st));
    process.stdout.write(`${renderBuildSummary(st, approvalCheck)}\n`);
  } finally {
    release();
  }
}

// The spec's title becomes the subject as written: a cut at a fixed width split real titles mid-phrase. Only a
// spec that opens with a paragraph instead of a heading is cut, at a word boundary, to keep the subject a line.
const SUBJECT_MAX = 120;

function specTitle(st) {
  const first = fs.readFileSync(st.subject.spec, 'utf8').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || 'implementation';
  if (first.length <= SUBJECT_MAX) return first;
  const head = first.slice(0, SUBJECT_MAX);
  const space = head.lastIndexOf(' ');
  return `${(space > SUBJECT_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

// The runner's commit names itself once: a title that starts with codex-duet already does.
const commitSubject = (title) => (/^codex-duet\b/i.test(title) ? title : `codex-duet: ${title}`);

function postApprovalRound(st, tree, cause) {
  const approval = st.approval;
  const paths = pathStates(st, approval.tree, tree);
  st.round += 1;
  st.rounds.push({
    n: st.round,
    kind: 'post-approval',
    cause,
    author: { summary: `Changed after the approval, not by Codex. ${cause}`, tests: 'No Codex turn in this round.', questions: [] },
    snapshot: { tree },
    diffBase: approval.tree,
    pathStates: paths,
    startedAt: now(),
    finishedAt: now(),
    verdict: null,
    summary: '',
    open: openIssues(st).length,
    parked: parkedIssues(st).length,
  });
  clearApproval(st);
  st.decision = null;
  st.phase = 'awaiting-review';
  saveState(st);
  fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), renderReport(st));
  process.stdout.write(`Nothing was committed; ${cause} The content is back for review.\n${renderBuildSummary(st)}\n`);
}

async function cmdFinish(o) {
  const { id } = resolveSession(o.session);
  const release = acquireLock(id);
  try {
    const st = loadState(id);
    if (st.kind !== 'build') throw new UsageError('finish is for --kind build sessions');
    guardIdle(st);
    const { repo, worktree, branch, base } = st.subject;
    if (!fs.existsSync(worktree)) throw new UsageError(`the worktree is gone already (phase: ${st.phase})`);
    if (!st.approval && !o.unreviewed) {
      throw new UsageError('the content was not approved; the owner can finish anyway with finish --unreviewed');
    }
    const current = snapshotTree(st, `finish-${process.pid}`);
    if (!o.unreviewed && current !== st.approval.tree) {
      postApprovalRound(st, current, 'The worktree changed after the approval.');
      return;
    }
    const finish = { unreviewed: Boolean(o.unreviewed), round: st.round, phase: st.phase, at: now() };
    const unreviewedNote = `Owner finished without an approval (round ${st.round}, phase ${st.phase}); session ${st.id}.`;
    const previousHead = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim();
    // A rejected commit leaves the session and the user's staging as they were.
    const index = path.resolve(worktree, git(['rev-parse', '--git-path', 'index'], { cwd: worktree }).stdout.trim());
    const indexBefore = fs.existsSync(index) ? { data: fs.readFileSync(index), stat: fs.statSync(index) } : null;
    try {
      git(['add', '-A'], { cwd: worktree });
      if (git(['diff', '--cached', '--quiet'], { cwd: worktree, allowFail: true }).status !== 0) {
        git(['commit', '-q', '-m', commitSubject(specTitle(st)), '-m', o.unreviewed ? unreviewedNote
          : `Implemented by Codex, reviewed by Claude in ${st.round} round(s); session ${st.id}.`], { cwd: worktree });
      }
    } catch (err) {
      if (indexBefore) {
        fs.writeFileSync(index, indexBefore.data);
        fs.utimesSync(index, indexBefore.stat.atime, indexBefore.stat.mtime);
      } else fs.rmSync(index, { force: true });
      throw err;
    }
    const head = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim();
    const committedTree = git(['rev-parse', 'HEAD^{tree}'], { cwd: worktree }).stdout.trim();
    if (!o.unreviewed && committedTree !== st.approval.tree) {
      git(['reset', '--soft', previousHead], { cwd: worktree });
      postApprovalRound(st, snapshotTree(st, `hooks-${process.pid}`), 'Commit hooks changed the approved content; their commit was undone.');
      return;
    }
    if (o.unreviewed) {
      const lastApproval = st.approval ?? st.lastApproval;
      finish.approvedTree = lastApproval?.tree ?? null;
      finish.pathStates = compareApproval(st, committedTree, lastApproval).paths;
    }
    removeWorktree(st, { deleteBranch: false });
    Object.assign(st.subject, { commit: head, committedTree });
    st.finish = finish;
    st.phase = 'finished';
    saveState(st);
    fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), renderReport(st));
    console.log([
      `codex-duet ${st.id}: ${branch} is at ${head.slice(0, 10)}; the worktree is removed.`,
      ...approvalReportLines(st),
      `Look:  git -C "${repo}" log --stat ${base.slice(0, 10)}..${branch}`,
      `Merge: git -C "${repo}" merge ${branch}`,
      `Drop:  git -C "${repo}" branch -D ${branch}`,
    ].join('\n'));
  } finally {
    release();
  }
}

async function cmdDiscard(o) {
  const { id } = resolveSession(o.session);
  const release = acquireLock(id);
  try {
    const st = loadState(id);
    if (st.kind !== 'build') throw new UsageError('discard is for --kind build sessions');
    guardIdle(st);
    removeWorktree(st, { deleteBranch: true });
    st.phase = 'discarded';
    saveState(st);
    console.log(`codex-duet ${st.id}: the worktree is removed and ${st.subject.branch} is deleted.`);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- output

// ---- audit: one read-only Codex turn on a task, findings with evidence, no negotiation

const AUDIT_HAS_NO_ROUNDS = 'an audit has nothing to answer: it ends with its report (status, report); '
  + 'for another look, start a new audit with a sharper task';

// The subject is the task: what Codex examines in the current directory and reports on.
async function initAuditSubject(st, o, dir) {
  if (o.subject.length !== 1) throw new UsageError('--kind audit needs one --subject: the task file, or - for stdin');
  const task = o.subject[0] === '-' ? await readStdin() : fs.readFileSync(path.resolve(st.cwd, o.subject[0]), 'utf8');
  if (!task.trim()) throw new UsageError('the audit task is empty');
  fs.writeFileSync(path.join(dir, 'task.md'), task);
  const title = task.split('\n').map((line) => line.replace(/^[\s#>*-]+/, '').trim()).find(Boolean) ?? 'audit';
  st.subject = { task: path.join(dir, 'task.md'), title: title.length > 80 ? `${title.slice(0, 79)}…` : title };
}

function auditWorkspace(st) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd: st.cwd, allowFail: true });
  if (top.status !== 0) return `Directory: ${st.cwd}`;
  const branch = git(['branch', '--show-current'], { cwd: st.cwd, allowFail: true }).stdout.trim();
  const head = git(['rev-parse', '--short', 'HEAD'], { cwd: st.cwd, allowFail: true }).stdout.trim();
  return `Directory: ${st.cwd}\nGit repository ${top.stdout.trim()}, ${branch ? `branch ${branch}` : 'detached HEAD'} at ${head || '(no commits)'}`;
}

// Codex's ids stand when they are unique, so its notes can cite them; the rest get the next free A<n>.
function normalizeAuditReply(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.findings)) throw new Error('expected {summary, findings, coverage, notes}');
  const taken = new Set();
  const given = raw.findings.map((f) => {
    const id = String(f?.id ?? '').trim();
    if (!/^[A-Za-z]*\d+$/.test(id) || taken.has(id)) return null;
    taken.add(id);
    return id;
  });
  let next = 1;
  const freeId = () => {
    while (taken.has(`A${next}`)) next += 1;
    taken.add(`A${next}`);
    return `A${next}`;
  };
  const findings = raw.findings.map((f, n) => {
    if (!f || typeof f !== 'object') throw new Error(`finding ${n + 1} is not an object`);
    const confidence = Number(f.confidence);
    return {
      id: given[n] ?? freeId(),
      severity: f.severity in SEVERITY_RANK ? f.severity : 'medium',
      title: oneLine(f.title) || '(untitled)',
      body: String(f.body ?? '').trim(),
      location: oneLine(f.location),
      recommendation: String(f.recommendation ?? '').trim(),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    };
  });
  const text = (value) => String(value ?? '').trim();
  return { summary: text(raw.summary), findings, coverage: text(raw.coverage), notes: text(raw.notes) };
}

// The one turn of an audit, in the session's directory with a read-only sandbox. The caller holds the lock.
async function runAuditTurn(st) {
  const round = 1;
  const cutOff = interruptedThread(st);
  const prompt = cutOff
    ? template('resume.md')
    : fill(template('audit.md'), { TASK: fs.readFileSync(st.subject.task, 'utf8').trim(), WORKSPACE: auditWorkspace(st) });
  const release = await takeSlot(st, round, { threadId: cutOff ?? undefined });
  const startedAt = now();
  st.phase = 'awaiting-codex';
  st.pending = { round, startedAt, codexModel: turnModel(st) };
  saveState(st);

  let res;
  try {
    res = await runCodex(st, round, prompt, cutOff, AUDIT_SCHEMA);
  } finally {
    release();
  }
  let problem = turnProblem(res, round);
  let reply = null;
  if (!problem) {
    try {
      reply = normalizeAuditReply(readJSON(res.out));
    } catch (err) {
      problem = `unreadable Codex reply: ${err.message}`;
    }
  }
  if (problem) failTurn(st, round, problem, res);

  st.codex.threadId = res.threadId;
  st.findings = reply.findings;
  st.audit = { summary: reply.summary, coverage: reply.coverage, notes: reply.notes };
  st.round = round;
  st.rounds.push({
    n: round,
    verdict: null,
    summary: reply.summary,
    startedAt,
    finishedAt: now(),
    usage: res.usage,
    codexModel: st.pending?.codexModel ?? null,
    open: reply.findings.length,
    parked: 0,
  });
  delete st.pending;
  st.phase = 'done';
  st.decision = { action: 'done', reason: `audit finished, findings: ${countBySeverity(reply.findings) || 'none'}`, issues: [] };
  saveState(st);
  fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), renderAuditReport(st));
  process.stdout.write(`${renderAuditSummary(st)}\n`);
}

// "5 (critical 1 · high 2 · medium 2)"
function countBySeverity(findings) {
  if (!findings.length) return '';
  const parts = Object.keys(SEVERITY_RANK).map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  return `${findings.length} (${parts.map(([s, n]) => `${s} ${n}`).join(' · ')})`;
}

// What Claude reads: the result and one line per finding. The evidence stays in the report.
function renderAuditSummary(st) {
  const last = st.rounds.at(-1);
  const findings = st.findings ?? [];
  return [
    `## codex-duet ${st.id} · audit (${duration(last.startedAt, last.finishedAt)})`,
    `Task: ${st.subject.title} (${st.subject.task})`,
    `Directory: ${st.cwd}`,
    modelLine(st),
    `Result: ${indent(st.audit.summary || '(no summary)')}`,
    `Findings: ${countBySeverity(findings) || 'none'}`,
    ...findings.map((f) => `- ${f.id} [${f.severity}] ${f.title}${f.location ? ` — ${f.location}` : ''}`),
    `Coverage: ${indent(st.audit.coverage || '(not stated)')}`,
    '',
    `Report (evidence, recommendations, notes): ${path.join(sessionDir(st.id), 'report.md')}`,
    'Next: present the result to the user. Nothing to answer: an audit ends with its report.',
  ].join('\n');
}

function renderAuditReport(st) {
  const last = st.rounds.at(-1);
  const findings = st.findings ?? [];
  const L = [
    `# codex-duet audit — ${st.subject.title}`,
    '',
    `- Session: ${st.id}`,
    `- Directory: ${st.cwd}`,
    `- Codex: ${[last.codexModel?.model, last.codexModel?.effort].filter(Boolean).join(' · ') || 'its config'}, ${duration(last.startedAt, last.finishedAt)}`,
    `- Codex thread: ${st.codex.threadId} (continue it in Codex: codex resume ${st.codex.threadId})`,
    '',
    '## Result',
    '',
    st.audit.summary || '(no summary)',
    '',
    `## Findings (${countBySeverity(findings) || 'none'})`,
  ];
  for (const f of findings) {
    L.push('', `### ${f.id} [${f.severity}] ${f.title}`);
    if (f.location) L.push(`Location: ${f.location}`);
    if (f.confidence !== null) L.push(`Confidence: ${f.confidence}`);
    if (f.body) L.push('', f.body);
    if (f.recommendation) L.push('', `Recommendation: ${f.recommendation}`);
  }
  L.push('', '## Coverage', '', st.audit.coverage || '(not stated)');
  if (st.audit.notes) L.push('', '## Notes', '', st.audit.notes);
  L.push('', '## Task', '', fs.readFileSync(st.subject.task, 'utf8').trim(), '');
  return L.join('\n');
}

function subjectLine(st) {
  if (st.kind === 'audit') return `${st.cwd} (task: ${st.subject.title})`;
  if (st.kind === 'build') return `${st.subject.worktree} (branch ${st.subject.branch})`;
  if (st.kind === 'code') return `${st.cwd} (${st.subject.target})`;
  const inSession = (file) => file.startsWith(sessionDir(st.id));
  return st.subject.paths.map((file) => (inSession(file) ? `${file} (edit this file between rounds)` : file)).join(', ');
}

function duration(from, to) {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function renderIssue(issue, round) {
  const tags = [
    issue.openedRound === round ? 'new' : '',
    issue.reopened ? 'reopened' : '',
    issue.disputes ? `disputes: ${issue.disputes}` : '',
  ].filter(Boolean).join(', ');
  const lines = [`- **${issue.id}** [${issue.severity}] ${issue.title}${issue.location ? ` — ${issue.location}` : ''}${tags ? ` (${tags})` : ''}`];
  if (issue.body) lines.push(`  Problem: ${indent(issue.body)}`);
  if (issue.recommendation) lines.push(`  Suggested fix: ${indent(issue.recommendation)}`);
  if (issue.codexReply && issue.openedRound !== round) lines.push(`  Codex on your last answer: ${indent(issue.codexReply)}`);
  return lines;
}

function renderPositions(issue) {
  return [
    `- **${issue.id}** [${issue.severity}] ${issue.title}${issue.location ? ` — ${issue.location}` : ''}`,
    `  Codex: ${indent(issue.codexReply || issue.body)}`,
    `  Claude: ${indent(issue.author?.note || '(no answer yet)')}`,
  ];
}

const requestCheckText = (check) => `${check.status} — ${oneLine(check.notes)}`;
const requestRulingLine = (st) => st.requestRuling
  ? `Owner decision (final): ${st.requestRuling.status ? `${st.requestRuling.status} — ` : ''}${oneLine(st.requestRuling.notes)}`
  : '(none recorded)';

function codexRequestCheck(st) {
  const last = st.kind === 'build' ? st.rounds.findLast((r) => r.kind !== 'post-approval') : st.rounds.at(-1);
  return normalizeRequestCheck(st.kind === 'build' ? last?.author?.request_check : last?.request_check, st.kind !== 'build');
}

function requestCheckLines(st) {
  const L = st.kind !== 'build' && !st.brief ? ['Owner brief: none'] : [];
  L.push(`Owner's request: ${requestCheckText(codexRequestCheck(st))}`);
  if (st.kind === 'build') {
    const reviewed = st.rounds.findLast((r) => r.verdict);
    if (reviewed) {
      const earlier = reviewed.n !== st.round ? `, round ${reviewed.n}` : '';
      L.push(`Owner's request (Claude${earlier}): ${requestCheckText(normalizeBuildReviewCheck(reviewed.request_check))}`);
    }
  }
  if (st.requestRuling) L.push(requestRulingLine(st));
  return L;
}

function renderSummary(st) {
  const last = st.rounds.at(-1);
  const d = st.decision;
  const open = openIssues(st);
  const parked = parkedIssues(st);
  const closedNow = Object.values(st.issues).filter((i) => i.closedRound === st.round).sort(byPriority);
  const L = [
    `## codex-duet ${st.id} · ${st.kind} · round ${st.round}/${st.maxRounds} (${duration(last.startedAt, last.finishedAt)})`,
    `Subject: ${subjectLine(st)}`,
    modelLine(st),
    `Codex verdict: ${last.verdict} — ${last.summary}`,
    ...requestCheckLines(st),
    `Decision: ${d.action.toUpperCase()} — ${d.reason}${d.enforced ? ' (enforced by duet.mjs)' : ''}`,
  ];
  if (closedNow.length) {
    L.push('', `### Closed this round (${closedNow.length})`);
    for (const i of closedNow) L.push(`- ${i.id} [${i.severity}] ${i.title} → ${i.status}${i.codexReply ? ` — Codex: ${indent(i.codexReply)}` : ''}`);
  }
  if (open.length) {
    L.push('', `### Open (${open.length})`);
    for (const i of open) L.push(...renderIssue(i, st.round));
  }
  if (parked.length) {
    L.push('', `### Parked for the owner (${parked.length})`);
    for (const i of parked) L.push(`- ${i.id} [${i.severity}] ${i.title} — ${indent(i.author?.note || '')}`);
  }
  if (d.action === 'continue') {
    L.push(
      '',
      'Next: fix or dispute every open issue (see references/protocol.md), then run:',
      '```bash',
      `node "${SELF}" reply --session ${st.id} --responses - <<'DUET_JSON'`,
      '{"changes": "<what changed since the last round>", "responses": [',
      '  {"id": "C1", "action": "fixed|disputed|needs-user|owner-decided", "note": "<evidence>"}',
      ']}',
      'DUET_JSON',
      '```',
    );
    return L.join('\n');
  }
  if (d.action === 'escalate') {
    L.push('', "### Needs the owner's decision");
    for (const id of d.issues) if (st.issues[id]) L.push(...renderPositions(st.issues[id]));
  }
  L.push('', `Report: ${path.join(sessionDir(st.id), 'report.md')}`);
  return L.join('\n');
}

function outcome(issue, st) {
  if (issue.status === 'open') return issue.parked ? 'OPEN (owner decision)' : 'OPEN';
  if (issue.status === 'resolved') return 'resolved';
  if (issue.author?.action === 'owner-decided' || issue.ownerRuled) return 'withdrawn (owner decision)';
  return `withdrawn by ${reviewerOf(st) === 'codex' ? 'Codex' : 'Claude'}`;
}

function renderReport(st) {
  const all = Object.values(st.issues).sort(byPriority);
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const L = [
    `# codex-duet report — ${st.id}`,
    '',
    `- Kind: ${st.kind}`,
    `- Subject: ${subjectLine(st)}`,
    `- Rounds: ${st.round}/${st.maxRounds}`,
    `- Outcome: ${st.decision?.action ?? st.phase} — ${st.decision?.reason ?? ''}`,
    `- Codex thread: ${st.codex.threadId} (continue it in Codex: codex resume ${st.codex.threadId})`,
    ...approvalReportLines(st).map((line) => line.startsWith('- ') ? line : `- ${line}`),
    '',
    "## Owner's request",
    '',
    `Owner brief: ${st.brief || 'none'}`,
    `Codex: ${requestCheckText(codexRequestCheck(st))}`,
    ...(st.kind === 'build' ? [`Claude: ${requestCheckText(normalizeBuildReviewCheck(st.rounds.findLast((r) => r.verdict)?.request_check))}`] : []),
    ...(st.requestRuling ? [requestRulingLine(st)] : []),
    '',
    '| ID | Severity | Title | Outcome | Rounds |',
    '|---|---|---|---|---|',
    ...all.map((i) => `| ${i.id} | ${i.severity} | ${cell(i.title)} | ${outcome(i, st)} | ${i.openedRound}–${i.closedRound ?? st.round} |`),
    '',
    '## Details',
  ];
  for (const i of all) {
    L.push('', `### ${i.id} [${i.severity}] ${i.title}`);
    if (i.location) L.push(`Location: ${i.location}`);
    L.push('', i.body || '(no description)', '');
    for (const h of i.history) {
      const text = h.note || h.reply;
      if (text) L.push(`- r${h.round} ${h.by}${h.action ? ` (${h.action})` : ''}${h.status ? ` → ${h.status}` : ''}: ${indent(text, '  ')}`);
    }
  }
  if (['code', 'build'].includes(st.kind)) {
    L.push('', '## Round history');
    for (const r of st.rounds) {
      L.push('', `### Round ${r.n}${r.kind === 'post-approval' ? ' · post-approval' : ''}`);
      if (r.author) L.push(`${r.kind === 'post-approval' ? 'Changes' : 'Codex'}: ${r.author.summary}`, `Tests: ${r.author.tests}`);
      if (r.snapshot?.tree) L.push(`Snapshot tree: ${r.snapshot.tree}`);
      if (r.diffBase) L.push(`This round: ${r.diffBase} → ${r.snapshot.tree}`);
      if (r.pathStates) L.push(...pathStateLines(r.pathStates));
      if (r.verdict) L.push(`${st.kind === 'build' ? 'Claude' : 'Codex'}: ${r.verdict} — ${r.summary}`);
    }
  }
  return `${L.join('\n')}\n`;
}

function approvalReportLines(st) {
  if (!['code', 'build'].includes(st.kind)) return [];
  const L = [`Base: ${st.subject.base}`, `Approved tree: ${st.approval?.tree ?? 'none'}`];
  if (st.subject.committedTree) {
    L.push(`Committed tree: ${st.subject.committedTree}`);
    if (st.approval) L.push(`Approved and committed trees are ${st.approval.tree === st.subject.committedTree ? 'equal' : 'not equal'}.`);
  }
  if (st.finish) {
    L.push(st.finish.unreviewed
      ? `Owner finished without an approval (round ${st.finish.round}, phase ${st.finish.phase}).`
      : 'Owner finished unreviewed: no.');
    if (st.finish.unreviewed) {
      L.push(`Last approved tree: ${st.finish.approvedTree ?? 'none'}`, ...pathStateLines(st.finish.pathStates));
    }
  }
  return L;
}

// ---------------------------------------------------------------- commands

async function initDocSubject(st, o, dir) {
  if (o.base) throw new UsageError('--base is only for --kind code');
  if (!o.subject.length) {
    throw new UsageError(`--kind ${st.kind} needs --subject <path>${st.kind === 'plan' ? ' (or --subject - to pass the plan on stdin)' : ''}`);
  }
  const paths = [];
  for (const s of o.subject) {
    if (s === '-') {
      if (st.kind !== 'plan') throw new UsageError('--subject - (stdin) is only for --kind plan');
      const text = await readStdin();
      if (!text.trim()) throw new UsageError('the plan on stdin is empty');
      const file = path.join(dir, 'plan.md');
      fs.writeFileSync(file, text);
      paths.push(file);
    } else {
      const file = path.resolve(st.cwd, s);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UsageError(`not a file: ${s}`);
      paths.push(fs.realpathSync(file));
    }
  }
  st.subject = { paths };
}

function initCodeSubject(st, o) {
  if (o.subject.length) throw new UsageError('--kind code reviews the git working tree; --subject is not used');
  const top = git(['rev-parse', '--show-toplevel'], { cwd: st.cwd, allowFail: true });
  if (top.status !== 0) throw new UsageError('not inside a git repository; use --kind file for files outside git');
  st.cwd = fs.realpathSync(top.stdout.trim());
  let base;
  let target;
  if (o.base) {
    const mb = git(['merge-base', o.base, 'HEAD'], { cwd: st.cwd, allowFail: true });
    if (mb.status !== 0) throw new UsageError(`cannot find the merge-base of ${o.base} and HEAD`);
    base = mb.stdout.trim();
    target = `all changes since the merge-base with ${o.base} (${base.slice(0, 10)}): commits on this branch plus uncommitted and untracked files`;
  } else if (hasHead(st.cwd)) {
    base = git(['rev-parse', 'HEAD'], { cwd: st.cwd }).stdout.trim();
    target = `uncommitted changes (staged, unstaged and untracked files) relative to HEAD ${base.slice(0, 10)}`;
  } else {
    base = git(['hash-object', '-t', 'tree', '/dev/null'], { cwd: st.cwd }).stdout.trim();
    target = 'all files (the repository has no commits yet)';
  }
  st.subject = { base, target };
}

async function cmdStart(o) {
  if (!KINDS.includes(o.kind)) throw new UsageError(`--kind must be one of: ${KINDS.join(', ')}`);
  let brief = null;
  if (o.brief != null) {
    if (o.kind === 'audit') throw new UsageError('--brief is not used with --kind audit: nothing is negotiated');
    if (o.kind === 'build') throw new UsageError("--brief is not used with --kind build: put ## Owner's request and optional ## Accepted amendments in the spec itself");
    if (o.brief === '-' && o.subject.includes('-')) throw new UsageError('--brief - and --subject - cannot share stdin; pass one as a file');
    if (o.brief === '-') brief = await readStdin();
    else {
      try {
        const file = path.resolve(o.brief);
        if (!fs.statSync(file).isFile()) throw new Error('not a file');
        brief = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new UsageError(`cannot read --brief ${o.brief}: ${err.message}`);
      }
    }
    if (!hasOwnerRequest(brief)) throw new UsageError("the brief needs a non-empty `## Owner's request` section (ASCII apostrophe), quoting the owner's own words");
  }
  if (o.kind === 'audit' && o.sandbox && o.sandbox !== 'read-only') {
    throw new UsageError('an audit runs read-only: Codex examines and reports, it changes nothing (leave --sandbox out)');
  }
  const sandbox = o.kind === 'audit' ? 'read-only' : checkSandbox(o.sandbox ?? process.env.CODEX_DUET_SANDBOX ?? 'inherit');
  // Every option is checked before the session's directory exists: a refusal leaves nothing behind.
  const maxRounds = o.kind === 'audit' ? 1 : o['max-rounds'] ? toInt(o['max-rounds'], 'max-rounds') : 10;
  const timeoutMin = toCount(o['timeout-min'] ?? process.env.CODEX_DUET_TIMEOUT_MIN ?? 0, 'timeout-min');
  const { model, effort } = codexChoice(o, { model: process.env.CODEX_DUET_MODEL, effort: process.env.CODEX_DUET_EFFORT });
  const ts = now().replace(/\D/g, '').slice(0, 14);
  const id = `${ts.slice(0, 8)}-${ts.slice(8)}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const st = {
    version: 1,
    id,
    kind: o.kind,
    cwd: fs.realpathSync(process.cwd()),
    focus: String(o.focus || '').trim(),
    brief: brief == null ? null : path.join(dir, 'brief.md'),
    createdAt: now(),
    updatedAt: now(),
    maxRounds,
    round: 0,
    phase: 'starting',
    codex: { threadId: null, model, effort, timeoutMin, sandbox },
    subject: {},
    issues: {},
    rounds: [],
    decision: null,
  };
  const release = acquireLock(id);
  try {
    if (brief != null) fs.writeFileSync(st.brief, brief);
    if (st.kind === 'code') initCodeSubject(st, o);
    else if (st.kind === 'build') await initBuildSubject(st, o, dir);
    else if (st.kind === 'audit') await initAuditSubject(st, o, dir);
    else await initDocSubject(st, o, dir);
    saveState(st);
    if (st.kind === 'build') await runBuildTurn(st, 1, null);
    else if (st.kind === 'audit') await runAuditTurn(st);
    else await runRound(st, 1, null);
  } catch (err) {
    // Drop the session only if no Codex round ever ran; a failed round stays for `retry`.
    if (st.round === 0 && st.phase !== 'codex-failed') {
      if (st.kind === 'build' && st.subject.worktree) removeWorktree(st, { deleteBranch: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    release();
  }
}

const isOwnerDecisionsOnly = (payload) => Array.isArray(payload?.responses)
  && (payload.responses.length > 0 || Object.hasOwn(payload, 'request_ruling'))
  && payload.responses.every((r) => r?.action === 'owner-decided');

async function cmdReply(o) {
  if (!o.responses) throw new UsageError('pass --responses <file>, or --responses - with a heredoc');
  const { id } = resolveSession(o.session);
  const raw = o.responses === '-' ? await readStdin() : fs.readFileSync(path.resolve(o.responses), 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`responses are not valid JSON: ${err.message}`);
  }
  const release = acquireLock(id);
  try {
    const st = loadState(id); // read again under the lock: another call may have moved the session on
    if (st.kind === 'build') throw new UsageError('a build session is answered with: review --issues -');
    if (st.kind === 'audit') throw new UsageError(AUDIT_HAS_NO_ROUNDS);
    guardIdle(st);
    switchCodex(st, o);
    if (o['max-rounds']) st.maxRounds = toInt(o['max-rounds'], 'max-rounds');
    if (st.round >= st.maxRounds) {
      if (!isOwnerDecisionsOnly(payload)) {
        throw new UsageError(`round limit reached (${st.round}/${st.maxRounds}); add --max-rounds <n> to allow more rounds `
          + '(answers that are all owner-decided, or a request_ruling with no other answers, are recorded without a new round)');
      }
      await recordOwnerDecisions(st, payload);
      return;
    }
    applyResponses(st, payload);
    saveState(st);
    await runRound(st, st.round + 1, payload);
  } finally {
    release();
  }
}

async function cmdRetry(o) {
  const { id } = resolveSession(o.session);
  const release = acquireLock(id);
  try {
    const st = loadState(id);
    if (!st.pending) throw new UsageError(`nothing to retry in ${st.id} (phase: ${st.phase})`);
    if (o.fresh) delete st.pending.threadId; // start the turn over instead of continuing the cut-off one
    switchCodex(st, o);
    saveState(st);
    if (st.kind === 'build') await runBuildTurn(st, st.pending.round, st.pending.review);
    else if (st.kind === 'audit') await runAuditTurn(st);
    else await runRound(st, st.pending.round, st.pending.payload);
  } finally {
    release();
  }
}

function cmdStatus(o) {
  const st = resolveSession(o.session);
  if (st.pending) {
    const busy = lockHolder(st);
    const waiting = st.phase === 'queued'
      ? `is waiting for a free Codex slot since ${st.pending.queuedAt} (at most ${MAX_PARALLEL} turns run at once)`
      : `is running since ${st.pending.startedAt}`;
    console.log(busy
      ? `codex-duet ${st.id}: round ${st.pending.round} ${waiting} (pid ${busy})`
      : `codex-duet ${st.id}: round ${st.pending.round} did not complete${st.pending.error ? `: ${st.pending.error}` : ''}. Run: node "${SELF}" retry --session ${st.id}`);
  }
  if (st.rounds.length) {
    console.log(st.kind === 'build' ? renderBuildSummary(st) : st.kind === 'audit' ? renderAuditSummary(st) : renderSummary(st));
  }
  if (st.phase === 'done' && ['code', 'build'].includes(st.kind)) console.log(approvalVerdict(currentApprovalCheck(st)));
}

function cmdVerify(o) {
  const { id } = resolveSession(o.session);
  const release = acquireLock(id);
  try {
    const st = loadState(id);
    if (!['code', 'build'].includes(st.kind)) throw new UsageError('verify applies to code and build sessions');
    const check = currentApprovalCheck(st);
    const L = [
      `Approved tree: ${st.approval?.tree ?? 'no approval recorded'}`,
      `${check.source}: ${check.tree}`,
      ...pathStateLines(check.paths),
    ];
    if (!check.matches && st.kind === 'code') {
      L.push('Send the changes back to Codex:', '```bash',
        `node "${SELF}" reply --session ${st.id} --responses - <<'DUET_JSON'`,
        '{"changes": "<what changed after the approval>", "responses": []}', 'DUET_JSON', '```');
    }
    L.push(approvalVerdict(check));
    console.log(L.join('\n'));
    if (!check.matches) process.exitCode = 1;
  } finally {
    release();
  }
}

function cmdReport(o) {
  const st = resolveSession(o.session);
  if (st.kind === 'audit' && !st.audit) throw new UsageError(`the audit ${st.id} has no report yet (phase: ${st.phase})`);
  const report = st.kind === 'audit' ? renderAuditReport(st) : renderReport(st);
  fs.writeFileSync(path.join(sessionDir(st.id), 'report.md'), report);
  process.stdout.write(report);
}

function cmdList(o) {
  const here = fs.realpathSync(process.cwd());
  const rows = allSessions().filter((s) => o.all || covers(s, here));
  if (!rows.length) {
    console.log(o.all ? 'no sessions' : 'no sessions for this directory (try --all)');
    return;
  }
  for (const s of rows) console.log(`${s.id}  ${s.kind.padEnd(4)}  round ${s.round}/${s.maxRounds}  ${s.phase.padEnd(15)}  ${s.cwd}`);
}

const COMMANDS = {
  start: cmdStart,
  reply: cmdReply,
  retry: cmdRetry,
  status: cmdStatus,
  report: cmdReport,
  list: cmdList,
  review: cmdReview,
  finish: cmdFinish,
  verify: cmdVerify,
  discard: cmdDiscard,
  help: () => console.log(USAGE),
};

async function main() {
  const { cmd, o } = parseArgs(process.argv.slice(2));
  const command = COMMANDS[cmd];
  if (!command) throw cliError(`unknown command: ${cmd}`);
  await command(o);
}

main().catch((err) => {
  console.error(`codex-duet: ${err.message}`);
  if (err.showUsage) console.error(`\n${USAGE}`);
  process.exit(err instanceof UsageError ? 2 : 1);
});

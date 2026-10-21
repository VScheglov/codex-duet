#!/usr/bin/env node
// Self-test for scripts/duet.mjs against a fake Codex, and for the stop policy: node tests/run.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUET = path.join(HERE, '..', 'scripts', 'duet.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-duet-test-')));
const repo = path.join(tmp, 'repo');
const home = path.join(tmp, 'state');
const scriptFile = path.join(tmp, 'codex-script.json');
const fakeState = path.join(tmp, 'codex-calls.json');

const baseEnv = {
  ...process.env,
  CODEX_DUET_HOME: home,
  CODEX_DUET_CODEX_BIN: path.join(HERE, 'fake-codex.mjs'),
  CODEX_DUET_POLICY: path.join(HERE, 'fixture-policy.mjs'),
  FAKE_CODEX_SCRIPT: scriptFile,
  FAKE_CODEX_STATE: fakeState,
  // No model catalog unless a test brings one, and none of the owner's own defaults.
  CODEX_HOME: path.join(tmp, 'no-codex-home'),
  CODEX_DUET_MODEL: '',
  CODEX_DUET_EFFORT: '',
  CODEX_DUET_TIMEOUT_MIN: '',
  CLAUDE_CODE_SESSION_ID: '', // as from a plain shell, unless a test names a Claude session
};

const issue = (id, status, severity = 'high', extra = {}) => ({
  id, status, severity, title: `Issue ${id}`, body: `Body of ${id}`, location: 'a.js:1',
  recommendation: `Fix ${id}`, confidence: 0.8, reply: '', ...extra,
});
const turn = (verdict, issues) => ({ reply: { verdict, summary: `summary: ${verdict}`, issues } });

function scriptCodex(steps) {
  fs.writeFileSync(scriptFile, JSON.stringify(steps));
  fs.rmSync(fakeState, { force: true });
  fs.rmSync(`${fakeState}.pids`, { force: true });
}
const calls = () => JSON.parse(fs.readFileSync(fakeState, 'utf8')).calls;
const descendants = () => (fs.existsSync(`${fakeState}.pids`)
  ? fs.readFileSync(`${fakeState}.pids`, 'utf8').split('\n').filter(Boolean).map(Number)
  : []);
const state = (id) => JSON.parse(fs.readFileSync(path.join(home, id, 'state.json'), 'utf8'));
// The lock file stays between calls; while held it carries the holder's pid.
const lockHolderPid = (id) => {
  const file = path.join(home, id, 'lock');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
};
const sessionId = (out) => /codex-duet (\d{8}-\d{6}-[0-9a-f]{4})/.exec(out)?.[1];
const responses = (changes, list) => JSON.stringify({ changes, responses: list });

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function duet(args, { cwd = repo, input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [DUET, ...args], { cwd, input, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The same call, not waited for: resolves once the process exits.
function duetAsync(args, { cwd = repo, input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DUET, ...args], { cwd, env: { ...baseEnv, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const commit = (msg, cwd = repo) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], cwd);

async function waitFor(check, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

fs.mkdirSync(repo);
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
git(['add', 'a.js']);
commit('a');

const decisions = JSON.stringify({ 1: 'continue', 2: 'continue', 3: 'escalate', 4: 'done' });
let id;

await test('start refuses an empty diff and leaves no session behind', () => {
  scriptCodex([]);
  const r = duet(['start', '--kind', 'code']);
  assert.equal(r.code, 2);
  assert.match(r.err, /nothing to review/);
  assert.equal(fs.existsSync(home) ? fs.readdirSync(home).length : 0, 0);
});

await test('round 1: diff includes untracked files, the sandbox is inherited, focus reaches Codex', () => {
  scriptCodex([
    turn('revise', [issue('C1', 'open'), issue('C2', 'open', 'medium')]),
    turn('revise', [issue('C1', 'resolved'), issue('C2', 'open', 'medium', { reply: 'Still unsafe: X' }), issue('C3', 'open', 'low')]),
    turn('revise', [issue('C2', 'open', 'medium', { reply: 'No, because Y' }), issue('C3', 'open', 'low')]),
    { fail: 'simulated network error' },
    turn('approve', [issue('C2', 'open', 'medium', { reply: 'I still disagree' }), issue('C3', 'resolved', 'low')]),
  ]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(repo, 'b.js'), 'export const b = 1;\n');
  const r = duet(['start', '--kind', 'code', '--focus', 'null safety'], { env: { FIXTURE_DECISIONS: decisions } });
  assert.equal(r.code, 0, r.err);
  id = sessionId(r.out);
  assert.ok(id, r.out);
  assert.match(r.out, /Decision: CONTINUE/);
  assert.match(r.out, /\*\*C1\*\* \[high\]/);
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 2), ['exec', '-C']);
  assert.ok(!call.args.includes('-s') && !call.args.some((a) => a.startsWith('sandbox_mode')), 'inherit: the owner\'s config decides');
  assert.match(call.prompt, /You may run whatever helps to verify the subject/);
  assert.match(call.prompt, /\+export const b = 1;/);
  assert.match(call.prompt, /null safety/);
  assert.doesNotMatch(call.prompt, /\{\{/);
  assert.equal(state(id).round, 1);
});

await test('reply must answer every open issue', () => {
  const r = duet(['reply', '--session', id, '--responses', '-'], {
    input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /missing: C2/);
  assert.equal(calls().length, 1);
});

await test('round 2: resume inherits the sandbox too, interdiff is sent, disputes are counted', () => {
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 3;\n');
  const r = duet(['reply', '--session', id, '--responses', '-'], {
    env: { FIXTURE_DECISIONS: decisions },
    input: responses('changed a', [
      { id: 'C1', action: 'fixed', note: 'fixed in a.js:1' },
      { id: 'c2', action: 'disputed', note: 'not reachable' },
    ]),
  });
  assert.equal(r.code, 0, r.err);
  const call = calls()[1];
  assert.deepEqual(call.args.slice(0, 3), ['exec', 'resume', state(id).codex.threadId]);
  assert.ok(!call.args.includes('-s'), 'exec resume has no --sandbox flag');
  assert.ok(!call.args.some((a) => a.startsWith('sandbox_mode')), 'inherit on resume too');
  assert.match(call.prompt, /-export const a = 2;\n\+export const a = 3;/);
  assert.match(call.prompt, /not reachable/);
  assert.match(call.prompt, /next free id is C3/);
  const s = state(id);
  assert.equal(s.issues.C1.status, 'resolved');
  assert.equal(s.issues.C2.disputes, 1);
  assert.equal(s.issues.C3.openedRound, 2);
});

await test('round 3: parked issue stays out of the way, policy escalates', () => {
  const r = duet(['reply', '--session', id, '--responses', '-'], {
    env: { FIXTURE_DECISIONS: decisions },
    input: responses('none', [
      { id: 'C2', action: 'disputed', note: 'still not reachable' },
      { id: 'C3', action: 'needs-user', note: 'product decision' },
    ]),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: ESCALATE/);
  assert.match(r.out, /Needs the owner's decision/);
  assert.match(r.out, /Parked for the owner \(1\)/);
  const s = state(id);
  assert.equal(s.issues.C2.disputes, 2);
  assert.equal(s.issues.C3.parked, true);
  assert.equal(s.phase, 'escalated');
  assert.ok(fs.existsSync(path.join(home, id, 'report.md')));
});

await test('a failed round blocks reply until retry; the owner decision is final', () => {
  const payload = responses('owner ruled', [
    { id: 'C2', action: 'owner-decided', note: 'owner keeps the current behavior' },
    { id: 'C3', action: 'fixed', note: 'per owner decision' },
  ]);
  const env = { FIXTURE_DECISIONS: decisions };
  const failed = duet(['reply', '--session', id, '--responses', '-'], { env, input: payload });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /simulated network error/);
  assert.equal(state(id).phase, 'codex-failed');
  const blocked = duet(['reply', '--session', id, '--responses', '-'], { env, input: payload });
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /retry/);
  const retried = duet(['retry', '--session', id], { env });
  assert.equal(retried.code, 0, retried.err);
  assert.match(retried.out, /Decision: DONE/);
  const s = state(id);
  assert.equal(s.issues.C2.status, 'withdrawn', 'Codex kept C2 open, but the owner decided');
  assert.equal(s.issues.C3.status, 'resolved');
  assert.equal(s.round, 4);
  assert.equal(lockHolderPid(id), '', 'the lock is released');
});

await test('status finds the session from a subdirectory', () => {
  fs.mkdirSync(path.join(repo, 'sub'));
  const r = duet(['status'], { cwd: path.join(repo, 'sub') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(id));
});

await test('file review: the second round carries a unified diff of the edits', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'resolved')])]);
  const doc = path.join(tmp, 'spec.md');
  fs.writeFileSync(doc, '# Spec\nline one\n');
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'done' }) };
  const r1 = duet(['start', '--kind', 'file', '--subject', 'spec.md'], { cwd: tmp, env });
  assert.equal(r1.code, 0, r1.err);
  assert.match(calls()[0].prompt, /<subject_file path="spec.md">\n# Spec/);
  fs.appendFileSync(doc, 'line two\n');
  const r2 = duet(['reply', '--session', sessionId(r1.out), '--responses', '-'], {
    cwd: tmp, env, input: responses('added line two', [{ id: 'C1', action: 'fixed', note: 'added' }]),
  });
  assert.equal(r2.code, 0, r2.err);
  assert.match(calls()[1].prompt, /\+line two/);
  assert.match(r2.out, /Decision: DONE/);
});

await test('plan on stdin; the round limit overrides the policy', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')])]);
  const r = duet(['start', '--kind', 'plan', '--subject', '-', '--max-rounds', '1'], {
    cwd: tmp, input: '# Plan\n1. Do it\n', env: { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue' }) },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: ESCALATE — round limit 1 reached \(enforced by duet\.mjs\)/);
  assert.match(r.out, /plan\.md \(edit this file between rounds\)/);
  assert.match(calls()[0].prompt, /1\. Do it/);
});

await test('a throwing policy escalates instead of crashing', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')])]);
  fs.writeFileSync(path.join(tmp, 'q.sql'), 'select 1;\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'q.sql'], {
    cwd: tmp, env: { CODEX_DUET_POLICY: path.join(HERE, 'throwing-policy.mjs') },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: ESCALATE — policy error: boom/);
});

await test('missing stdin fails fast instead of hanging', () => {
  const r = duet(['start', '--kind', 'plan', '--subject', '-'], { cwd: tmp, input: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /plan on stdin is empty/);
});

await test('--sandbox read-only is forced on start and on resume', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'resolved')])]);
  fs.writeFileSync(path.join(tmp, 'ro.md'), 'x\n');
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'done' }) };
  const r1 = duet(['start', '--kind', 'file', '--subject', 'ro.md', '--sandbox', 'read-only'], { cwd: tmp, env });
  assert.equal(r1.code, 0, r1.err);
  const r2 = duet(['reply', '--session', sessionId(r1.out), '--responses', '-'], {
    cwd: tmp, env, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(r2.code, 0, r2.err);
  const [first, second] = calls();
  assert.deepEqual(first.args.slice(0, 5), ['exec', '-C', tmp, '-s', 'read-only']);
  assert.ok(first.args.includes('sandbox_mode="read-only"'));
  assert.ok(second.args.includes('sandbox_mode="read-only"') && !second.args.includes('-s'));
  assert.match(first.prompt, /sandbox is read-only/);
});

await test('--sandbox rejects an unknown mode before creating a session', () => {
  const before = fs.readdirSync(home).length;
  const r = duet(['start', '--kind', 'file', '--subject', 'ro.md', '--sandbox', 'yolo'], { cwd: tmp });
  assert.equal(r.code, 2);
  assert.match(r.err, /--sandbox must be one of/);
  assert.equal(fs.readdirSync(home).length, before);
});

// ---- review findings C1–C6 of the first dogfooding round

await test('C1: of two concurrent replies the second is refused and nothing is lost', async () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), { delayMs: 1500, ...turn('approve', [issue('C1', 'resolved')]) }]);
  fs.writeFileSync(path.join(tmp, 'race.md'), 'v1\n');
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'done' }) };
  const start = duet(['start', '--kind', 'file', '--subject', 'race.md'], { cwd: tmp, env });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const payload = responses('fixed', [{ id: 'C1', action: 'fixed', note: 'done' }]);
  const first = duetAsync(['reply', '--session', sid, '--responses', '-'], { cwd: tmp, env, input: payload });
  await waitFor(() => lockHolderPid(sid) !== '');
  const second = duet(['reply', '--session', sid, '--responses', '-'], { cwd: tmp, env, input: payload });
  assert.equal(second.code, 2);
  assert.match(second.err, /busy/);
  const done = await first;
  assert.equal(done.code, 0, done.err);
  assert.equal(calls().length, 2);
  assert.equal(state(sid).round, 2);
  assert.equal(state(sid).issues.C1.status, 'resolved');
});

await test('C2: a timeout takes down the whole tree, a SIGTERM-proof descendant included', async () => {
  scriptCodex([{ hang: true, ignoreTerm: true, descendant: 'stdout' }]);
  fs.writeFileSync(path.join(tmp, 'hang.md'), 'x\n');
  const began = Date.now();
  const r = duet(['start', '--kind', 'file', '--subject', 'hang.md'], {
    cwd: tmp, env: { CODEX_DUET_TIMEOUT_MS: '300', CODEX_DUET_KILL_GRACE_MS: '300' },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not finish within 300 ms/);
  assert.ok(Date.now() - began < 5000, `took ${Date.now() - began} ms`);
  for (const pid of descendants()) await waitFor(() => !isAlive(pid), 2000);
});

await test('C2: a descendant holding stdout after Codex exits does not hang the round', async () => {
  scriptCodex([{ ...turn('approve', []), descendant: 'stdout' }]);
  fs.writeFileSync(path.join(tmp, 'linger.md'), 'x\n');
  const began = Date.now();
  const r = duet(['start', '--kind', 'file', '--subject', 'linger.md'], { cwd: tmp, env: { CODEX_DUET_KILL_GRACE_MS: '300' } });
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - began < 5000, `took ${Date.now() - began} ms`);
  for (const pid of descendants()) await waitFor(() => !isAlive(pid), 2000);
});

await test('C2: a descendant holding no pipe is killed before the runner exits after a timeout', async () => {
  scriptCodex([{ hang: true, descendant: 'quiet' }]); // codex itself dies on SIGTERM, its child does not
  fs.writeFileSync(path.join(tmp, 'quiet.md'), 'x\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'quiet.md'], {
    cwd: tmp, env: { CODEX_DUET_TIMEOUT_MS: '300', CODEX_DUET_KILL_GRACE_MS: '300' },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not finish within 300 ms/);
  const [pid] = descendants();
  assert.ok(pid, 'the fake started a descendant');
  await waitFor(() => !isAlive(pid), 500); // only reaping by launchd may lag behind the runner's exit
});

await test('C2: leftovers of a successful round are cleared out too', async () => {
  scriptCodex([{ ...turn('approve', []), descendant: 'quiet' }]);
  fs.writeFileSync(path.join(tmp, 'leftover.md'), 'x\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'leftover.md'], { cwd: tmp, env: { CODEX_DUET_KILL_GRACE_MS: '300' } });
  assert.equal(r.code, 0, r.err);
  const [pid] = descendants();
  await waitFor(() => !isAlive(pid), 500);
});

await test('C1: a lock left by a crashed run goes to exactly one of two racers', async () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), { delayMs: 1500, ...turn('approve', [issue('C1', 'resolved')]) }]);
  fs.writeFileSync(path.join(tmp, 'stale.md'), 'v1\n');
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'done' }) };
  const start = duet(['start', '--kind', 'file', '--subject', 'stale.md'], { cwd: tmp, env });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(home, sid, 'lock'), dead); // as if that run had crashed holding the lock
  const payload = responses('fixed', [{ id: 'C1', action: 'fixed', note: 'done' }]);
  const racers = await Promise.all([1, 2].map(() => duetAsync(['reply', '--session', sid, '--responses', '-'], { cwd: tmp, env, input: payload })));
  if (process.platform !== 'darwin') {
    // without O_EXLOCK a stale lock is never broken automatically
    for (const r of racers) assert.match(r.err, /stale lock/);
    return;
  }
  assert.deepEqual(racers.map((r) => r.code).sort(), [0, 2]);
  assert.match(racers.find((r) => r.code === 2).err, /busy/);
  assert.equal(calls().length, 2);
  assert.equal(state(sid).round, 2);
});

await test('a cancelled round says so and can be retried', async () => {
  scriptCodex([{ hang: true, ignoreTerm: true, descendant: 'stdout' }, turn('approve', [])]);
  fs.writeFileSync(path.join(tmp, 'cancel.md'), 'x\n');
  // the timeout only matters if this test dies before its SIGTERM: the runner then cleans up by itself
  const run = duetAsync(['start', '--kind', 'file', '--subject', 'cancel.md'], {
    cwd: tmp, env: { CODEX_DUET_KILL_GRACE_MS: '300', CODEX_DUET_TIMEOUT_MS: '20000' },
  });
  let lock = null;
  await waitFor(() => {
    lock = fs.readdirSync(home).map((d) => path.join(home, d, 'lock')).find((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8'));
    return lock && fs.existsSync(fakeState) && calls().length === 1;
  });
  process.kill(Number(fs.readFileSync(lock, 'utf8')), 'SIGTERM');
  const r = await run;
  assert.equal(r.code, 1);
  assert.match(r.err, /cancelled: codex-duet received SIGINT or SIGTERM \(often the Bash tool's limit/);
  for (const pid of descendants()) await waitFor(() => !isAlive(pid), 2000);
  const retried = duet(['retry', '--session', path.basename(path.dirname(lock))], { cwd: tmp });
  assert.equal(retried.code, 0, retried.err);
  assert.match(retried.out, /Decision: DONE/);
});

await test('C3: the reviewer cannot close an issue parked for the owner', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'withdrawn')])]);
  fs.writeFileSync(path.join(tmp, 'parked.md'), 'x\n');
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'continue' }) };
  const start = duet(['start', '--kind', 'file', '--subject', 'parked.md'], { cwd: tmp, env });
  const sid = sessionId(start.out);
  const r = duet(['reply', '--session', sid, '--responses', '-'], {
    cwd: tmp, env, input: responses('none', [{ id: 'C1', action: 'needs-user', note: 'owner call' }]),
  });
  assert.equal(r.code, 0, r.err);
  const c1 = state(sid).issues.C1;
  assert.deepEqual([c1.status, c1.parked], ['open', true]);
  assert.match(r.out, /Decision: ESCALATE — only issues parked for the owner remain/);
});

await test('C4: a reply that repeats an issue id fails the round and leaves the ledger alone', () => {
  scriptCodex([turn('revise', [issue('C1', 'open'), issue('c1', 'resolved')])]);
  fs.writeFileSync(path.join(tmp, 'dup.md'), 'x\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'dup.md'], { cwd: tmp });
  assert.equal(r.code, 1);
  assert.match(r.err, /C1 appears more than once/);
  const sid = /retry --session (\S+)/.exec(r.err)[1];
  assert.equal(state(sid).phase, 'codex-failed');
  assert.deepEqual(state(sid).issues, {});
});

await test('C5: the snapshot follows the user index (git add -f, git rm --cached)', () => {
  const repo2 = path.join(tmp, 'repo2');
  fs.mkdirSync(repo2);
  git(['init', '-q'], repo2);
  fs.writeFileSync(path.join(repo2, 'old.log'), 'old\n');
  git(['add', 'old.log'], repo2);
  commit('log', repo2);
  fs.writeFileSync(path.join(repo2, '.gitignore'), '*.log\n*.secret\n');
  git(['rm', '--cached', '-q', 'old.log'], repo2); // stays on disk, ignored from now on
  fs.writeFileSync(path.join(repo2, 'key.secret'), 'forced\n');
  git(['add', '-f', 'key.secret'], repo2); // ignored, staged on purpose
  scriptCodex([turn('approve', [])]);
  const r = duet(['start', '--kind', 'code'], { cwd: repo2 });
  assert.equal(r.code, 0, r.err);
  const { prompt } = calls()[0];
  assert.match(prompt, /\+\+\+ b\/key\.secret\n@@ -0,0 \+1 @@\n\+forced/);
  assert.match(prompt, /diff --git a\/old\.log b\/old\.log\ndeleted file mode/);
});

await test('C6: at the round limit owner decisions are recorded without another Codex round', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')])]);
  fs.writeFileSync(path.join(tmp, 'limit.md'), 'x\n');
  const start = duet(['start', '--kind', 'file', '--subject', 'limit.md', '--max-rounds', '1'], { cwd: tmp });
  assert.match(start.out, /round limit 1 reached/);
  const sid = sessionId(start.out);
  const fix = duet(['reply', '--session', sid, '--responses', '-'], {
    cwd: tmp, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(fix.code, 2);
  assert.match(fix.err, /round limit reached/);
  const r = duet(['reply', '--session', sid, '--responses', '-'], {
    cwd: tmp, input: responses('owner ruled', [{ id: 'C1', action: 'owner-decided', note: 'keep as is' }]),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: DONE/);
  assert.equal(state(sid).issues.C1.status, 'withdrawn');
  assert.equal(calls().length, 1, 'no new Codex round');
});

await test('C6: owner decisions at the limit end the review even when the history looks stalled', () => {
  const keepOpen = turn('revise', [issue('C1', 'open', 'high', { reply: 'still wrong' })]);
  scriptCodex([turn('revise', [issue('C1', 'open')]), keepOpen, keepOpen]);
  fs.writeFileSync(path.join(tmp, 'stalled.md'), 'x\n');
  const env = { CODEX_DUET_POLICY: path.join(HERE, '..', 'scripts', 'policy.mjs') }; // the real policy
  const start = duet(['start', '--kind', 'file', '--subject', 'stalled.md', '--max-rounds', '3'], { cwd: tmp, env });
  const sid = sessionId(start.out);
  for (const n of [1, 2]) {
    const r = duet(['reply', '--session', sid, '--responses', '-'], {
      cwd: tmp, env, input: responses(`try ${n}`, [{ id: 'C1', action: 'fixed', note: `attempt ${n}` }]),
    });
    assert.equal(r.code, 0, r.err);
  }
  assert.deepEqual(state(sid).rounds.map((r) => r.open), [1, 1, 1]);
  assert.equal(state(sid).phase, 'escalated');
  const r = duet(['reply', '--session', sid, '--responses', '-'], {
    cwd: tmp, env, input: responses('owner ruled', [{ id: 'C1', action: 'owner-decided', note: 'keep as is' }]),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: DONE/);
  assert.equal(state(sid).phase, 'done');
});

// ---- build mode: Codex implements in a worktree on its own branch, Claude reviews
const author = (summary, responses = []) => ({ reply: { summary, tests: 'node --test: ok', responses, questions: [] } });
const reviewJSON = (verdict, issues) => JSON.stringify({ verdict, summary: `review: ${verdict}`, issues });
const reviewIssue = (iid, status, extra = {}) => ({
  id: iid, status, severity: 'high', title: `Issue ${iid}`, body: `Body of ${iid}`, location: '', recommendation: `Fix ${iid}`, confidence: 0.9, reply: '', ...extra,
});
const gitIdentity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
let buildId;

await test('build: Codex implements the spec in a worktree on its own branch', () => {
  scriptCodex([{ ...author('added greet()'), write: { 'greet.js': 'export const greet = (n) => `hi ${n}`;\n' } }]);
  const r = duet(['start', '--kind', 'build', '--subject', '-'], { input: '# Greeting\nAdd greet(name).\n' });
  assert.equal(r.code, 0, r.err);
  buildId = sessionId(r.out);
  const s = state(buildId);
  assert.equal(s.phase, 'awaiting-review');
  assert.equal(s.subject.branch, `codex-duet/${buildId}`);
  assert.ok(fs.existsSync(path.join(s.subject.worktree, 'greet.js')));
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')), 'the main checkout is untouched');
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 3), ['exec', '-C', s.subject.worktree]);
  assert.ok(call.args.some((a) => a.endsWith('build.schema.json')));
  assert.match(call.prompt, /Add greet\(name\)/);
  assert.match(r.out, /Codex: added greet\(\)/);
  assert.match(r.out, /^\+export const greet/m);
  assert.match(r.out, /review --session/);
});

await test('build: the review reaches Codex, its fixes come back as the round diff', () => {
  scriptCodex([{
    ...author('greet falls back for empty names', [{ id: 'C1', action: 'fixed', note: 'greet.js:1' }]),
    write: { 'greet.js': 'export const greet = (n) => `hi ${n || "there"}`;\n' },
  }]);
  const r = duet(['review', '--session', buildId, '--issues', '-'], { input: reviewJSON('revise', [reviewIssue('C1', 'open')]) });
  assert.equal(r.code, 0, r.err);
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 3), ['exec', 'resume', state(buildId).codex.threadId]);
  assert.match(call.prompt, /C1 \[high\] Issue C1/);
  assert.match(r.out, /C1 \[high\] Issue C1 → fixed: greet\.js:1/);
  assert.match(r.out, /^\+.*"there"/m);
  assert.match(r.out, /^-export const greet = \(n\) => `hi \$\{n\}`;/m, 'the round diff starts from the previous round');
});

await test('build: approval ends the loop; finish commits on the branch and removes the worktree', () => {
  scriptCodex([]);
  const r = duet(['review', '--session', buildId, '--issues', '-'], { input: reviewJSON('approve', [reviewIssue('C1', 'resolved')]) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: DONE/);
  assert.match(r.out, /finish --session/);
  assert.ok(!fs.existsSync(fakeState), 'no Codex turn after an approval');
  const { subject } = state(buildId);
  const f = duet(['finish', '--session', buildId], { env: gitIdentity });
  assert.equal(f.code, 0, f.err);
  assert.ok(!fs.existsSync(subject.worktree), 'the worktree is removed');
  assert.equal(state(buildId).phase, 'finished');
  assert.match(spawnSync('git', ['show', `${subject.branch}:greet.js`], { cwd: repo, encoding: 'utf8' }).stdout, /"there"/);
  assert.equal(spawnSync('git', ['log', '-1', '--format=%s', subject.branch], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'codex-duet: Greeting');
});

await test('build: discard removes the worktree and deletes the branch', () => {
  scriptCodex([{ ...author('started'), write: { 'tmp.txt': 'x\n' } }]);
  const r = duet(['start', '--kind', 'build', '--subject', '-', '--branch', 'try/discard'], { input: 'Try something\n' });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  const { subject } = state(sid);
  const d = duet(['discard', '--session', sid]);
  assert.equal(d.code, 0, d.err);
  assert.ok(!fs.existsSync(subject.worktree));
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '-q', 'try/discard'], { cwd: repo }).status, 0, 'the branch is gone');
  assert.equal(state(sid).phase, 'discarded');
});

await test('build: an owner ruling ends a deadlock and reaches Codex as final', () => {
  const env = { CODEX_DUET_POLICY: path.join(HERE, '..', 'scripts', 'policy.mjs') };
  const dispute = author('kept as is', [{ id: 'C1', action: 'disputed', note: 'the spec allows it' }]);
  scriptCodex([author('done'), dispute, dispute, author('fixed per owner', [{ id: 'C1', action: 'fixed', note: 'x.js:1' }])]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: 'Owner ruling test\n', env });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const keepOpen = (reply, owner = false) => reviewJSON('revise', [reviewIssue('C1', 'open', { reply, owner })]);
  for (const n of [1, 2]) {
    const r = duet(['review', '--session', sid, '--issues', '-'], { input: keepOpen(`no ${n}`), env });
    assert.equal(r.code, 0, r.err);
  }
  const third = duet(['review', '--session', sid, '--issues', '-'], { input: keepOpen('still no'), env });
  assert.match(third.out, /Decision: ESCALATE — deadlock/);
  const ruled = duet(['review', '--session', sid, '--issues', '-'], { input: keepOpen('Owner decision: fix it', true), env });
  assert.equal(ruled.code, 0, ruled.err);
  assert.match(calls()[3].prompt, /Owner decision \(final\): Owner decision: fix it/);
  const c1 = state(sid).issues.C1;
  assert.deepEqual([c1.disputes, c1.ownerRuled, c1.author.action], [0, true, 'fixed']);
});

await test('build: reply and review keep to their own kind of session', () => {
  const r1 = duet(['reply', '--session', buildId, '--responses', '-'], { input: '{"responses": []}' });
  assert.equal(r1.code, 2);
  assert.match(r1.err, /review --issues/);
  const r2 = duet(['review', '--session', id, '--issues', '-'], { input: reviewJSON('approve', []) });
  assert.equal(r2.code, 2);
  assert.match(r2.err, /review is for --kind build sessions/);
});

// ---- model and effort, checked against the owner's Codex (a stand-in CODEX_HOME)
const codexHome = path.join(tmp, 'codex-home');
fs.mkdirSync(codexHome);
const levels = (...efforts) => efforts.map((effort) => ({ effort, description: effort }));
const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: levels(...ALL) },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: levels(...ALL) },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: levels(...ALL.slice(0, 5)) },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: levels(...ALL) },
] }));
// only the keys before the first table are the defaults
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\n\n[agents.helper]\nmodel = "gpt-6-luna"\n');
const withCatalog = { CODEX_HOME: codexHome };
const sessionCount = () => (fs.existsSync(home) ? fs.readdirSync(home).length : 0);

await test('model check: an unknown model is refused before anything starts, with the models there are', () => {
  scriptCodex([]);
  const before = sessionCount();
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js', '--model', 'gpt-6-astr'], { env: withCatalog });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown Codex model: gpt-6-astr; available: gpt-6\.1-sol, gpt-6-astra, gpt-6-luna\n/);
  assert.doesNotMatch(r.err, /gpt-reserve/, 'hidden models are not offered');
  assert.equal(sessionCount(), before, 'no session directory is left behind');
  assert.equal(fs.existsSync(fakeState), false, 'Codex was not called');
  assert.match(duet(['start', '--kind', 'file', '--subject', 'a.js', '--effort', 'mx'], { env: withCatalog }).err,
    /unknown effort: mx; known: low, medium, high, xhigh, max, ultra/);
});

await test("model check: a model that cannot take config.toml's default effort is refused, naming the file", () => {
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js', '--model', 'gpt-6-luna'], { env: withCatalog });
  assert.equal(r.code, 2);
  assert.match(r.err, /gpt-6-luna does not take effort "ultra" \(the default in .*config\.toml\); it takes: low, medium, high, xhigh, max\./);
});

await test('model check: a display name resolves to its id; reply --effort switches from the next turn on', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'resolved')])]);
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js', '--model', 'GPT-6-Astra', '--effort', 'MAX'], { env: withCatalog });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.match(r.out, /^Model: gpt-6-astra · max$/m);
  const [first] = calls();
  assert.deepEqual(first.args.slice(first.args.indexOf('-m'), first.args.indexOf('-m') + 2), ['-m', 'gpt-6-astra']);
  assert.ok(first.args.includes('model_reasoning_effort="max"'));
  const bad = duet(['reply', '--session', sid, '--responses', '-', '--effort', 'turbo'], {
    env: withCatalog, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(bad.code, 2);
  assert.equal(state(sid).codex.effort, 'max', 'a refused switch changes nothing');
  const r2 = duet(['reply', '--session', sid, '--responses', '-', '--effort', 'high'], {
    env: withCatalog, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(r2.code, 0, r2.err);
  const second = calls()[1];
  assert.equal(second.args[1], 'resume');
  assert.ok(second.args.includes('gpt-6-astra') && second.args.includes('model_reasoning_effort="high"'));
  assert.equal(state(sid).codex.effort, 'high');
  // each round records what it ran on, for the pane and the history
  assert.deepEqual(state(sid).rounds.map((r) => r.codexModel), [
    { model: 'gpt-6-astra', effort: 'max', fromConfig: [] },
    { model: 'gpt-6-astra', effort: 'high', fromConfig: [] },
  ]);
});

await test('model check: without a catalog nothing is checked; retry --model mends the session', () => {
  scriptCodex([{ fail: 'model not found' }, turn('approve', [])]);
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js', '--model', 'gpt-6-astr']);
  assert.equal(r.code, 1, 'unchecked: Codex itself refuses');
  const sid = /retry --session (\S+)/.exec(r.err)[1];
  const bad = duet(['retry', '--session', sid, '--model', 'nope'], { env: withCatalog });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown Codex model: nope/);
  assert.equal(state(sid).codex.model, 'gpt-6-astr');
  assert.equal(calls().length, 1);
  const fixed = duet(['retry', '--session', sid, '--model', 'gpt-6-astra'], { env: withCatalog });
  assert.equal(fixed.code, 0, fixed.err);
  assert.ok(calls()[1].args.includes('gpt-6-astra'));
  assert.equal(state(sid).codex.model, 'gpt-6-astra');
  assert.match(fixed.out, /^Model: gpt-6-astra · ultra \(config\)$/m);
  assert.deepEqual(state(sid).rounds.at(-1).codexModel, { model: 'gpt-6-astra', effort: 'ultra', fromConfig: ['effort'] });
});

// ---- Fast: config.toml asks for a service tier, Codex's own log of the thread tells what a turn got
const fastHome = path.join(tmp, 'codex-home-fast');
fs.mkdirSync(fastHome);
fs.writeFileSync(path.join(fastHome, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: levels(...ALL),
    service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }], additional_speed_tiers: ['fast'] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: levels(...ALL) },
] }));
fs.writeFileSync(path.join(fastHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\nservice_tier = "priority"\n');
const withFast = { CODEX_HOME: fastHome };

await test("fast: config.toml's tier marks a turn until Codex's log tells otherwise, live while the turn runs", async () => {
  scriptCodex([
    turn('revise', [issue('C1', 'open')]), // a new thread's first turn: nothing logged, config.toml's word stands
    { delayMs: 1500, tier: 'default', ...turn('revise', [issue('C1', 'open', 'high', { reply: 'not yet' })]) },
    turn('approve', [issue('C1', 'resolved')]),
  ]);
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js'], { env: withFast });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.match(r.out, /^Model: gpt-6\.1-sol \(config\) · max \(config\) · ⚡ Fast \(config\)$/m);
  assert.deepEqual(state(sid).rounds[0].codexModel,
    { model: 'gpt-6.1-sol', effort: 'max', fromConfig: ['model', 'effort', 'tier'], tier: 'priority' });
  // round 2 resumes the thread: Codex logs the standard tier as the turn begins, although config.toml asks
  // for Fast, and the running turn shows that at once
  const fixed = () => responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]);
  const running = duetAsync(['reply', '--session', sid, '--responses', '-'], { env: withFast, input: fixed() });
  await waitFor(() => state(sid).pending?.codexModel?.fromConfig.includes('tier') === false);
  assert.equal(state(sid).pending.codexModel.tier, 'default', "the log's word, not config.toml's");
  assert.ok(!fs.existsSync(path.join(home, sid, 'round-2.codex.json')), 'seen while Codex still works, not at the end');
  assert.equal((await running).code, 0);
  // round 3 logs nothing: round 2's record is older than the turn and does not count for it
  const r3 = duet(['reply', '--session', sid, '--responses', '-'], { env: withFast, input: fixed() });
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual(state(sid).rounds.map((x) => [x.codexModel.tier, x.codexModel.fromConfig.includes('tier')]),
    [['priority', true], ['default', false], ['priority', true]]);
  assert.match(state(sid).codex.rollout, /\/sessions\/2026\/10\/04\/rollout-2026-10-04T00-00-00-[\w-]+\.jsonl$/, 'the session keeps where the log is');
});

await test('fast: a model whose catalog entry lacks the tier is not marked', () => {
  scriptCodex([turn('approve', [])]);
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js', '--model', 'gpt-6-luna'], { env: withFast });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Model: gpt-6-luna · max \(config\)$/m);
  assert.equal(state(sessionId(r.out)).rounds[0].codexModel.tier, undefined);
});

await test("events: every line of Codex's stream is kept as it came, stamped with the time it came", () => {
  scriptCodex([turn('approve', [])]);
  const before = Date.now();
  const r = duet(['start', '--kind', 'file', '--subject', 'a.js']);
  assert.equal(r.code, 0, r.err);
  const events = fs.readFileSync(path.join(home, sessionId(r.out), 'round-1.events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
  assert.ok(events.every((e) => Date.parse(e._at) >= before - 1000 && Date.parse(e._at) <= Date.now()), 'each stamped');
  assert.deepEqual(events[2].item, { id: 'item_0', type: 'agent_message', text: JSON.stringify(turn('approve', []).reply) }, 'the event itself unchanged');
});

// ---- a turn cut off after Codex began it (the Bash ceiling, a stop) goes on in its own thread on retry
const cutHome = path.join(tmp, 'codex-home-cut'); // where the fake leaves its logs of threads
const cutOff = { CODEX_HOME: cutHome, CODEX_DUET_TIMEOUT_MS: '500', CODEX_DUET_KILL_GRACE_MS: '300' };
const retrySid = (err) => /retry --session (\S+)/.exec(err)?.[1];

await test('retry: a first turn cut off after Codex began it goes on in its own thread, with a short carry-on prompt', () => {
  scriptCodex([{ hang: true, started: true, tier: 'default' }, turn('approve', [])]);
  fs.writeFileSync(path.join(tmp, 'cut.md'), 'x\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'cut.md'], { cwd: tmp, env: cutOff });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not finish within 500 ms/);
  const sid = retrySid(r.err);
  const thread = state(sid).pending.threadId;
  assert.ok(thread, 'the cut-off turn keeps its thread');
  const again = duet(['retry', '--session', sid], { cwd: tmp, env: { CODEX_HOME: cutHome } });
  assert.equal(again.code, 0, again.err);
  const second = calls()[1];
  assert.deepEqual(second.args.slice(0, 3), ['exec', 'resume', thread]);
  assert.match(second.prompt, /<interrupted_turn>/);
  assert.ok(!second.prompt.includes('cut.md'), 'not the whole first-round prompt again');
  assert.equal(state(sid).codex.threadId, thread, 'later rounds go on in it too');
  assert.equal(state(sid).phase, 'done');
});

await test("retry: without Codex's log of the cut-off thread, or with --fresh, the turn starts over", () => {
  scriptCodex([{ hang: true, started: true }, { hang: true, started: true, tier: 'default' }, turn('approve', [])]);
  fs.writeFileSync(path.join(tmp, 'over.md'), 'x\n');
  const sid = retrySid(duet(['start', '--kind', 'file', '--subject', 'over.md'], { cwd: tmp, env: cutOff }).err);
  // the first attempt named a thread but left no log of it: nothing to go on with
  assert.equal(duet(['retry', '--session', sid], { cwd: tmp, env: cutOff }).code, 1);
  assert.deepEqual(calls()[1].args.slice(0, 2), ['exec', '-C']);
  assert.match(calls()[1].prompt, /over\.md/, 'the whole first-round prompt');
  // the second left one, but --fresh starts over all the same
  const fresh = duet(['retry', '--session', sid, '--fresh'], { cwd: tmp, env: { CODEX_HOME: cutHome } });
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(calls()[2].args.slice(0, 2), ['exec', '-C']);
  assert.match(calls()[2].prompt, /over\.md/);
});

await test('retry: a build cut off in its first turn goes on in its own thread', () => {
  scriptCodex([{ hang: true, started: true, tier: 'default' }, author('finished the cut-off work')]);
  const r = duet(['start', '--kind', 'build', '--subject', '-'], { input: 'A long task\n', env: cutOff });
  assert.equal(r.code, 1, r.err);
  const sid = retrySid(r.err);
  const thread = state(sid).pending.threadId;
  const again = duet(['retry', '--session', sid], { env: { CODEX_HOME: cutHome } });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(calls()[1].args.slice(0, 3), ['exec', 'resume', thread]);
  assert.match(calls()[1].prompt, /<interrupted_turn>/);
  assert.equal(state(sid).phase, 'awaiting-review');
  assert.equal(state(sid).codex.threadId, thread);
});

// ---- audit: one read-only turn on a task, findings with evidence, nothing to answer
const auditTurn = (findings) => ({ reply: { summary: 'Two stale outcomes.', findings, coverage: 'Read ledger.py.', notes: '' } });
const finding = (fid, severity, title) => ({
  id: fid, severity, title, body: `Evidence for ${title}`, location: 'ledger.py:40', recommendation: `Fix ${title}`, confidence: 0.8,
});

await test('audit: one read-only turn in the current directory, a summary and a report, nothing to answer', () => {
  scriptCodex([auditTurn([finding('A1', 'high', 'Stale outcome'), finding('A1', 'low', 'Dropped error')])]);
  const r = duet(['start', '--kind', 'audit', '--subject', '-'], { input: '# Audit the ledger\nFind stale outcomes.\n' });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.match(r.out, /^## codex-duet \S+ · audit \(/m);
  assert.match(r.out, /^Task: Audit the ledger \(/m);
  assert.match(r.out, /^Findings: 2 \(high 1 · low 1\)$/m);
  assert.match(r.out, /^- A1 \[high\] Stale outcome — ledger\.py:40$/m);
  assert.match(r.out, /^- A2 \[low\] Dropped error — /m, 'a repeated id gets the next free one');
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 5), ['exec', '-C', repo, '-s', 'read-only']);
  assert.ok(call.args.some((a) => a.endsWith('audit.schema.json')));
  assert.match(call.prompt, /Find stale outcomes\./);
  assert.match(call.prompt, /sandbox is read-only/);
  assert.equal(state(sid).phase, 'done');
  assert.equal(state(sid).findings.length, 2);
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.match(report, /### A1 \[high\] Stale outcome\nLocation: ledger\.py:40\nConfidence: 0\.8\n\nEvidence for Stale outcome\n\nRecommendation: Fix Stale outcome/);
  for (const [cmd, input] of [[['reply', '--responses', '-'], responses('x', [])], [['review', '--issues', '-'], reviewJSON('approve', [])]]) {
    const refused = duet([...cmd, '--session', sid], { input });
    assert.equal(refused.code, 2, refused.err);
    assert.match(refused.err, /an audit has nothing to answer/);
  }
  assert.match(duet(['status', '--session', sid]).out, /^Findings: 2 \(/m);
});

await test('audit: any sandbox but read-only is refused before a session exists', () => {
  scriptCodex([]);
  const before = sessionCount();
  const r = duet(['start', '--kind', 'audit', '--subject', '-', '--sandbox', 'workspace-write'], { input: 'Look around\n' });
  assert.equal(r.code, 2);
  assert.match(r.err, /an audit runs read-only/);
  assert.equal(sessionCount(), before);
  assert.equal(fs.existsSync(fakeState), false, 'Codex was not called');
});

await test('audit: a cut-off audit goes on in its own thread on retry', () => {
  scriptCodex([{ hang: true, started: true, tier: 'default' }, auditTurn([])]);
  const r = duet(['start', '--kind', 'audit', '--subject', '-'], { input: '# Quick audit\n', env: cutOff });
  assert.equal(r.code, 1, r.err);
  const sid = retrySid(r.err);
  const thread = state(sid).pending.threadId;
  const again = duet(['retry', '--session', sid], { env: { CODEX_HOME: cutHome } });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(calls()[1].args.slice(0, 3), ['exec', 'resume', thread]);
  assert.ok(calls()[1].args.includes('sandbox_mode="read-only"'), 'read-only on resume too');
  assert.match(again.out, /^Findings: none$/m);
  assert.equal(state(sid).phase, 'done');
});

// ---- the queue: at most CODEX_DUET_MAX_PARALLEL Codex turns at once
const callCount = () => {
  try {
    return calls().length;
  } catch {
    return 0; // no call yet
  }
};
const idsIn = (phase) => fs.readdirSync(home).filter((d) => {
  try {
    return state(d).phase === phase;
  } catch {
    return false;
  }
});
const oneSlot = { CODEX_DUET_MAX_PARALLEL: '1', CODEX_DUET_QUEUE_POLL_MS: '50' };

await test('queue: with one slot the next turns wait as queued, then run in the order they queued', async () => {
  scriptCodex([{ delayMs: 1500, ...turn('approve', []) }, { delayMs: 300, ...turn('approve', []) }, turn('approve', [])]);
  for (const n of ['A', 'B', 'C']) fs.writeFileSync(path.join(tmp, `queue-${n}.md`), `queue-${n}-content\n`);
  const start = (n) => duetAsync(['start', '--kind', 'file', '--subject', `queue-${n}.md`], { cwd: tmp, env: oneSlot });
  const a = start('A');
  await waitFor(() => callCount() === 1);
  const b = start('B');
  await waitFor(() => idsIn('queued').length === 1);
  const c = start('C');
  await waitFor(() => idsIn('queued').length === 2);
  for (const r of await Promise.all([a, b, c])) assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls().map((x) => /queue-([ABC])-content/.exec(x.prompt)?.[1]), ['A', 'B', 'C']);
  assert.equal(fs.readdirSync(path.join(home, '.queue')).length, 0, 'no tickets left behind');
});

await test('queue: a turn stopped while it waits reads codex-failed, and retry runs it', async () => {
  scriptCodex([{ delayMs: 1500, ...turn('approve', []) }, turn('approve', [])]);
  for (const n of ['D', 'E']) fs.writeFileSync(path.join(tmp, `queue-${n}.md`), `queue-${n}-content\n`);
  const d = duetAsync(['start', '--kind', 'file', '--subject', 'queue-D.md'], { cwd: tmp, env: oneSlot });
  await waitFor(() => callCount() === 1);
  const e = duetAsync(['start', '--kind', 'file', '--subject', 'queue-E.md'], { cwd: tmp, env: oneSlot });
  await waitFor(() => idsIn('queued').length === 1);
  const sid = idsIn('queued')[0];
  process.kill(Number(lockHolderPid(sid)), 'SIGTERM');
  const stopped = await e;
  assert.equal(stopped.code, 1);
  assert.match(stopped.err, /cancelled while waiting in the queue/);
  assert.equal(state(sid).phase, 'codex-failed');
  assert.equal((await d).code, 0);
  const r = duet(['retry', '--session', sid], { cwd: tmp });
  assert.equal(r.code, 0, r.err);
  assert.equal(state(sid).phase, 'done');
});

await test('owner: the Claude session that last moved a review owns it; status only reads', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'resolved')])]);
  fs.writeFileSync(path.join(tmp, 'owned.md'), 'v1\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'owned.md'], { cwd: tmp, env: { CLAUDE_CODE_SESSION_ID: 'claude-a' } });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.equal(state(sid).owner, 'claude-a');
  duet(['status', '--session', sid], { cwd: tmp, env: { CLAUDE_CODE_SESSION_ID: 'claude-c' } });
  assert.equal(state(sid).owner, 'claude-a', 'status only reads');
  const r2 = duet(['reply', '--session', sid, '--responses', '-'], {
    cwd: tmp, env: { CLAUDE_CODE_SESSION_ID: 'claude-b' }, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(state(sid).owner, 'claude-b', 'continuing from another Claude session moves the review there');
});

await test('time: no limit per Codex turn by default; --timeout-min sets one, and reply can drop an old one', () => {
  scriptCodex([turn('revise', [issue('C1', 'open')]), turn('approve', [issue('C1', 'resolved')])]);
  fs.writeFileSync(path.join(tmp, 'timed.md'), 'v1\n');
  const r = duet(['start', '--kind', 'file', '--subject', 'timed.md'], { cwd: tmp });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.equal(state(sid).codex.timeoutMin, 0);
  const old = state(sid); // a session from before 0.6.0 stored the old default
  old.codex.timeoutMin = 60;
  fs.writeFileSync(path.join(home, sid, 'state.json'), JSON.stringify(old));
  const r2 = duet(['reply', '--session', sid, '--responses', '-', '--timeout-min', '0'], {
    cwd: tmp, input: responses('x', [{ id: 'C1', action: 'fixed', note: 'done' }]),
  });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(state(sid).codex.timeoutMin, 0);
  const bad = duet(['start', '--kind', 'file', '--subject', 'timed.md', '--timeout-min', '-5'], { cwd: tmp });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--timeout-min must be a whole number \(0: no limit\)/);
});

// ---- the user's stop policy (scripts/policy.mjs): one case per rule, plus rule order
const { decideNextStep } = await import(new URL('../scripts/policy.mjs', import.meta.url).href);
const iss = (iid, severity, disputes = 0) => ({ id: iid, severity, title: iid, disputes, lastAction: null, openedRound: 1 });
const view = (over) => ({
  round: 3, maxRounds: 10, verdict: 'revise', open: [], parked: [], closedThisRound: [],
  history: [{ round: 1, open: 3 }, { round: 2, open: 2 }, { round: 3, open: 1 }], ...over,
});
const decision = (over) => decideNextStep(view(over));

await test('policy 1: a parked critical/high issue escalates at once, even on approve', () => {
  const d = decision({ verdict: 'approve', parked: [iss('C4', 'high')], open: [iss('C1', 'medium')] });
  assert.deepEqual([d.action, d.issues], ['escalate', ['C4']]);
  assert.equal(d.reason, 'critical/high decision parked: owner input needed');
});

await test('policy 2: approve without open critical/high is done; medium/low go to the report', () => {
  const d = decision({ verdict: 'approve', open: [iss('C2', 'medium'), iss('C3', 'low')] });
  assert.equal(d.action, 'done');
  assert.equal(d.reason, 'reviewer approved; no open critical/high issues; report: C2, C3');
});

await test('policy 2: approve with an open high issue is not done', () => {
  assert.equal(decision({ verdict: 'approve', open: [iss('C1', 'high')] }).action, 'continue');
});

await test('policy 2: approve with parked medium brings the decision to the owner', () => {
  const d = decision({ verdict: 'approve', parked: [iss('C5', 'medium')] });
  assert.deepEqual([d.action, d.issues], ['escalate', ['C5']]);
  assert.equal(d.reason, 'reviewer approved; owner decisions remain');
});

await test('policy 3: two rejected disputes are a deadlock', () => {
  const d = decision({ open: [iss('C1', 'high', 2), iss('C2', 'medium', 1)] });
  assert.deepEqual([d.action, d.issues], ['escalate', ['C1']]);
  assert.equal(d.reason, "deadlock: reviewer rejected the author's disputes 2 times");
});

await test('policy 2 before 3: a deadlocked medium does not stop an approved review', () => {
  assert.equal(decision({ verdict: 'approve', open: [iss('C2', 'medium', 2)] }).action, 'done');
});

await test('policy 4: open count not falling for two rounds is a stall', () => {
  const history = [3, 3, 4].map((open, i) => ({ round: i + 1, open }));
  const d = decision({ open: [iss('C1', 'high')], history });
  assert.equal(d.action, 'escalate');
  assert.equal(d.reason, 'stall: open issue count has not fallen for 2 consecutive rounds');
});

await test('policy 4: no open issues is never a stall, whatever the history', () => {
  const flat = [1, 1, 1].map((open, i) => ({ round: i + 1, open }));
  assert.equal(decision({ open: [], history: flat }).action, 'continue');
});

await test('policy 4: progress or too little history is not a stall', () => {
  const falling = [3, 3, 2].map((open, i) => ({ round: i + 1, open }));
  const d = decision({ open: [iss('C1', 'high')], history: falling });
  assert.equal(d.action, 'continue');
  assert.equal(d.reason, 'open: 1, including critical/high: 1');
  assert.equal(decision({ round: 2, open: [iss('C1', 'high')], history: [{ round: 1, open: 1 }, { round: 2, open: 1 }] }).action, 'continue');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);

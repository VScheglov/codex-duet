#!/usr/bin/env node
// Self-test for scripts/duet.mjs against a fake Codex, and for the stop policy: node tests/run.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmVerification } from '../scripts/verification.mjs';
import { checkQuotes } from '../scripts/quotes.mjs';
import { matchingTests, normalizationTests } from './verification.mjs';

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
const turn = (verdict, issues, request_check) => ({ reply: { verdict, summary: `summary: ${verdict}`, issues, request_check } });

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

await matchingTests(test, tmp);
await normalizationTests(test, tmp);

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

await test('quotes: closing and unchanged citations keep their earlier check; open re-citations use the new snapshot', () => {
  const oldQuote = 'const reviewedStatement = "before the fix";';
  const newQuote = 'const correctedStatement = "after the fix";';
  const cited = (iid, status = 'open', extra = {}) => issue(iid, status, 'high', { path: 'a.js', line: 1, quote: oldQuote, ...extra });
  scriptCodex([
    turn('revise', Array.from({ length: 6 }, (_, n) => cited(`C${n + 1}`))),
    turn('revise', [
      cited('C1', 'resolved'),
      cited('C2', 'withdrawn'),
      cited('C3', 'resolved', { path: 'quoted-location.js', quote: 'This new closing citation should not replace the original.' }),
      cited('C4', 'open', { line: 88 }),
      cited('C5', 'open', { quote: newQuote }),
      cited('C6', 'open', { path: 'quoted-location.js' }),
    ]),
  ]);
  const env = { FIXTURE_DECISIONS: JSON.stringify({ 1: 'continue', 2: 'escalate' }) };
  fs.writeFileSync(path.join(repo, 'a.js'), `${oldQuote}\n`);
  const start = duet(['start', '--kind', 'code'], { env });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const before = state(sid);
  assert.equal(before.issues.C1.quoteCheck.mark, 'ok');
  fs.writeFileSync(path.join(repo, 'a.js'), `${newQuote}\n`);
  fs.writeFileSync(path.join(repo, 'quoted-location.js'), 'const unrelatedStatement = true;\n');
  const r = duet(['reply', '--session', sid, '--responses', '-'], { env,
    input: responses('replaced the buggy statement', Object.keys(before.issues).map((iid) => ({ id: iid, action: 'fixed', note: 'a.js:1 now uses the corrected statement.' }))),
  });
  assert.equal(r.code, 0, r.err);
  const after = state(sid);
  assert.notEqual(after.rounds[0].snapshot.tree, after.rounds[1].snapshot.tree);
  for (const iid of ['C1', 'C2', 'C3', 'C4']) {
    const i = after.issues[iid];
    assert.deepEqual(i.quoteCheck, before.issues[iid].quoteCheck, `${iid} must retain the check of its original citation`);
    assert.deepEqual([i.path, i.line, i.quote], ['a.js', 1, oldQuote]);
    assert.deepEqual(i.history.at(-1).quoteCheck, before.issues[iid].quoteCheck);
    assert.deepEqual(after.rounds[1].quoteChecks[iid], before.issues[iid].quoteCheck);
  }
  assert.deepEqual(['C1', 'C2', 'C3', 'C4'].map((iid) => after.issues[iid].status), ['resolved', 'withdrawn', 'resolved', 'open']);
  for (const [iid, mark] of [['C5', 'ok'], ['C6', 'MISSING']]) {
    assert.equal(after.issues[iid].quoteCheck.mark, mark);
    assert.equal(after.issues[iid].quoteCheck.round, 2);
    assert.equal(after.issues[iid].quoteCheck.tree, after.rounds[1].snapshot.tree);
    assert.equal(after.issues[iid].status, 'open');
  }
  for (const text of [r.out, duet(['status', '--session', sid]).out]) {
    const closed = text.split('### Closed this round')[1].split('### Open')[0];
    assert.match(closed, /C1.*resolved/);
    assert.doesNotMatch(closed, /Quote check:/);
  }
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  for (const iid of ['C1', 'C2', 'C3']) {
    assert.match(report, new RegExp(`\\| ${iid} \\|[^\\n]*\\| ok \\|`));
    const detail = report.split(`### ${iid} `)[1].split('\n### ')[0];
    assert.match(detail, /Quote check: ok/);
    assert.doesNotMatch(detail, /MISSING|other_file:/);
  }
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  fs.rmSync(path.join(repo, 'quoted-location.js'));
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
    // without O_EXLOCK a stale lock is never broken automatically; a person deletes it, as the error says
    for (const r of racers) assert.match(r.err, /stale lock/);
    fs.rmSync(path.join(home, sid, 'lock'));
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
  let holder = 0;
  await waitFor(() => {
    // the running call's lock: on Linux another session's lock can be left with a dead pid, and readdir has no order;
    // the pid is kept, never read again, since a released lock reads empty and kill(0) would hit the whole group
    for (const f of fs.readdirSync(home).map((d) => path.join(home, d, 'lock'))) {
      const pid = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
      if (pid > 0 && isAlive(pid)) [lock, holder] = [f, pid];
    }
    return lock && fs.existsSync(fakeState) && calls().length === 1;
  });
  process.kill(holder, 'SIGTERM');
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
const matchingRequest = { status: 'matches', notes: 'The requested behavior is covered.' };
const author = (summary, responses = [], request_check = matchingRequest) => ({ reply: { summary, tests: 'node --test: ok', responses, questions: [], request_check } });
const reviewJSON = (verdict, issues, request_check = matchingRequest) => JSON.stringify({ verdict, summary: `review: ${verdict}`, issues, request_check });
const reviewIssue = (iid, status, extra = {}) => ({
  id: iid, status, severity: 'high', title: `Issue ${iid}`, body: `Body of ${iid}`, location: '', recommendation: `Fix ${iid}`, confidence: 0.9, reply: '', ...extra,
});
const gitIdentity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
let buildId;

await test('build: Codex implements the spec in a worktree on its own branch', () => {
  scriptCodex([{ ...author('added greet()'), write: { 'greet.js': 'export const greet = (n) => `hi ${n}`;\n' } }]);
  const r = duet(['start', '--kind', 'build', '--subject', '-'], { input: '# Greeting\n\n## Owner\'s request\n> Add greet(name).\n' });
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
  const { subject, approval, rounds } = state(buildId);
  assert.equal(approval.tree, rounds.at(-1).snapshot.tree);
  assert.equal(approval.round, 2);
  assert.ok(!Number.isNaN(Date.parse(approval.at)));
  const f = duet(['finish', '--session', buildId], { env: gitIdentity });
  assert.equal(f.code, 0, f.err);
  assert.ok(!fs.existsSync(subject.worktree), 'the worktree is removed');
  assert.equal(state(buildId).phase, 'finished');
  assert.equal(git(['rev-parse', `${subject.branch}^{tree}`]).trim(), approval.tree);
  for (const tree of [subject.base, approval.tree]) assert.ok(f.out.includes(tree), f.out);
  assert.match(f.out, /approved and committed trees are equal/i);
  const report = fs.readFileSync(path.join(home, buildId, 'report.md'), 'utf8');
  assert.ok(report.includes(`Approved tree: ${approval.tree}`), report);
  assert.ok(report.includes(`Committed tree: ${approval.tree}`), report);
  assert.match(spawnSync('git', ['show', `${subject.branch}:greet.js`], { cwd: repo, encoding: 'utf8' }).stdout, /"there"/);
  assert.equal(spawnSync('git', ['log', '-1', '--format=%s', subject.branch], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'codex-duet: Greeting');
});

await test('build: finish keeps the spec title whole and names codex-duet once; only a paragraph without a heading is cut', () => {
  const subjectOf = (spec) => {
    scriptCodex([{ ...author('done'), write: { 'note.txt': `${spec.length}\n` } }]);
    const r = duet(['start', '--kind', 'build', '--subject', '-'], { input: `${spec}\n\n## Owner's request\n> Implement the change described above.\n` });
    assert.equal(r.code, 0, r.err);
    const id = sessionId(r.out);
    scriptCodex([]);
    const approved = duet(['review', '--session', id, '--issues', '-'], { input: reviewJSON('approve', []) });
    assert.match(approved.out, /Decision: DONE/, approved.err);
    const f = duet(['finish', '--session', id], { env: gitIdentity });
    assert.equal(f.code, 0, f.err);
    return spawnSync('git', ['log', '-1', '--format=%s', state(id).subject.branch], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  };
  // the title that came out as "codex-duet: codex-duet 0.10.0: … Simplified Chinese by"
  const named = 'codex-duet 0.10.0: English by default, Russian and Simplified Chinese by setting';
  assert.equal(subjectOf(`# ${named}\n\nBody.\n`), named);
  const long = 'Add a greeting helper that also trims names, folds their case and handles empty input';
  assert.equal(subjectOf(`# ${long}\n`), `codex-duet: ${long}`);
  const cut = subjectOf(`${'word '.repeat(40)}end\n`);
  assert.match(cut, /^codex-duet: (word )+word…$/);
  assert.ok(cut.length <= 'codex-duet: '.length + 120, cut);
});

await test('build: discard removes the worktree and deletes the branch', () => {
  scriptCodex([{ ...author('started'), write: { 'tmp.txt': 'x\n' } }]);
  const r = duet(['start', '--kind', 'build', '--subject', '-', '--branch', 'try/discard'], { input: "Try something\n\n## Owner's request\n> Try something.\n" });
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
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: "Owner ruling test\n\n## Owner's request\n> Follow the owner's ruling.\n", env });
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

// ---- owner brief: preserve the owner's words and enforce the independent checks
const ownerBrief = "## Owner's request\n> Keep both CSV and JSON exports.\n\n## Accepted amendments\n- none\n\n## Claimed result\nBoth exports work.\n";
const requestSpec = "# Exports\n\n## Owner's request\n> Keep both CSV and JSON exports.\n\n## Accepted amendments\n- none\n\n## Goal\nImplement both exports.\n";
const realPolicy = { CODEX_DUET_POLICY: path.join(HERE, '..', 'scripts', 'policy.mjs') };

// Approval checks use real trees, indexes, commits and hooks in separate repositories.
let approvalRepos = 0;
function approvalRepo() {
  const dir = path.join(tmp, `approval-${++approvalRepos}`);
  fs.mkdirSync(dir);
  git(['init', '-q'], dir);
  git(['config', 'core.filemode', 'true'], dir);
  git(['config', 'core.hooksPath', path.join(dir, '.git', 'hooks')], dir);
  for (const file of ['reviewed.txt', 'covered.txt', 'deleted.txt', 'rename.txt', 'untouched.txt', 'mode.sh']) {
    fs.writeFileSync(path.join(dir, file), `base ${file}\n`);
  }
  git(['add', '-A'], dir);
  commit('base', dir);
  return dir;
}

function approvalBuild({ maxRounds = 10, steps = [] } = {}) {
  const dir = approvalRepo();
  scriptCodex([{
    ...author('implemented'),
    write: { 'reviewed.txt': 'approved\n', 'covered.txt': 'approved covered\n' },
  }, ...steps]);
  const start = duet(['start', '--kind', 'build', '--subject', '-', '--max-rounds', String(maxRounds)], {
    cwd: dir, input: requestSpec, env: realPolicy,
  });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  return { dir, sid, ...state(sid).subject };
}

function approveBuild(sid, issues = []) {
  const r = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('approve', issues), env: realPolicy });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Decision: DONE/);
  return r;
}

await test('approval: build drift commits nothing and returns an approved-to-current round; approving it can finish', () => {
  const { sid, dir, worktree, branch, base } = approvalBuild();
  approveBuild(sid);
  const approved = state(sid).approval.tree;
  const before = git(['rev-parse', branch], dir);
  const index = git(['ls-files', '--stage'], worktree);
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), 'after review\n');
  fs.writeFileSync(path.join(worktree, 'new.txt'), 'untracked\n');
  const f = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /^Nothing was committed/i);
  assert.match(f.out, /edited-after-review.*reviewed\.txt/);
  assert.match(f.out, /never-reviewed.*new\.txt/);
  assert.match(f.out, /covered.*covered\.txt/);
  assert.equal(git(['rev-parse', branch], dir), before);
  assert.equal(git(['ls-files', '--stage'], worktree), index, 'drift must not stage anything');
  const s = state(sid);
  assert.equal(s.round, 2);
  assert.equal(s.phase, 'awaiting-review');
  assert.equal(s.approval, undefined);
  const last = s.rounds.at(-1);
  assert.equal(last.kind, 'post-approval');
  assert.equal(last.author.request_check, undefined, 'this is not a Codex turn');
  assert.equal(calls().length, 1);
  const delta = git(['diff', '--no-renames', approved, last.snapshot.tree], dir);
  assert.ok(f.out.includes(delta.trim()), f.out);
  assert.match(f.out, /This round.*diff/);
  assert.match(f.out, /review --session/);
  assert.match(f.out, /Owner's request: matches — The requested behavior is covered/);
  const report = duet(['report', '--session', sid]);
  assert.match(report.out, /post-approval/);
  assert.match(report.out, /Codex: matches — The requested behavior is covered/);
  const reapproved = approveBuild(sid);
  assert.match(reapproved.out, /Owner's request: matches — The requested behavior is covered/);
  assert.equal(state(sid).approval.tree, last.snapshot.tree);
  const finished = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(finished.code, 0, finished.err);
  assert.equal(git(['rev-parse', `${branch}^{tree}`], dir).trim(), last.snapshot.tree);
  assert.equal(git(['show', `${branch}:new.txt`], dir), 'untracked\n');
  const savedReport = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  for (const tree of [base, last.snapshot.tree]) assert.ok(savedReport.includes(tree), savedReport);
  const verify = duet(['verify', '--session', sid]);
  assert.equal(verify.code, 0, verify.err);
  assert.match(verify.out, /branch commit/i);
  assert.match(verify.out, /matches the approved tree\n$/);
});

await test('approval: revising a post-approval round gives Codex the next turn and latest check', () => {
  const nextCheck = { status: 'matches', notes: 'The fix still covers both exports.' };
  const { sid, worktree } = approvalBuild({ steps: [{
    ...author('fixed drift', [{ id: 'C1', action: 'fixed', note: 'reviewed.txt:1' }], nextCheck),
    write: { 'reviewed.txt': 'fixed by Codex\n' },
  }] });
  approveBuild(sid);
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), 'drift\n');
  assert.equal(duet(['finish', '--session', sid]).code, 0);
  const r = duet(['review', '--session', sid, '--issues', '-'], {
    input: reviewJSON('revise', [reviewIssue('C1', 'open', { body: 'Fix the drift.' })]), env: realPolicy,
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(state(sid).round, 3);
  assert.equal(state(sid).phase, 'awaiting-review');
  assert.equal(state(sid).approval, undefined);
  assert.equal(calls().length, 2);
  assert.match(calls()[1].prompt, /Fix the drift/);
  assert.match(r.out, /Owner's request: matches — The fix still covers both exports/);
  approveBuild(sid, [reviewIssue('C1', 'resolved')]);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('approval: post-approval review consumes a round and respects the Codex round limit', () => {
  const { sid, worktree } = approvalBuild({ maxRounds: 2 });
  approveBuild(sid);
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), 'drift\n');
  assert.equal(duet(['finish', '--session', sid]).code, 0);
  const r = duet(['review', '--session', sid, '--issues', '-'], {
    input: reviewJSON('revise', [reviewIssue('C1', 'open')]), env: realPolicy,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /round limit 2 reached/);
  assert.equal(state(sid).phase, 'escalated');
  assert.equal(calls().length, 1);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('approval: approval names drift written by reviewer tests before finish is called', () => {
  const { sid, worktree } = approvalBuild();
  const reviewed = state(sid).rounds.at(-1).snapshot.tree;
  fs.writeFileSync(path.join(worktree, 'test-output.txt'), 'reviewer test wrote this\n');
  const r = approveBuild(sid);
  assert.equal(state(sid).approval.tree, reviewed, 'approve binds the reviewed snapshot, not a fresh one');
  assert.match(r.out, /never-reviewed.*test-output\.txt/);
  assert.match(r.out, /finish.*back.*review/i);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('approval: rewriting commit hooks leave no commit, keep their edit, and return it for review', () => {
  const { sid, dir, worktree, branch } = approvalBuild();
  approveBuild(sid);
  const before = git(['rev-parse', branch], dir);
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "hook edit\\n" >> reviewed.txt\ngit add reviewed.txt\n', { mode: 0o755 });
  const f = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /^Nothing was committed/i);
  assert.match(f.out, /commit hooks/i);
  assert.match(f.out, /edited-after-review.*reviewed\.txt/);
  assert.equal(git(['rev-parse', branch], dir), before);
  assert.equal(fs.readFileSync(path.join(worktree, 'reviewed.txt'), 'utf8'), 'approved\nhook edit\n');
  assert.equal(state(sid).phase, 'awaiting-review');
  assert.equal(state(sid).rounds.at(-1).kind, 'post-approval');
  fs.rmSync(hook);
  approveBuild(sid);
  assert.equal(duet(['finish', '--session', sid], { env: gitIdentity }).code, 0);
});

await test('approval: rejecting commit hooks preserve the session, files and index for a later finish', () => {
  const { sid, dir, worktree, branch } = approvalBuild();
  approveBuild(sid);
  const before = state(sid);
  const head = git(['rev-parse', branch], dir);
  const status = git(['status', '--porcelain'], worktree);
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
  const f = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(f.code, 1);
  assert.match(f.err, /hook says no/);
  assert.deepEqual(state(sid), before);
  assert.equal(git(['rev-parse', branch], dir), head);
  assert.equal(git(['status', '--porcelain'], worktree), status);
  assert.equal(fs.readFileSync(path.join(worktree, 'reviewed.txt'), 'utf8'), 'approved\n');
  fs.rmSync(hook);
  const retry = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(retry.code, 0, retry.err);
});

await test('approval: finish without DONE requires --unreviewed and records the owner override', () => {
  const { sid, dir, branch } = approvalBuild();
  const before = state(sid);
  const f = duet(['finish', '--session', sid], { env: gitIdentity });
  assert.equal(f.code, 2);
  assert.match(f.err, /content.*not approved/i);
  assert.match(f.err, /finish --unreviewed/);
  assert.deepEqual(state(sid), before);
  const override = duet(['finish', '--session', sid, '--unreviewed'], { env: gitIdentity });
  assert.equal(override.code, 0, override.err);
  const body = git(['log', '-1', '--format=%b', branch], dir);
  assert.match(body, /owner finished without an approval/i);
  assert.match(body, /round 1.*phase awaiting-review/);
  assert.equal(state(sid).finish.unreviewed, true);
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.match(report, /owner finished without an approval/i);
  assert.match(report, /round 1.*phase awaiting-review/);
});

await test('approval: --unreviewed skips drift and hook checks but reports paths against the last approval', () => {
  const { sid, dir, branch, worktree } = approvalBuild();
  approveBuild(sid);
  const approved = state(sid).approval.tree;
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), 'drift\n');
  // First lose the active approval through the normal post-approval path.
  assert.equal(duet(['finish', '--session', sid]).code, 0);
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf "hook edit\\n" >> reviewed.txt\ngit add reviewed.txt\n', { mode: 0o755 });
  const r = duet(['finish', '--session', sid, '--unreviewed'], { env: gitIdentity });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /edited-after-review.*reviewed\.txt/);
  assert.equal(git(['show', `${branch}:reviewed.txt`], dir), 'drift\nhook edit\n');
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.ok(report.includes(approved), report);
  assert.match(report, /edited-after-review.*reviewed\.txt/);
  assert.match(report, /owner finished without an approval/i);
});

await test('approval: code verify and done status detect edits, and the printed reply re-reviews them', () => {
  const dir = approvalRepo();
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'approved\n');
  scriptCodex([turn('approve', [], matchingRequest), turn('approve', [], matchingRequest)]);
  const start = duet(['start', '--kind', 'code'], { cwd: dir, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const approved = state(sid).approval;
  assert.equal(approved.tree, state(sid).rounds[0].snapshot.tree);
  const index = git(['ls-files', '--stage'], dir);
  const verify = duet(['verify', '--session', sid], { cwd: dir });
  assert.equal(verify.code, 0, verify.err);
  assert.ok(verify.out.includes(approved.tree));
  assert.match(verify.out, /covered.*reviewed\.txt/);
  assert.match(verify.out, /matches the approved tree\n$/);
  assert.match(duet(['status', '--session', sid]).out, /matches the approved tree\n$/);
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'edited\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  const drift = duet(['verify'], { cwd: dir });
  assert.equal(drift.code, 1, drift.err);
  assert.match(drift.out, /edited-after-review.*reviewed\.txt/);
  assert.match(drift.out, /never-reviewed.*new\.txt/);
  assert.ok(drift.out.includes(`reply --session ${sid} --responses -`));
  assert.match(drift.out, /"changes": "<what changed after the approval>", "responses": \[\]/);
  assert.match(drift.out, /differs from the approved tree: 2 path\(s\)\n$/);
  assert.equal(git(['ls-files', '--stage'], dir), index);
  const status = duet(['status', '--session', sid]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /differs from the approved tree: 2 path\(s\)\n$/);
  assert.doesNotMatch(status.out, /edited-after-review|never-reviewed/);
  const reply = duet(['reply', '--session', sid, '--responses', '-'], {
    input: responses('Changed after approval.', []), cwd: dir, env: realPolicy,
  });
  assert.equal(reply.code, 0, reply.err);
  assert.equal(state(sid).round, 2);
  assert.equal(calls().length, 2);
  assert.match(calls()[1].prompt, /\+edited/);
  assert.notEqual(state(sid).approval.tree, approved.tree);
  assert.equal(duet(['verify', '--session', sid]).code, 0);
});

await test('approval: classification includes deletions, renames by path, mode-only edits and reverts', () => {
  const dir = approvalRepo();
  fs.writeFileSync(path.join(dir, 'covered.txt'), 'covered\n');
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'approved\n');
  fs.rmSync(path.join(dir, 'deleted.txt'));
  fs.renameSync(path.join(dir, 'rename.txt'), path.join(dir, 'renamed.txt'));
  fs.chmodSync(path.join(dir, 'mode.sh'), 0o755);
  const strange = 'space\tline\n.txt';
  fs.writeFileSync(path.join(dir, strange), 'approved\n');
  scriptCodex([turn('approve', [], matchingRequest)]);
  const start = duet(['start', '--kind', 'code'], { cwd: dir, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const same = duet(['verify', '--session', sid]);
  assert.equal(same.code, 0, same.err);
  for (const file of ['deleted.txt', 'rename.txt', 'renamed.txt', 'mode.sh']) assert.match(same.out, new RegExp(`covered.*${file}`));
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'base reviewed.txt\n'); // reverting to base is still an edit
  fs.writeFileSync(path.join(dir, 'deleted.txt'), 'base deleted.txt\n');
  fs.writeFileSync(path.join(dir, 'untouched.txt'), 'never reviewed\n');
  fs.rmSync(path.join(dir, 'renamed.txt'));
  fs.chmodSync(path.join(dir, 'mode.sh'), 0o644);
  fs.writeFileSync(path.join(dir, strange), 'edited\n');
  const r = duet(['verify', '--session', sid]);
  assert.equal(r.code, 1, r.err);
  for (const file of ['reviewed.txt', 'deleted.txt', 'renamed.txt', 'mode.sh']) assert.match(r.out, new RegExp(`edited-after-review.*${file}`));
  assert.match(r.out, /never-reviewed.*untouched\.txt/);
  assert.ok(r.out.includes(JSON.stringify(strange)), r.out);
  assert.match(r.out, /differs from the approved tree: 6 path\(s\)\n$/);
});

await test('approval: non-DONE clears code and build approvals, including failed Codex turns', () => {
  const dir = approvalRepo();
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'approved\n');
  scriptCodex([turn('approve', [], matchingRequest), { fail: 'network unavailable' }]);
  const start = duet(['start', '--kind', 'code'], { cwd: dir, env: realPolicy });
  const sid = sessionId(start.out);
  const failed = duet(['reply', '--session', sid, '--responses', '-'], { input: responses('another look', []), env: realPolicy });
  assert.equal(failed.code, 1);
  assert.equal(state(sid).approval, undefined);
  assert.equal(duet(['verify', '--session', sid]).code, 1);
  const build = approvalBuild({ maxRounds: 1 });
  approveBuild(build.sid);
  const revise = duet(['review', '--session', build.sid, '--issues', '-'], {
    input: reviewJSON('revise', [reviewIssue('C1', 'open')]), env: realPolicy,
  });
  assert.equal(revise.code, 0, revise.err);
  assert.equal(state(build.sid).approval, undefined);
  assert.equal(duet(['finish', '--session', build.sid]).code, 2);
  assert.equal(duet(['discard', '--session', build.sid]).code, 0);
});

await test('approval: older sessions without approval verify as unapproved and require the override', () => {
  const { sid, dir, branch } = approvalBuild();
  approveBuild(sid);
  const old = state(sid);
  delete old.approval;
  fs.writeFileSync(path.join(home, sid, 'state.json'), JSON.stringify(old));
  const verify = duet(['verify', '--session', sid]);
  assert.equal(verify.code, 1, verify.err);
  assert.match(verify.out, /no approval recorded/);
  assert.match(duet(['status', '--session', sid]).out, /no approval recorded/);
  const finish = duet(['finish', '--session', sid]);
  assert.equal(finish.code, 2);
  assert.match(finish.err, /finish --unreviewed/);
  assert.equal(git(['rev-parse', branch], dir).trim(), old.subject.base);
  assert.equal(duet(['finish', '--session', sid, '--unreviewed'], { env: gitIdentity }).code, 0);
  const codeDir = approvalRepo();
  fs.writeFileSync(path.join(codeDir, 'reviewed.txt'), 'review me\n');
  scriptCodex([turn('approve', [])]);
  const start = duet(['start', '--kind', 'code'], { cwd: codeDir });
  const codeId = sessionId(start.out);
  const oldCode = state(codeId);
  delete oldCode.approval;
  fs.writeFileSync(path.join(home, codeId, 'state.json'), JSON.stringify(oldCode));
  const codeVerify = duet(['verify', '--session', codeId]);
  assert.equal(codeVerify.code, 1, codeVerify.err);
  assert.match(codeVerify.out, /no approval recorded/);
});

await test('approval: verify explains its scope for plan and file reviews', () => {
  for (const kind of ['plan', 'file']) {
    fs.writeFileSync(path.join(tmp, 'verify.md'), 'review\n');
    scriptCodex([turn('approve', [])]);
    const start = duet(['start', '--kind', kind, '--subject', 'verify.md'], { cwd: tmp });
    const sid = sessionId(start.out);
    const r = duet(['verify', '--session', sid]);
    assert.equal(r.code, 2);
    assert.match(r.err, /code and build sessions/);
    assert.equal(state(sid).approval, undefined);
  }
});

await test('brief stdin: stored verbatim and passed inside owner_brief, with focus retained', () => {
  scriptCodex([turn('approve', [], matchingRequest)]);
  const r = duet(['start', '--kind', 'code', '--brief', '-', '--focus', 'export compatibility'], { input: ownerBrief, env: realPolicy });
  assert.equal(r.code, 0, r.err);
  const sid = sessionId(r.out);
  assert.ok(fs.existsSync(path.join(home, sid, 'brief.md')), 'the brief is stored in the session');
  assert.equal(fs.readFileSync(path.join(home, sid, 'brief.md'), 'utf8'), ownerBrief);
  assert.ok(calls()[0].prompt.includes(`<owner_brief>\n${ownerBrief}</owner_brief>`));
  assert.match(calls()[0].prompt, /<owner_focus>\nexport compatibility\n<\/owner_focus>/);
  assert.match(calls()[0].prompt, /Request: /);
  assert.match(r.out, /Owner's request: matches — The requested behavior is covered\./);
  assert.equal(state(sid).brief, path.join(home, sid, 'brief.md'));
  assert.deepEqual(state(sid).rounds[0].request_check, matchingRequest);
  const status = duet(['status', '--session', sid]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /Owner's request: matches/);
  const reportFile = path.join(home, sid, 'report.md');
  assert.ok(fs.readFileSync(reportFile, 'utf8').includes(reportFile.replace('report.md', 'brief.md')));
  const report = duet(['report', '--session', sid]);
  assert.equal(report.code, 0, report.err);
  assert.match(report.out, /Codex: matches — The requested behavior is covered\./);
});

await test('brief path: plan stdin stays available, case and heading whitespace are ignored', () => {
  const briefPath = path.join(tmp, 'owner-brief.md');
  const brief = "##   oWnEr'S ReQuEsT   \n> Keep exports.\n";
  fs.writeFileSync(briefPath, brief);
  scriptCodex([turn('approve', [], matchingRequest)]);
  const r = duet(['start', '--kind', 'plan', '--subject', '-', '--brief', briefPath], {
    cwd: tmp, input: '# Plan\nKeep exports.\n', env: realPolicy,
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(path.join(home, sessionId(r.out), 'brief.md'), 'utf8'), brief);
  assert.ok(calls()[0].prompt.includes(brief));
  assert.match(calls()[0].prompt, /<subject_file.*\n# Plan/);
});

await test('no brief: the prompt says none given and the reviewer can report no-brief', () => {
  scriptCodex([turn('approve', [], { status: 'no-brief', notes: 'No brief supplied.' })]);
  const r = duet(['start', '--kind', 'code'], { env: realPolicy });
  assert.equal(r.code, 0, r.err);
  assert.match(calls()[0].prompt, /<owner_brief>\n\(none given\)\n<\/owner_brief>/);
  assert.match(r.out, /Owner brief: none/);
  assert.match(r.out, /Owner's request: no-brief — No brief supplied\./);
  assert.match(r.out, /Decision: DONE/);
});

await test('brief and build input refusals leave no session, worktree, branch or Codex call', () => {
  const invalidDocuments = [
    '', '## Claimed result\nEverything works.\n', "## Owner's request\n\n## Claimed result\nWorks.\n",
    "## Owner's request\n>   \n\n## Accepted amendments\n- none\n",
    "### Owner's request\n> Export both.\n", "```markdown\n## Owner's request\n> Fake heading.\n```\n",
    "## Owner's request\n# Another section\nUnrelated text.\n",
  ];
  const cases = [
    { args: ['--kind', 'plan', '--subject', '-', '--brief', '-'], input: ownerBrief, message: /stdin|--subject -/ },
    { args: ['--kind', 'audit', '--subject', '-', '--brief', '-'], input: ownerBrief, message: /--brief.*audit|audit.*--brief/ },
    { args: ['--kind', 'build', '--subject', '-', '--brief', '-'], input: requestSpec, message: /--brief.*spec|spec.*Owner's request/ },
    ...invalidDocuments.map((input) => ({ args: ['--kind', 'code', '--brief', '-'], input, message: /non-empty.*## Owner's request/ })),
    ...invalidDocuments.map((input) => ({ args: ['--kind', 'build', '--subject', '-', '--branch', 'refused/owner-brief'], input, message: /non-empty.*## Owner's request/ })),
  ];
  const sessions = fs.readdirSync(home).sort();
  const branches = git(['for-each-ref', '--format=%(refname)', 'refs/heads']);
  const worktrees = git(['worktree', 'list', '--porcelain']);
  for (const { args, input, message } of cases) {
    scriptCodex([]);
    const r = duet(['start', ...args], { input });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, message);
    assert.deepEqual(fs.readdirSync(home).sort(), sessions);
    assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads']), branches);
    assert.equal(git(['worktree', 'list', '--porcelain']), worktrees);
    assert.ok(!fs.existsSync(fakeState), 'refusal precedes any Codex turn');
  }
});

await test('review DONE is guarded by the latest request check, even with no issues', () => {
  for (const [status, decision] of [['matches', 'DONE'], ['narrowed', 'ESCALATE'], ['unclear', 'DONE']]) {
    scriptCodex([turn('approve', [], { status, notes: '"Keep both CSV and JSON exports": JSON is missing.' })]);
    const r = duet(['start', '--kind', 'code', '--brief', '-'], { input: ownerBrief, env: realPolicy });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Decision: ${decision}`));
    assert.match(r.out, new RegExp(`Owner's request: ${status}`));
    const sid = sessionId(r.out);
    assert.equal(state(sid).decision.enforced, status === 'narrowed' ? true : undefined);
    assert.match(duet(['status', '--session', sid]).out, new RegExp(`Owner's request: ${status}`));
    assert.match(fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8'), new RegExp(`Codex: ${status}`));
    if (status === 'narrowed') assert.match(r.out, /reviewer reports.*narrows the owner's request/);
  }
});

await test('request narrowing survives policy conversions to DONE and is reassessed next round', () => {
  const narrowed = { status: 'narrowed', notes: '"Keep both CSV and JSON exports": only CSV is planned.' };
  for (const action of ['continue', 'escalate']) {
    scriptCodex([turn('approve', [], narrowed)]);
    const r = duet(['start', '--kind', 'code', '--brief', '-'], {
      input: ownerBrief, env: { FIXTURE_DECISIONS: JSON.stringify({ 1: action }) },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Decision: ESCALATE.*enforced by duet.mjs/);
  }
  const requestIssue = issue('C1', 'open', 'high', { title: 'Request: JSON export is missing' });
  scriptCodex([turn('revise', [requestIssue], narrowed), turn('approve', [{ ...requestIssue, status: 'resolved' }], matchingRequest)]);
  const start = duet(['start', '--kind', 'code', '--brief', '-'], { input: ownerBrief, env: realPolicy });
  const sid = sessionId(start.out);
  assert.equal(start.code, 0, start.err);
  const reply = duet(['reply', '--session', sid, '--responses', '-'], {
    input: responses('Restored JSON export.', [{ id: 'C1', action: 'fixed', note: 'Both exports now exist.' }]), env: realPolicy,
  });
  assert.equal(reply.code, 0, reply.err);
  assert.match(reply.out, /Decision: DONE/);
  assert.match(calls()[1].prompt, /owner brief from round 1 still applies/i);
  assert.match(calls()[1].prompt, /request_check/);
  assert.deepEqual(state(sid).rounds.map((r) => r.request_check.status), ['narrowed', 'matches']);
});

await test('older and malformed Codex checks normalize to unclear without crashing', () => {
  for (const request_check of [undefined, null, [], 'matches', { status: 'wrong', notes: 'x' }, { status: 'matches' }, { status: 'matches', notes: 1 }]) {
    scriptCodex([turn('approve', [], request_check)]);
    const r = duet(['start', '--kind', 'code'], { env: realPolicy });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Decision: DONE/);
    assert.match(r.out, /Owner's request: unclear — \(not reported\)/);
    assert.deepEqual(state(sessionId(r.out)).rounds[0].request_check, { status: 'unclear', notes: '(not reported)' });
  }
});

await test('build checks the spec against the request and refuses invalid approvals without changing state', () => {
  scriptCodex([author('Implemented both exports.')]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  assert.ok(calls()[0].prompt.includes(requestSpec.trim()));
  assert.match(calls()[0].prompt, /before building/i);
  assert.match(calls()[0].prompt, /request_check/);
  assert.match(calls()[0].prompt, /questions/);
  assert.match(start.out, /Owner's request: matches/);
  const before = state(sid);
  const reviews = [undefined, null, { status: 'matches' }, { status: 'narrowed', notes: 'JSON is missing.' }, { status: 'no-brief', notes: '' }];
  for (const request_check of reviews) {
    const r = duet(['review', '--session', sid, '--issues', '-'], {
      input: JSON.stringify({ verdict: 'approve', summary: 'Looks good.', issues: [], request_check }), env: realPolicy,
    });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /approve|approval/i);
    assert.match(r.err, /request_check|raise an issue/i);
    assert.deepEqual(state(sid), before, 'a refused approval must not mutate the session');
    assert.equal(calls().length, 1);
  }
  const approved = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('approve', []), env: realPolicy });
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /Decision: DONE/);
  assert.match(approved.out, /Owner's request: matches/);
  assert.match(approved.out, /Owner's request \(Claude\): matches/);
  assert.deepEqual(state(sid).rounds[0].author.request_check, matchingRequest);
  assert.deepEqual(state(sid).rounds[0].request_check, matchingRequest);
  const status = duet(['status', '--session', sid]);
  assert.match(status.out, /Owner's request \(Claude\): matches/);
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.ok(report.includes(path.join(home, sid, 'spec.md')));
  assert.match(report, /Codex: matches/);
  assert.match(report, /Claude: matches/);
});

await test('build disagreement escalates with both checks, including missing and malformed implementer checks', () => {
  for (const request_check of [
    { status: 'narrowed', notes: '"Keep both CSV and JSON exports": only CSV exists.' },
    { status: 'unclear', notes: 'Cannot verify JSON without a sample.' },
    undefined, { status: 'matches', notes: false }, { status: 'no-brief', notes: 'Invalid in a build.' },
  ]) {
    const reply = { summary: 'Built exports.', tests: 'ok', responses: [], questions: [], request_check };
    scriptCodex([{ reply }]);
    const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
    assert.equal(start.code, 0, start.err);
    const sid = sessionId(start.out);
    const status = ['narrowed', 'unclear'].includes(request_check?.status) ? request_check.status : 'unclear';
    const approved = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('approve', []), env: realPolicy });
    assert.equal(approved.code, 0, approved.err);
    assert.match(approved.out, /Decision: ESCALATE.*enforced by duet.mjs/);
    assert.match(approved.out, new RegExp(`Owner's request: ${status}`));
    assert.match(approved.out, /Owner's request \(Claude\): matches/);
    assert.equal(state(sid).decision.enforced, true);
    assert.equal(calls().length, 1);
    const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
    assert.match(report, new RegExp(`Codex: ${status}`));
    assert.match(report, /Claude: matches/);
    assert.match(duet(['status', '--session', sid]).out, new RegExp(`Owner's request: ${status}`));
    assert.equal(duet(['discard', '--session', sid]).code, 0);
  }
});

await test('build later rounds use the current implementer check and retain the latest reviewer check', () => {
  const specPath = path.join(tmp, 'export-spec.md');
  fs.writeFileSync(specPath, requestSpec);
  const narrowed = { status: 'narrowed', notes: '"Keep both CSV and JSON exports": JSON is missing.' };
  for (const [first, current, decision] of [[narrowed, matchingRequest, 'DONE'], [matchingRequest, narrowed, 'ESCALATE']]) {
    scriptCodex([author('First implementation.', [], first), author('Updated implementation.', [{ id: 'C1', action: 'fixed', note: 'Checked both exports.' }], current)]);
    const start = duet(['start', '--kind', 'build', '--subject', specPath], { env: realPolicy });
    assert.equal(start.code, 0, start.err);
    const sid = sessionId(start.out);
    const revised = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('revise', [reviewIssue('C1', 'open')], first), env: realPolicy });
    assert.equal(revised.code, 0, revised.err);
    assert.match(revised.out, new RegExp(`Owner's request: ${current.status}`));
    assert.match(revised.out, new RegExp(`Owner's request \\(Claude, round 1\\): ${first.status}`));
    assert.match(calls()[1].prompt, /Re-check the implementation as it stands/);
    assert.match(calls()[1].prompt, /request_check/);
    const pendingReport = duet(['report', '--session', sid]);
    assert.equal(pendingReport.code, 0, pendingReport.err);
    assert.match(pendingReport.out, new RegExp(`Codex: ${current.status}`));
    assert.match(pendingReport.out, new RegExp(`Claude: ${first.status}`));
    const approved = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('approve', [reviewIssue('C1', 'resolved')]), env: realPolicy });
    assert.equal(approved.code, 0, approved.err);
    assert.match(approved.out, new RegExp(`Decision: ${decision}`));
    const rounds = state(sid).rounds;
    assert.deepEqual(rounds.map((r) => r.author.request_check), [first, current]);
    assert.deepEqual(rounds.map((r) => r.request_check), [first, matchingRequest]);
    assert.equal(calls().length, 2);
    assert.equal(duet(['discard', '--session', sid]).code, 0);
  }
});

await test('an owner ruling still gives Codex a turn after a request-check disagreement', () => {
  const narrowed = { status: 'narrowed', notes: '"Keep both CSV and JSON exports": JSON is missing.' };
  scriptCodex([author('CSV only.', [], narrowed), author('Both exports.', [{ id: 'C1', action: 'fixed', note: 'Followed the owner ruling.' }])]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const gap = reviewIssue('C1', 'open', { severity: 'medium', title: 'Request: retain JSON export', body: narrowed.notes });
  const approve = (extra) => duet(['review', '--session', sid, '--issues', '-'], {
    input: reviewJSON('approve', [{ ...gap, ...extra }]), env: realPolicy,
  });
  assert.match(approve({}).out, /Decision: ESCALATE.*enforced by duet.mjs/);
  const ruled = approve({ owner: true, reply: 'Owner decision: retain JSON export.' });
  assert.equal(ruled.code, 0, ruled.err);
  assert.equal(calls().length, 2);
  assert.match(calls()[1].prompt, /Owner decision \(final\): Owner decision: retain JSON export/);
  assert.equal(state(sid).phase, 'awaiting-review');
  assert.equal(state(sid).issues.C1.ownerRuled, true);
  const done = approve({ status: 'resolved' });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Decision: DONE/);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('request ruling: the owner can settle either build disagreement, and the ruling persists', () => {
  for (const codexStatus of ['narrowed', 'unclear']) {
    for (const status of ['matches', 'narrowed-accepted']) {
      const check = { status: codexStatus, notes: 'Cannot verify both exports.' };
      scriptCodex([author('Export implementation.', [], check), author('Verified the new issue.', [{ id: 'C1', action: 'fixed', note: 'Verified CSV.' }], check)]);
      const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
      assert.equal(start.code, 0, start.err);
      const sid = sessionId(start.out);
      const review = (verdict, issues, request_check = matchingRequest) => duet(['review', '--session', sid, '--issues', '-'], {
        input: reviewJSON(verdict, issues, request_check), env: realPolicy,
      });
      assert.match(review('approve', []).out, /Decision: ESCALATE/);
      const ruling = { status, notes: 'The owner accepts the export result after inspecting it.', owner: true };
      const settled = review('approve', [], ruling);
      assert.equal(settled.code, 0, settled.err);
      assert.match(settled.out, /Decision: DONE/);
      assert.match(settled.out, /Owner decision \(final\).*The owner accepts the export result/);
      assert.deepEqual(state(sid).rounds[0].request_check, ruling);
      assert.equal(state(sid).requestRuling.notes, ruling.notes);
      assert.equal(calls().length, 1, 'settling an approval needs no new Codex turn');
      assert.match(duet(['status', '--session', sid]).out, /Owner decision \(final\).*The owner accepts/);
      assert.match(fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8'), /Owner decision \(final\).*The owner accepts/);
      if (status === 'narrowed-accepted') assert.match(settled.out, /Owner's request \(Claude\): narrowed-accepted/);
      assert.match(review('approve', []).out, /Decision: DONE/, 'an ordinary review does not erase the ruling');
      const gap = reviewIssue('C1', 'open', { title: 'Request: preserve CSV export' });
      const next = review('revise', [gap]);
      assert.equal(next.code, 0, next.err);
      assert.equal(state(sid).phase, 'awaiting-review', 'ordinary high issues still get a Codex turn');
      assert.ok(calls()[1].prompt.includes(`Owner decision (final): ${status} — ${ruling.notes}`));
      assert.match(calls()[1].prompt, /accepted amendment/);
      assert.match(review('approve', [{ ...gap, status: 'resolved' }]).out, /Decision: DONE/);
      assert.equal(duet(['discard', '--session', sid]).code, 0);
    }
  }
});

await test('request ruling: a review narrowing without issues can be settled and Codex sees the amendment every round', () => {
  const narrowed = { status: 'narrowed', notes: 'The owner asked for both exports; JSON is absent.' };
  const gap = issue('C1', 'open', 'high', { title: 'Request: CSV is incomplete' });
  scriptCodex([turn('approve', [], narrowed), turn('approve', [], narrowed), turn('revise', [gap], narrowed)]);
  const start = duet(['start', '--kind', 'code', '--brief', '-'], { input: ownerBrief, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  assert.match(start.out, /Decision: ESCALATE/);
  const sid = sessionId(start.out);
  const decision = 'The owner accepts CSV only for this release.';
  const settled = duet(['reply', '--session', sid, '--responses', '-'], {
    input: JSON.stringify({ changes: 'Owner settled the scope.', responses: [], request_ruling: decision }), env: realPolicy,
  });
  assert.equal(settled.code, 0, settled.err);
  assert.match(settled.out, /Decision: DONE/);
  assert.equal(calls().length, 2);
  assert.ok(calls()[1].prompt.includes(`Owner decision (final): ${decision}`));
  assert.match(calls()[1].prompt, /accepted amendment/);
  assert.equal(state(sid).requestRuling.notes, decision);
  assert.match(settled.out, /Owner decision \(final\).*The owner accepts CSV only/);
  assert.match(duet(['status', '--session', sid]).out, /Owner decision \(final\).*The owner accepts CSV only/);
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.match(report, /Owner decision \(final\).*The owner accepts CSV only/);
  const next = duet(['reply', '--session', sid, '--responses', '-'], { input: responses('Check CSV again.', []), env: realPolicy });
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, /Decision: ESCALATE — stall:/, 'a ruling does not waive the ordinary stall policy for new issues');
  assert.equal(state(sid).issues.C1.status, 'open');
  assert.ok(calls()[2].prompt.includes(decision));
});

await test('a request ruling does not override an unrelated parked build issue', () => {
  const first = reviewIssue('C1', 'open');
  const second = reviewIssue('C2', 'open');
  scriptCodex([
    author('Done.'),
    author('Needs an owner decision.', [
      { id: 'C1', action: 'needs-user', note: 'The owner must choose the CSV format.' },
      { id: 'C2', action: 'disputed', note: 'Current JSON format is correct.' },
    ]),
    author('An unrelated ruling should not start this turn.'),
  ]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  const review = (request_check) => duet(['review', '--session', sid, '--issues', '-'], {
    input: reviewJSON('revise', [first, second], request_check), env: realPolicy,
  });
  assert.equal(review(matchingRequest).code, 0);
  const ruled = review({ status: 'matches', notes: 'The owner confirmed the requested scope.', owner: true });
  assert.equal(ruled.code, 0, ruled.err);
  assert.match(ruled.out, /Decision: ESCALATE — critical\/high decision parked/);
  assert.equal(state(sid).issues.C1.parked, true);
  assert.equal(calls().length, 2);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('request rulings may be recorded before escalation and cannot be forged by a Codex check', () => {
  scriptCodex([author('Done.')]);
  const build = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(build.code, 0, build.err);
  const bid = sessionId(build.out);
  const approved = duet(['review', '--session', bid, '--issues', '-'], {
    input: reviewJSON('approve', [], { status: 'narrowed-accepted', notes: 'The owner accepted CSV only before review.', owner: true }), env: realPolicy,
  });
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /Decision: DONE/);
  assert.equal(duet(['discard', '--session', bid]).code, 0);
  const fakeRuling = { status: 'narrowed', notes: 'The reviewer cannot grant an owner ruling.', owner: true };
  scriptCodex([turn('approve', [], fakeRuling), turn('approve', [], fakeRuling)]);
  const start = duet(['start', '--kind', 'code', '--brief', '-'], { input: ownerBrief, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  assert.match(start.out, /Decision: ESCALATE/);
  assert.equal(state(sessionId(start.out)).requestRuling, undefined);
  scriptCodex([turn('approve', [], matchingRequest), turn('approve', [], fakeRuling)]);
  const matching = duet(['start', '--kind', 'code', '--brief', '-'], { input: ownerBrief, env: realPolicy });
  const ruled = duet(['reply', '--session', sessionId(matching.out), '--responses', '-'], {
    input: JSON.stringify({ changes: '', responses: [], request_ruling: 'The owner now accepts CSV only.' }), env: realPolicy,
  });
  assert.equal(ruled.code, 0, ruled.err);
  assert.match(ruled.out, /Decision: DONE/);
});

await test('request rulings are validated without changing state, and do not skip issue answers or round limits', () => {
  scriptCodex([author('Done.')]);
  const build = duet(['start', '--kind', 'build', '--subject', '-', '--max-rounds', '1'], { input: requestSpec, env: realPolicy });
  const bid = sessionId(build.out);
  const before = state(bid);
  for (const request_check of [
    { status: 'matches', notes: '', owner: true }, { status: 'matches', notes: 'x', owner: 'true' },
    { status: 'narrowed-accepted', notes: 'x' }, { status: 'unclear', notes: 'x', owner: true },
    { status: 'narrowed', notes: 'x', owner: true },
  ]) {
    const r = duet(['review', '--session', bid, '--issues', '-'], { input: reviewJSON('approve', [], request_check), env: realPolicy });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /request_check|owner ruling/);
    assert.deepEqual(state(bid), before);
  }
  const ruledAtLimit = duet(['review', '--session', bid, '--issues', '-'], {
    input: reviewJSON('revise', [reviewIssue('C1', 'open')], { status: 'matches', notes: 'The owner clarified the request.', owner: true }), env: realPolicy,
  });
  assert.equal(ruledAtLimit.code, 0, ruledAtLimit.err);
  assert.match(ruledAtLimit.out, /Decision: ESCALATE — round limit/);
  assert.equal(calls().length, 1);
  assert.equal(duet(['discard', '--session', bid]).code, 0);
  const gap = issue('C1', 'open');
  const narrowed = { status: 'narrowed', notes: 'JSON is missing.' };
  scriptCodex([turn('approve', [gap], narrowed)]);
  const review = duet(['start', '--kind', 'code', '--brief', '-', '--max-rounds', '1'], { input: ownerBrief, env: realPolicy });
  const rid = sessionId(review.out);
  const reviewBefore = state(rid);
  for (const request_ruling of ['', '  ', null, 1, {}]) {
    const r = duet(['reply', '--session', rid, '--responses', '-'], {
      input: JSON.stringify({ changes: '', responses: [], request_ruling }), env: realPolicy,
    });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /request_ruling/);
    assert.deepEqual(state(rid), reviewBefore);
  }
  const skipped = duet(['reply', '--session', rid, '--responses', '-'], {
    input: JSON.stringify({ changes: '', responses: [], request_ruling: 'Accept CSV only.' }), env: realPolicy,
  });
  assert.equal(skipped.code, 2, skipped.err);
  assert.match(skipped.err, /missing: C1/);
  assert.deepEqual(state(rid), reviewBefore);
  const settled = duet(['reply', '--session', rid, '--responses', '-'], {
    input: JSON.stringify({ changes: '', responses: [{ id: 'C1', action: 'owner-decided', note: 'Accepted.' }], request_ruling: 'Accept CSV only.' }), env: realPolicy,
  });
  assert.equal(settled.code, 0, settled.err);
  assert.match(settled.out, /Decision: DONE/);
  assert.match(settled.out, /Owner decision \(final\).*Accept CSV only/);
  assert.equal(calls().length, 1, 'rulings at the limit are recorded without spending another round');
});

await test('owner request headings accept typographic and modifier apostrophes without rewriting the brief', () => {
  for (const apostrophe of ['\u2019', '\u02bc']) {
    const brief = `## Owner${apostrophe}s request\n> Keep exports.\n\n## Accepted amendments\n\n## Claimed result\n`;
    scriptCodex([turn('approve', [], matchingRequest)]);
    const review = duet(['start', '--kind', 'code', '--brief', '-'], { input: brief, env: realPolicy });
    assert.equal(review.code, 0, review.err);
    assert.equal(fs.readFileSync(path.join(home, sessionId(review.out), 'brief.md'), 'utf8'), brief);
    assert.ok(calls()[0].prompt.includes(brief));
    scriptCodex([author('Done.')]);
    const build = duet(['start', '--kind', 'build', '--subject', '-'], { input: `# Exports\n\n${brief}`, env: realPolicy });
    assert.equal(build.code, 0, build.err);
    assert.equal(duet(['discard', '--session', sessionId(build.out)]).code, 0);
  }
});

await test('brief file errors are usage errors and leave no session or Codex call', () => {
  const unreadable = path.join(tmp, 'unreadable-brief.md');
  fs.writeFileSync(unreadable, ownerBrief, { mode: 0o000 });
  try {
    for (const file of [path.join(tmp, 'missing-brief.md'), tmp, ...(process.getuid?.() === 0 ? [] : [unreadable])]) {
      const sessions = fs.readdirSync(home).sort();
      scriptCodex([]);
      const r = duet(['start', '--kind', 'code', '--brief', file]);
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /cannot read --brief/);
      assert.ok(r.err.includes(file));
      assert.deepEqual(fs.readdirSync(home).sort(), sessions);
      assert.ok(!fs.existsSync(fakeState));
    }
  } finally {
    fs.chmodSync(unreadable, 0o600);
  }
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
  const r = duet(['start', '--kind', 'build', '--subject', '-'], { input: "A long task\n\n## Owner's request\n> Complete the long task.\n", env: cutOff });
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

// ---- verification receipts: only completed commands in this attempt's saved events are evidence
const check = (command, outcome = 'passed', note = '') => ({ command, outcome, note });
const withReceipt = (step, checks, gaps = [], commands = []) => ({
  ...step, reply: { ...step.reply, checks, gaps }, commands,
});
function receiptReview(checks, gaps = [], commands = []) {
  scriptCodex([withReceipt(turn('approve', []), checks, gaps, commands)]);
  const result = duet(['start', '--kind', 'file', '--subject', 'a.js'], { env: realPolicy });
  assert.equal(result.code, 0, result.err);
  const sid = sessionId(result.out);
  return { ...result, sid, receipt: state(sid).rounds[0].verification,
    report: fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8') };
}

await test('verification: agreeing passed and failed checks are executed, shown at DONE and saved in the report', () => {
  const r = receiptReview([check('node --test'), check('node repro.mjs', 'failed', 'Reproduced the reported crash')], [], [
    { command: 'node --test', exit_code: 0 }, { command: 'node repro.mjs', exit_code: 1 },
    { command: 'cat README.md', exit_code: 0 }, // reads are not claimed checks
  ]);
  assert.equal(r.receipt.label, 'executed');
  assert.deepEqual(r.receipt.checks.map((c) => c.confirmation), ['confirmed', 'confirmed']);
  assert.deepEqual(r.receipt.checks[1].event, { command: 'node repro.mjs', exit_code: 1, status: 'failed' });
  assert.match(r.out, /^Decision: DONE.* · verification: executed$/m);
  assert.match(r.out, /Verification: executed\n\n- passed \[confirmed; exit 0; completed\]: node --test/);
  assert.match(r.out, /failed \[confirmed; exit 1; failed\]: node repro.mjs — Reproduced the reported crash/);
  assert.match(r.report, /## Verification\n\n- Round 1: executed/);
  assert.match(r.report, /failed \[confirmed; exit 1; failed\]: node repro.mjs — Reproduced the reported crash/);
  assert.match(duet(['status', '--session', r.sid]).out, /verification: executed/);
  const events = fs.readFileSync(path.join(home, r.sid, 'round-1.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'item.started' && e.item.command === "/bin/zsh -lc 'node --test'"));
  assert.ok(events.some((e) => e.type === 'item.completed' && e.item.exit_code === 1 && e.item.status === 'failed'));
});

await test('verification: unrelated later commands cannot hide a failing check in the summary or report', () => {
  const r = receiptReview([check('pytest tests/test_tools.py')], [], [
    { command: 'pytest tests/test_tools.py', exit_code: 1 }, { command: 'ls', exit_code: 0 },
  ]);
  assert.equal(r.receipt.label, 'static-analysis-only');
  assert.equal(r.receipt.checks[0].confirmation, 'contradicted');
  assert.equal(r.receipt.checks[0].event.command, 'pytest tests/test_tools.py');
  for (const text of [r.out, r.report]) assert.match(text, /passed \[contradicted; exit 1; failed\]: pytest tests\/test_tools.py/);
});

await test('verification: masked segment exits remain unconfirmed in the summary and report', () => {
  const r = receiptReview([check('pytest -q'), check('npm test'), check('make lint'), check('go test ./...')], [], [
    { command: 'pytest -q | tail -5', exit_code: 0 }, { command: 'npm test || true', exit_code: 0 },
    { command: 'make lint; echo done', exit_code: 0 }, { command: 'cd pkg && go test ./...', exit_code: 0 },
  ]);
  assert.equal(r.receipt.label, 'partial');
  assert.deepEqual(r.receipt.checks.map((c) => c.confirmation), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'confirmed']);
  assert.match(r.out, /^Decision: DONE.*verification: partial$/m);
  for (const text of [r.out, r.report]) {
    assert.match(text, /passed \[unconfirmed\]: pytest -q/);
    assert.match(text, /passed \[unconfirmed\]: npm test/);
    assert.match(text, /passed \[unconfirmed\]: make lint/);
    assert.match(text, /passed \[confirmed; exit 0; completed\]: go test/);
  }
});

await test('verification: exact masked commands remain unconfirmed in the summary and report', () => {
  const checks = ['pytest -q | tail -5', 'npm test || true', 'make lint; echo done'].map((command) => check(command));
  const commands = checks.map(({ command }) => ({ command, exit_code: 0 }));
  const r = receiptReview(checks, [], commands);
  assert.equal(r.receipt.label, 'static-analysis-only');
  assert.deepEqual(r.receipt.checks.map((c) => c.confirmation), ['unconfirmed', 'unconfirmed', 'unconfirmed']);
  assert.match(r.out, /^Decision: DONE.*verification: static-analysis-only$/m);
  for (const text of [r.out, r.report]) {
    for (const { command } of checks) assert.ok(text.includes(`passed [unconfirmed; exit 0; completed]: ${command}`), text);
  }
});

await test('verification: malformed receipts do not fail review or build turns or change their decisions', () => {
  const checks = [check('node --test'), { command: 'npm run lint', outcome: 'passed' }, null];
  const commands = [{ command: 'node --test', exit_code: 0 }];
  const file = receiptReview(checks, 'not an array', commands);
  assert.equal(state(file.sid).phase, 'done');
  assert.equal(file.receipt.label, 'partial');
  assert.equal(file.receipt.checks.length, 1);
  for (const text of [file.out, file.report]) {
    assert.match(text, /2 malformed checks dropped/);
    assert.match(text, /malformed gaps ignored/);
  }
  scriptCodex([withReceipt(author('Implemented.'), checks, 'not an array', commands)]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  assert.equal(state(sid).phase, 'awaiting-review');
  assert.equal(state(sid).rounds[0].verification.label, 'partial');
  assert.match(start.out, /2 malformed checks dropped/);
  assert.match(start.out, /malformed gaps ignored/);
  assert.match(approveBuild(sid).out, /Decision: DONE.*verification: partial/);
  assert.equal(calls().length, 1, 'no retry or extra Codex turn');
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('verification: skips and gaps each make a confirmed turn partial and explain the missing coverage', () => {
  for (const [skips, gaps] of [
    [[check('npm run integration', 'skipped', 'Missing credentials')], []],
    [[], ['Windows paths were not examined']],
    [[check('npm run integration', 'skipped', 'Missing credentials')], ['Windows paths were not examined']],
  ]) {
    const r = receiptReview([check('node --test'), ...skips], gaps, [{ command: 'node --test', exit_code: 0 }]);
    assert.equal(r.receipt.label, 'partial');
    assert.match(r.out, /^Decision: DONE.*verification: partial$/m);
    for (const text of [r.out, r.report]) {
      if (skips.length) assert.match(text, /skipped: npm run integration — Missing credentials/);
      if (gaps.length) assert.match(text, /Gap: Windows paths were not examined/);
    }
    if (skips.length) assert.equal(r.receipt.checks[1].confirmation, 'skipped');
  }
});

await test('verification: empty, skipped, contradicted or unmatched checks alone are static-analysis-only', () => {
  for (const [checks, commands] of [
    [[], [{ command: 'node --test', exit_code: 0 }]], // do not invent checks from events
    [[check('npm test', 'skipped', 'Sandbox denied execution')], [{ command: 'npm test', exit_code: 0 }]],
    [[check('npm test')], [{ command: 'npm test', exit_code: 1 }]],
    [[check('npm test')], []],
  ]) {
    const r = receiptReview(checks, [], commands);
    assert.equal(r.receipt.label, 'static-analysis-only');
    assert.match(r.out, /^Decision: DONE.*verification: static-analysis-only$/m);
    assert.match(r.report, /Round 1: static-analysis-only/);
    if (checks[0]?.outcome === 'skipped') assert.match(r.out, /Sandbox denied execution/);
  }
});

await test('verification: conflicting exits, missing events, unfinished commands and unknown exits stay visible', () => {
  const r = receiptReview([
    check('node --test'), check('npm run lint'), check('npm run build', 'failed', 'Compiler error claimed'),
    check('npm run integration'), check('npm run smoke'), check('npm run unknown', 'failed', 'No exit available'),
  ], [], [
    { command: 'node --test', exit_code: 0 }, { command: 'npm run lint', exit_code: 1 },
    { command: 'npm run build', exit_code: 0 }, { command: 'npm run smoke', completed: false },
    { command: 'npm run unknown', exit_code: null, status: 'failed' },
  ]);
  assert.equal(r.receipt.label, 'partial');
  assert.deepEqual(r.receipt.checks.map((c) => c.confirmation), [
    'confirmed', 'contradicted', 'contradicted', 'unconfirmed', 'unconfirmed', 'unconfirmed',
  ]);
  for (const text of [r.out, r.report]) {
    assert.match(text, /passed \[contradicted; exit 1; failed\]: npm run lint/);
    assert.match(text, /failed \[contradicted; exit 0; completed\]: npm run build — Compiler error claimed/);
    assert.match(text, /passed \[unconfirmed\]: npm run integration/);
    assert.match(text, /passed \[unconfirmed\]: npm run smoke/);
    assert.match(text, /failed \[unconfirmed; exit unknown; failed\]: npm run unknown/);
  }
});

await test('verification: shell wrappers, escaped quotes, whitespace, complete segments and the last match', () => {
  const quoted = "node -e 'assert.equal(1, 1)'";
  const r = receiptReview([
    check('npm test -- --runInBand'), check('npm run lint -- --quiet'), check(quoted), check('node repro.mjs', 'failed', 'Last attempt failed'),
  ], [], [
    { command: 'npm test', rawCommand: 'bash -lc "cd app && npm  test -- --runInBand"', exit_code: 0 },
    { command: 'npm run lint -- --quiet', rawCommand: '/bin/bash -lc "npm run lint -- --quiet"', exit_code: 0 },
    { command: quoted, exit_code: 0 },
    { command: 'node repro.mjs', exit_code: 0 }, { command: 'node repro.mjs', exit_code: 2 },
  ]);
  assert.equal(r.receipt.label, 'executed');
  assert.equal(r.receipt.checks[2].event.command, quoted);
  assert.equal(r.receipt.checks[3].event.exit_code, 2);
});

await test('verification: large streams are read through, ignoring malformed lines and unrelated events', async () => {
  const file = path.join(tmp, 'large.events.jsonl');
  const event = (command, exit_code) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command, exit_code, status: exit_code ? 'failed' : 'completed' } });
  fs.writeFileSync(file, [
    event('node early.mjs', 0), 'not JSON', 'null',
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', command: 'node mcp.mjs', exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(4_500_000) } }),
    event('node late.mjs', 0), // intentionally no trailing newline
  ].join('\n'));
  const receipt = await confirmVerification({ checks: [check('node early.mjs'), check('node late.mjs'), check('node mcp.mjs')], gaps: [] }, file);
  assert.equal(receipt.label, 'partial');
  assert.deepEqual(receipt.checks.map((c) => c.confirmation), ['confirmed', 'confirmed', 'unconfirmed']);
});

await test('verification: build Tests block shows facts before review and keeps its label at DONE', () => {
  const step = { reply: { summary: 'Implemented exports.', responses: [], questions: [], request_check: matchingRequest } };
  scriptCodex([withReceipt(step, [
    check('node --test'), check('npm run lint'), check('npm run integration', 'skipped', 'Missing credentials'),
  ], ['Browser paths were only inspected'], [{ command: 'node --test', exit_code: 0 }, { command: 'npm run lint', exit_code: 1 }])]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  assert.match(start.out, /Tests: partial\n\n- passed \[confirmed/);
  assert.match(start.out, /passed \[contradicted; exit 1; failed\]: npm run lint/);
  assert.match(start.out, /skipped: npm run integration — Missing credentials/);
  assert.match(start.out, /Gap: Browser paths were only inspected/);
  assert.equal(state(sid).rounds[0].author.tests, undefined, 'new replies need no free-text tests field');
  const reviewed = approveBuild(sid);
  assert.match(reviewed.out, /^Decision: DONE.*verification: partial$/m);
  assert.equal(state(sid).rounds[0].verification.label, 'partial');
  const report = fs.readFileSync(path.join(home, sid, 'report.md'), 'utf8');
  assert.match(report, /## Verification\n\n- Round 1: partial/);
  assert.match(report, /contradicted; exit 1; failed/);
  assert.match(report, /Missing credentials/);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('verification: legacy review/build replies and older round records stay unknown', () => {
  for (const kind of ['file', 'build']) {
    scriptCodex([kind === 'build' ? author('Older reply.') : turn('approve', [])]);
    const start = duet(['start', '--kind', kind, '--subject', kind === 'build' ? '-' : 'a.js'], { input: kind === 'build' ? requestSpec : '', env: realPolicy });
    assert.equal(start.code, 0, start.err);
    const sid = sessionId(start.out);
    assert.equal(state(sid).rounds[0].verification.label, 'unknown');
    if (kind === 'build') {
      assert.match(start.out, /Tests: unknown\n\n- Legacy Tests claim \(unconfirmed\): node --test: ok/);
      assert.match(approveBuild(sid).out, /verification: unknown/);
    } else assert.match(start.out, /verification: unknown/);
    const old = state(sid);
    delete old.rounds[0].verification;
    fs.writeFileSync(path.join(home, sid, 'state.json'), JSON.stringify(old));
    const status = duet(['status', '--session', sid]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /verification: unknown/);
    assert.match(duet(['report', '--session', sid]).out, /Round 1: unknown/);
    if (kind === 'build') assert.equal(duet(['discard', '--session', sid]).code, 0);
  }
});

await test('verification: retry in the same review/build thread uses only the overwritten attempt events', () => {
  for (const kind of ['file', 'build']) {
    const reply = kind === 'build' ? author('Resumed.') : turn('approve', []);
    scriptCodex([
      { hang: true, started: true, tier: 'default', commands: [{ command: 'npm run earlier-only', exit_code: 0 }, { command: 'npm test', exit_code: 0 }] },
      withReceipt(reply, [check('npm test'), check('node resumed.mjs'), check('npm run earlier-only')], [], [
        { command: 'npm test', exit_code: 1 }, { command: 'node resumed.mjs', exit_code: 0 },
      ]),
    ]);
    const start = duet(['start', '--kind', kind, '--subject', kind === 'build' ? '-' : 'a.js'], { input: kind === 'build' ? requestSpec : '', env: cutOff });
    assert.equal(start.code, 1, start.err);
    const sid = retrySid(start.err);
    const thread = state(sid).pending.threadId;
    const retry = duet(['retry', '--session', sid], { env: { CODEX_HOME: cutHome } });
    assert.equal(retry.code, 0, retry.err);
    assert.deepEqual(calls()[1].args.slice(0, 3), ['exec', 'resume', thread]);
    const s = state(sid);
    assert.equal(s.rounds.length, 1);
    assert.equal(s.rounds[0].verification.label, 'partial');
    assert.deepEqual(s.rounds[0].verification.checks.map((c) => c.confirmation), ['contradicted', 'confirmed', 'unconfirmed']);
    assert.doesNotMatch(fs.readFileSync(path.join(home, sid, 'round-1.events.jsonl'), 'utf8'), /earlier-only.*exit_code/);
    assert.match(calls()[1].prompt, /this resumed attempt's saved events/);
    if (kind === 'build') assert.equal(duet(['discard', '--session', sid]).code, 0);
  }
});

await test('verification: report lists each Codex round and gives the latest receipt', () => {
  scriptCodex([
    withReceipt(turn('revise', [issue('C1', 'open')]), [check('node first.mjs')], [], [{ command: 'node first.mjs', exit_code: 0 }]),
    withReceipt(turn('approve', [issue('C1', 'resolved')]), [check('node second.mjs', 'skipped', 'No time')], ['Second path not examined']),
  ]);
  const start = duet(['start', '--kind', 'file', '--subject', 'a.js'], { env: realPolicy });
  const sid = sessionId(start.out);
  const next = duet(['reply', '--session', sid, '--responses', '-'], { input: responses('fixed', [{ id: 'C1', action: 'fixed', note: 'Fixed' }]), env: realPolicy });
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, /verification: static-analysis-only/);
  const report = duet(['report', '--session', sid]).out;
  assert.match(report, /- Round 1: executed\n- Round 2: static-analysis-only/);
  assert.match(report, /Last Codex turn: round 2\nVerification: static-analysis-only/);
  assert.match(report, /skipped: node second.mjs — No time/);
  assert.match(report, /Gap: Second path not examined/);
});

await test('verification: post-approval rounds have no receipt and retain the latest real Codex label', () => {
  const dir = approvalRepo();
  scriptCodex([withReceipt({ ...author('Implemented.'), write: { 'reviewed.txt': 'approved\n' } }, [
    check('node --test'), check('npm run integration', 'skipped', 'Missing credentials'),
  ], [], [{ command: 'node --test', exit_code: 0 }])]);
  const start = duet(['start', '--kind', 'build', '--subject', '-'], { cwd: dir, input: requestSpec, env: realPolicy });
  assert.equal(start.code, 0, start.err);
  const sid = sessionId(start.out);
  approveBuild(sid);
  fs.writeFileSync(path.join(state(sid).subject.worktree, 'reviewed.txt'), 'post approval\n');
  const drift = duet(['finish', '--session', sid]);
  assert.equal(drift.code, 0, drift.err);
  assert.equal(state(sid).rounds.at(-1).kind, 'post-approval');
  assert.equal(state(sid).rounds.at(-1).verification, undefined);
  assert.match(drift.out, /Last Codex turn: round 1\nTests: partial/);
  assert.match(drift.out, /Missing credentials/);
  assert.match(approveBuild(sid).out, /^Decision: DONE.*verification: partial$/m);
  assert.match(duet(['status', '--session', sid]).out, /verification: partial/);
  const report = duet(['report', '--session', sid]).out;
  const section = report.split('## Verification\n')[1].split('| ID |')[0];
  assert.match(section, /Round 1: partial/);
  assert.doesNotMatch(section, /Round 2:/);
  assert.match(section, /Last Codex turn: round 1/);
  assert.match(section, /Missing credentials/);
  assert.equal(calls().length, 1);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('verification: receipt labels never change stop decisions for the same verdict and issues', () => {
  for (const [verdict, issues] of [['approve', []], ['revise', [issue('C1', 'open')]]]) {
    let baseline;
    for (const receipt of [null, { checks: [], gaps: [] },
      { checks: [check('npm test', 'failed', 'Tests failed')], gaps: [] },
      { checks: [check('npm test', 'skipped', 'Sandbox')], gaps: ['Not all paths read'] },
      { checks: [check('npm test'), check('npm run lint')], gaps: [] },
    ]) {
      scriptCodex([{ reply: { ...turn(verdict, issues).reply, ...(receipt ?? {}) }, commands: [{ command: 'npm test', exit_code: 1 }] }]);
      const start = duet(['start', '--kind', 'file', '--subject', 'a.js'], { env: realPolicy });
      assert.equal(start.code, 0, start.err);
      const d = state(sessionId(start.out)).decision;
      baseline ??= d;
      assert.deepEqual(d, baseline);
    }
  }
});

// ---- quote checks: each citation belongs to the immutable snapshot of its review round
const quotedIssue = (iid, quote, extra = {}) => issue(iid, 'open', 'high', { path: 'checked.js', line: 2, quote, ...extra });
let quoteSession;
let quoteRepo;
const snapshotQuote = 'const snapshotEvidence = "reviewed content";';
const changedQuote = 'const newerUnreviewedValue = "after review started";';
const otherQuote = 'export const otherEvidence = "another file";';
const otherQuoteFile = 'other\tfile\n数据.js';

await test('quotes: code marks ok, moved, other_file, MISSING and unchecked, using the saved tree despite reviewer writes', () => {
  quoteRepo = approvalRepo();
  fs.writeFileSync(path.join(quoteRepo, 'checked.js'), `const a = 1;\n${snapshotQuote}\n`);
  fs.writeFileSync(path.join(quoteRepo, otherQuoteFile), `${otherQuote}\n`);
  fs.writeFileSync(path.join(quoteRepo, 'binary.dat'), 'binary\0with a quote inside');
  const issues = [
    quotedIssue('C1', snapshotQuote),
    quotedIssue('C2', snapshotQuote, { line: 88 }),
    quotedIssue('C3', otherQuote),
    quotedIssue('C4', 'const inventedEvidence = "not in this snapshot";'),
    quotedIssue('C5', ''),
    quotedIssue('C6', '+const a = 1;', { line: 1 }),
    issue('C7', 'open'), // older reviewer JSON, without the three new fields
    quotedIssue('C8', snapshotQuote, { path: '' }),
    quotedIssue('C9', 'with a quote inside', { path: 'binary.dat' }),
    quotedIssue('C10', snapshotQuote, { line: 0 }),
    quotedIssue('C11', snapshotQuote, { line: 5 }), // distance 3 is still ok
    quotedIssue('C12', snapshotQuote, { line: 6 }),
    quotedIssue('C13', snapshotQuote, { path: '../outside.js' }),
  ];
  scriptCodex([{ ...turn('revise', issues), write: { 'checked.js': `${changedQuote}\n`, [otherQuoteFile]: 'gone from disk\n' } }]);
  const index = fs.readFileSync(path.join(quoteRepo, '.git', 'index'));
  const r = duet(['start', '--kind', 'code'], { cwd: quoteRepo, env: realPolicy });
  assert.equal(r.code, 0, r.err);
  quoteSession = sessionId(r.out);
  const s = state(quoteSession);
  const marks = ['ok', 'moved:2', `other_file:${otherQuoteFile}`, 'MISSING', 'unchecked', 'ok', 'unchecked', 'unchecked', 'unchecked', 'ok', 'ok', 'moved:2', 'unchecked'];
  assert.deepEqual(Object.values(s.issues).map((i) => i.quoteCheck.mark), marks);
  for (const i of Object.values(s.issues)) {
    assert.equal(i.quoteCheck.round, 1);
    assert.equal(i.quoteCheck.tree, s.rounds[0].snapshot.tree);
    assert.deepEqual(i.history[0].quoteCheck, i.quoteCheck);
    assert.deepEqual(s.rounds[0].quoteChecks[i.id], i.quoteCheck);
    assert.equal(i.status, 'open');
    assert.equal(i.parked, false);
  }
  assert.deepEqual([s.issues.C7.path, s.issues.C7.line, s.issues.C7.quote], ['', 0, '']);
  assert.equal(fs.readFileSync(path.join(quoteRepo, 'checked.js'), 'utf8'), `${changedQuote}\n`);
  assert.deepEqual(fs.readFileSync(path.join(quoteRepo, '.git', 'index')), index, 'neither snapshotting nor quote checks touch the user index');
  const status = duet(['status', '--session', quoteSession]);
  const report = duet(['report', '--session', quoteSession]);
  assert.equal(report.code, 0, report.err);
  for (const text of [r.out, status.out, report.out]) {
    assert.match(text, /Quote check: MISSING — not found in checked\.js at snapshot [\da-f]{10}/);
    assert.match(text, /Quote check: moved:2 — moved to line 2/);
    assert.ok(text.includes(`Quote check: other_file:${otherQuoteFile}`), text);
  }
  assert.match(report.out, /Quote check: ok/);
  assert.match(report.out, /Quote check: unchecked/);
  assert.equal(fs.readFileSync(path.join(home, quoteSession, 'report.md'), 'utf8'), report.out);
  assert.doesNotMatch(r.out, /Quote check: (?:ok|unchecked)/);
  assert.match(calls()[0].prompt, /The runner checks each quote against the snapshot/);
});

await test('quotes: MISSING needs an answer; later citations use their own snapshot and omitted quotes retain their previous check', () => {
  const before = state(quoteSession);
  const missingAnswer = duet(['reply', '--session', quoteSession, '--responses', '-'], { input: responses('none', []) });
  assert.equal(missingAnswer.code, 2);
  assert.match(missingAnswer.err, /C4/);
  assert.equal(state(quoteSession).issues.C4.status, 'open');
  scriptCodex([turn('revise', [
    ...Object.keys(before.issues).map((iid) => iid === 'C4' ? quotedIssue(iid, changedQuote, { line: 1 }) : issue(iid, 'open')),
    quotedIssue('C14', snapshotQuote),
  ])]);
  const r = duet(['reply', '--session', quoteSession, '--responses', '-'], {
    input: responses('checked each citation', Object.keys(before.issues).map((iid) => ({ id: iid, action: 'disputed', note: 'Please re-cite against the saved tree.' }))),
    env: realPolicy,
  });
  assert.equal(r.code, 0, r.err);
  const s = state(quoteSession);
  assert.equal(s.issues.C4.quoteCheck.mark, 'ok');
  assert.equal(s.issues.C4.quoteCheck.round, 2);
  assert.equal(s.issues.C4.quoteCheck.tree, s.rounds[1].snapshot.tree);
  assert.equal(s.issues.C4.history[0].quoteCheck.mark, 'MISSING');
  assert.equal(s.issues.C4.history.at(-1).quoteCheck.mark, 'ok');
  assert.equal(s.issues.C14.quoteCheck.mark, 'MISSING', 'the first snapshot citation no longer exists in round 2');
  assert.deepEqual(s.issues.C2.quoteCheck, before.issues.C2.quoteCheck);
  assert.equal(s.issues.C2.quote, snapshotQuote);
  assert.deepEqual(s.rounds[1].quoteChecks.C2, before.issues.C2.quoteCheck);
  assert.match(calls()[0].prompt, /Quote check: MISSING/);
  assert.match(calls()[0].prompt, /Quote check: moved:2/);
  assert.match(calls()[0].prompt, /Quote check: unchecked/);
  assert.match(calls()[0].prompt, /<output_contract>[\s\S]*path:[\s\S]*line:[\s\S]*quote:/);
});

await test('quotes: deduplicate the three longest needles, use short/multiline fallbacks and strip a diff marker once', () => {
  const dir = approvalRepo();
  const present = 'const quotedValue = true;';
  fs.writeFileSync(path.join(dir, 'checked.js'), `${present}\nabc123\nxyz789\n+const actualPlus = true;\n`);
  const absent = 'const thisLongInventedCitationDoesNotExist = true;';
  scriptCodex([turn('revise', [
    quotedIssue('C1', `${absent}\n${absent}\n${present}`, { line: 0 }),
    quotedIssue('C2', `${absent} 1\n${absent} 2\n${absent} 3\n${present}`),
    quotedIssue('C3', 'abc123', { line: 2 }),
    quotedIssue('C4', 'abc123\nxyz789', { line: 2 }),
    quotedIssue('C5', 'tiny'),
    quotedIssue('C6', `-${present}`, { line: 1 }),
    quotedIssue('C7', '+const actualPlus = true;', { line: 4 }),
    quotedIssue('C8', `  ${present}  `, { line: 1 }),
    quotedIssue('C9', '++const quotedValue = true;', { line: 1 }),
    quotedIssue('C10', present, { line: -5 }),
    quotedIssue('C11', present, { line: 2.5 }),
  ])]);
  const r = duet(['start', '--kind', 'code'], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.values(state(sessionId(r.out)).issues).map((i) => i.quoteCheck.mark),
    ['ok', 'MISSING', 'ok', 'ok', 'unchecked', 'ok', 'ok', 'ok', 'MISSING', 'ok', 'ok']);
  const { issues } = state(sessionId(r.out));
  assert.equal(issues.C10.line, 0);
  assert.equal(issues.C11.line, 0);
});

await test('quotes: plan/file reviews read snapshot copies and accept a single empty path, listed symlink, relative or absolute path', () => {
  for (const kind of ['plan', 'file']) {
    const dir = approvalRepo();
    const file = path.join(dir, 'source.md');
    const listed = './listed-plan.md';
    const quote = 'Keep the exact approved plan wording.';
    fs.writeFileSync(file, `${quote}\n`);
    fs.symlinkSync('source.md', path.join(dir, 'listed-plan.md'));
    scriptCodex([{ ...turn('revise', ['', listed, 'source.md', file].map((p, n) => quotedIssue(`C${n + 1}`, quote, { path: p, line: 1 }))),
      write: { 'source.md': 'changed while Codex ran\n' } }]);
    const r = duet(['start', '--kind', kind, '--subject', listed], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    const s = state(sessionId(r.out));
    assert.deepEqual(Object.values(s.issues).map((i) => i.quoteCheck.mark), ['ok', 'ok', 'ok', 'ok']);
    assert.equal(s.rounds[0].snapshot.docs[0].listed, listed);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed while Codex ran\n');
    assert.equal(fs.readFileSync(s.rounds[0].snapshot.docs[0].snap, 'utf8'), `${quote}\n`);
  }
});

await test('quotes: multi-file reviews search only saved subject copies, with no default for an empty or unrelated path', () => {
  const dir = approvalRepo();
  fs.writeFileSync(path.join(dir, 'first.md'), 'First subject file has its own text.\n');
  fs.writeFileSync(path.join(dir, 'second.md'), 'Second subject file holds the evidence.\nabc123\nxyz789\n');
  fs.writeFileSync(path.join(dir, 'outside.md'), 'This file is outside the review subject.\n');
  scriptCodex([{ ...turn('revise', [
    quotedIssue('C1', 'Second subject file holds the evidence.', { path: 'first.md' }),
    quotedIssue('C2', 'This file is outside the review subject.', { path: 'first.md' }),
    quotedIssue('C3', 'First subject file has its own text.', { path: '' }),
    quotedIssue('C4', 'First subject file has its own text.', { path: 'outside.md' }),
    quotedIssue('C5', 'abc123\nxyz789', { path: 'first.md' }),
    quotedIssue('C6', 'abc123\nabsent', { path: 'first.md' }),
  ]), write: { 'second.md': 'no longer on disk\n' } }]);
  const r = duet(['start', '--kind', 'file', '--subject', 'first.md', '--subject', 'second.md'], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.values(state(sessionId(r.out)).issues).map((i) => i.quoteCheck.mark),
    ['other_file:second.md', 'MISSING', 'unchecked', 'unchecked', 'other_file:second.md', 'MISSING']);
});

await test('quotes: build review checks the reviewed tree, sends anomalies to Codex, and accepts legacy Claude reviews', () => {
  const { sid, worktree } = approvalBuild({ steps: [author('answered the review', [
    { id: 'C1', action: 'fixed', note: 'Checked the reviewed snapshot.' },
    { id: 'C2', action: 'disputed', note: 'Please re-cite.' },
  ])] });
  const tree = state(sid).rounds[0].snapshot.tree;
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), `${changedQuote}\n`);
  const r = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('revise', [
    quotedIssue('C1', 'approved', { path: 'reviewed.txt', line: 1 }),
    quotedIssue('C2', changedQuote, { path: 'reviewed.txt', line: 1 }),
  ]), env: realPolicy });
  assert.equal(r.code, 0, r.err);
  const s = state(sid);
  assert.equal(s.issues.C1.quoteCheck.mark, 'ok');
  assert.equal(s.issues.C2.quoteCheck.mark, 'MISSING');
  assert.equal(s.issues.C2.quoteCheck.tree, tree);
  assert.equal(s.issues.C2.quoteCheck.round, 1);
  assert.deepEqual(s.rounds[0].quoteChecks.C2, s.issues.C2.quoteCheck);
  assert.match(calls()[1].prompt, /Quote check: MISSING — not found in reviewed\.txt/);
  assert.match(r.out, /Quote check: MISSING/);
  const approved = approveBuild(sid, [
    reviewIssue('C1', 'resolved', { path: 'reviewed.txt', line: 1, quote: 'approved' }),
    reviewIssue('C2', 'resolved'),
  ]);
  assert.match(approved.out, /Decision: DONE/);
  assert.deepEqual(state(sid).issues.C1.quoteCheck, s.issues.C1.quoteCheck, 'a closing build review keeps the original citation check');
  assert.deepEqual(state(sid).issues.C2.quoteCheck, s.issues.C2.quoteCheck, 'a legacy review does not erase the last check');
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('quotes: Claude checks post-approval review citations against that round, without a Codex turn', () => {
  const { sid, worktree } = approvalBuild({ maxRounds: 2 });
  approveBuild(sid);
  const drift = 'const postApprovalEvidence = "review this drift";';
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), `${drift}\n`);
  assert.equal(duet(['finish', '--session', sid]).code, 0);
  const round = state(sid).rounds.at(-1);
  fs.writeFileSync(path.join(worktree, 'reviewed.txt'), `${changedQuote}\n`);
  const r = duet(['review', '--session', sid, '--issues', '-'], { input: reviewJSON('revise', [
    quotedIssue('C1', drift, { path: 'reviewed.txt', line: 1 }),
    quotedIssue('C2', changedQuote, { path: 'reviewed.txt', line: 1 }),
  ]), env: realPolicy });
  assert.equal(r.code, 0, r.err);
  const s = state(sid);
  assert.equal(s.issues.C1.quoteCheck.mark, 'ok');
  assert.equal(s.issues.C2.quoteCheck.mark, 'MISSING');
  assert.equal(s.issues.C1.quoteCheck.tree, round.snapshot.tree);
  assert.equal(s.issues.C1.quoteCheck.round, 2);
  assert.equal(s.rounds.at(-1).kind, 'post-approval');
  assert.equal(calls().length, 1);
  assert.match(r.out, /Quote check: MISSING/);
  assert.equal(duet(['discard', '--session', sid]).code, 0);
});

await test('quotes: MISSING never changes issue state or stop decisions, including approve with an open medium issue', () => {
  for (const [verdict, severity] of [['revise', 'high'], ['approve', 'medium']]) {
    let baseline;
    for (const citation of [{}, { path: 'checked.js', line: 1, quote: 'This invented evidence is nowhere in the snapshot.' }]) {
      scriptCodex([turn(verdict, [issue('C1', 'open', severity, citation)])]);
      const r = duet(['start', '--kind', 'code'], { cwd: quoteRepo, env: realPolicy });
      assert.equal(r.code, 0, r.err);
      const s = state(sessionId(r.out));
      baseline ??= s.decision;
      assert.deepEqual(s.decision, baseline);
      assert.equal(s.issues.C1.status, 'open');
      assert.equal(s.issues.C1.parked, false);
      assert.equal(s.issues.C1.disputes, 0);
      assert.equal(s.issues.C1.quoteCheck.mark, citation.quote ? 'MISSING' : 'unchecked');
    }
  }
});

await test('quotes: unavailable trees/files and binary document copies are unchecked; older snapshots need no new metadata', () => {
  const mark = (kind, snapshot, extra = {}) => checkQuotes({ kind, cwd: quoteRepo, issues: {} }, {
    issues: [quotedIssue('C1', snapshotQuote, extra)],
  }, snapshot, 1).C1.mark;
  assert.equal(mark('code', undefined), 'unchecked');
  assert.equal(mark('code', { tree: 'f'.repeat(40) }), 'unchecked');
  const tree = state(quoteSession).rounds[0].snapshot.tree;
  assert.equal(mark('code', { tree }, { path: 'nonexistent.js' }), 'unchecked');
  assert.equal(mark('file', { docs: [{ path: 'source.md', snap: path.join(tmp, 'missing-copy'), exists: true }] }, { path: '' }), 'unchecked');
  const snap = path.join(tmp, 'legacy-doc-copy');
  fs.writeFileSync(snap, `${snapshotQuote}\n`);
  const oldSnapshot = { docs: [{ path: path.join(quoteRepo, 'source.md'), snap, exists: true }] };
  assert.equal(mark('plan', oldSnapshot, { path: 'source.md', line: 1 }), 'ok');
  fs.writeFileSync(snap, `binary\0${snapshotQuote}`);
  assert.equal(mark('file', oldSnapshot, { path: '' }), 'unchecked');
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

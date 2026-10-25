#!/usr/bin/env node
// Self-test for the mod (hooks/register.tsx) on a stand-in engine: node tests/mod.mjs
// The sessions it reads are real ones, made by scripts/duet.mjs against the fake Codex.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BELOW, boot, compile, lines, nodes } from './mod-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUET = path.join(HERE, '..', 'scripts', 'duet.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-duet-mod-')));
const repo = path.join(tmp, 'repo');
const elsewhere = path.join(tmp, 'elsewhere');
const home = path.join(tmp, 'state');
const scriptFile = path.join(tmp, 'codex-script.json');
const fakeState = path.join(tmp, 'codex-calls.json');
const decisions = JSON.stringify({ 1: 'continue', 2: 'escalate', 3: 'done' });

const baseEnv = {
  ...process.env,
  CODEX_DUET_HOME: home,
  CODEX_DUET_CODEX_BIN: path.join(HERE, 'fake-codex.mjs'),
  CODEX_DUET_POLICY: path.join(HERE, 'fixture-policy.mjs'),
  FAKE_CODEX_SCRIPT: scriptFile,
  FAKE_CODEX_STATE: fakeState,
  FIXTURE_DECISIONS: decisions,
  CODEX_HOME: path.join(tmp, 'no-codex-home'), // no model catalog, none of the owner's defaults
  CODEX_DUET_MODEL: '',
  CODEX_DUET_EFFORT: '',
  CLAUDE_CODE_SESSION_ID: 'claude-me', // the session the stand-in engine is, unless a call says otherwise
};

const issue = (id, status, severity = 'high', extra = {}) => ({
  id, status, severity, title: `Issue ${id}`, body: `Body of ${id}`, location: 'a.js:1',
  recommendation: `Fix ${id}`, confidence: 0.8, reply: '', ...extra,
});
const turn = (verdict, issues) => ({ reply: { verdict, summary: `summary: ${verdict}`, issues } });
const responses = (list) => JSON.stringify({ changes: 'x', responses: list });

function scriptCodex(steps) {
  fs.writeFileSync(scriptFile, JSON.stringify(steps));
  fs.rmSync(fakeState, { force: true });
}
function duet(args, input = '', env = {}) {
  const r = spawnSync(process.execPath, [DUET, ...args], { cwd: repo, input, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const sessionId = (out) => /codex-duet (\d{8}-\d{6}-[0-9a-f]{4})/.exec(out)?.[1];
const stateFile = (sid) => path.join(home, sid, 'state.json');
const rewrite = (sid, change) => {
  const st = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
  fs.writeFileSync(stateFile(sid), JSON.stringify({ ...st, ...change(st), updatedAt: new Date().toISOString() }));
};
const footer = async (E, options) => lines(await E.render('SessionMode', options));
const RUNNER = `node "${DUET}"`;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

fs.mkdirSync(repo);
fs.mkdirSync(elsewhere);
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
git(['add', 'a.js']);
git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a']);

async function waitFor(check, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const compiled = compile(path.join(HERE, '..', 'hooks', 'register.tsx'), tmp);
// installed from a marketplace, the plugin lives in a folder of the engine's choosing, not in ~/.claude/skills
const installed = path.join(tmp, 'plugins', 'cache', 'codex-duet', 'codex-duet', '0.10.0');
const E = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), CODEX_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, root: installed });
// The Claude app's sounds, as register.tsx names them; the stub says they exist whatever this machine has.
const APP_SFX = '/Applications/Claude.app/Contents/Resources/ion-dist/audio/voice/sfx';
const APP_SOUNDS = ['tool_approval_needed.mp3', 'enter_voice_mode.mp3', 'disconnected.mp3'];
const SYNTH_SOUNDS = ['sounds/decision.wav', 'sounds/done.wav', 'sounds/error.wav'];
const setAppSounds = (isThere) => APP_SOUNDS.forEach((name) => E.setFile(`${APP_SFX}/${name}`, isThere));
setAppSounds(true);
let id;

await test('no session: nothing above the prompt or in the footer, the pane says where it looks', async () => {
  assert.equal(await E.render('AbovePrompt'), BELOW);
  assert.equal(await E.render('SessionMode'), BELOW);
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Сессий codex-duet не найдено.'), pane.join('\n'));
  assert.ok(pane.includes('[Звук: вкл]'));
  assert.ok(pane.includes('[▶ Звуки]'));
});

await test("round 1 ends: toast and suggestion, no sound; band and footer show Claude's turn over other mods' rows", async () => {
  scriptCodex([
    turn('revise', [issue('C1', 'open'), issue('C2', 'open', 'medium')]),
    turn('revise', [issue('C1', 'open', 'high', { reply: 'Still reachable' }), issue('C2', 'resolved', 'medium')]),
    turn('approve', [issue('C1', 'open', 'high', { reply: 'I still disagree' })]),
  ]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  const r = duet(['start', '--kind', 'code']);
  assert.equal(r.code, 0, r.err);
  id = sessionId(r.out);
  await E.tick();
  assert.deepEqual(E.sounds, []);
  assert.ok(E.toasts.some((t) => /раунд 1: открыто 2, из них critical\/high: 1/.test(t)), E.toasts.join('\n'));
  assert.deepEqual(E.suggested, ['продолжай codex-duet']);
  const band = await E.render('AbovePrompt');
  assert.match(lines(band)[0], /ход Claude: 2 замечания/);
  assert.equal(band.children.at(-1), BELOW);
  assert.deepEqual(await footer(E), ['[Duet r1 ✍️]']);
  assert.deepEqual(await footer(E, { surface: 'terminal' }), ['Duet r1 ✍️'], 'no clicks outside fullscreen: plain text');
  assert.equal((await E.render('SessionMode')).children.at(-1), BELOW);
});

await test('commit guard: no commit, push or stash in the reviewed repository; everything else passes', async () => {
  assert.match((await E.bash('git commit -m x')).deny ?? '', /идёт ревью/);
  assert.match((await E.bash('cd sub && git push')).deny ?? '', /идёт ревью/);
  assert.equal((await E.bash('git status')).result, 'core reached');
  assert.equal((await E.bash(`git -C ${elsewhere} commit -m x`)).result, 'core reached');
});

await test("context note: on the person's own messages in the Claude session that drives the review", async () => {
  const typed = await E.prompt('как дела?');
  assert.match(typed.context.join('\n'), new RegExp(`^\\[codex-duet\\] Активная сессия ревью ${id}`));
  assert.ok(typed.context.join('\n').includes(`node "${installed}/scripts/duet.mjs" status --session ${id}`), 'the runner where the plugin is installed');
  assert.ok((await E.prompt('с телефона', 'bridge')).context, 'Remote Control is the person too');
  assert.equal((await E.prompt('<task-notification>', 'task-notification')).context, undefined);
  E.setCwd(elsewhere);
  assert.ok((await E.prompt('из другой папки')).context, 'ownership, not the folder, decides; other sessions are tested below');
  E.setCwd(repo);
});

await test('Stop hold: Claude ran the runner and stopped while the loop waits on it: sent back once', async () => {
  await E.bash(`${RUNNER} status --session ${id}`);
  const r = await E.stop();
  assert.match(r.block ?? '', new RegExp(`^codex-duet ${id}: раунд 1/10 закончен, открыто 2: .*reply`));
  assert.equal((await E.stop({ stop_hook_active: true })).block, undefined);
});

await test('Stop hold: quiet for a question, background work, a scheduled wake-up', async () => {
  assert.equal((await E.stop({ last_assistant_message: 'Исправить C1 так?' })).block, undefined);
  const task = { id: 'b1', type: 'shell', status: 'running', description: 'round 2' };
  assert.equal((await E.stop({ background_tasks: [task] })).block, undefined);
  assert.equal((await E.stop({ session_crons: [{ id: 'c1' }] })).block, undefined);
});

await test("Stop hold: the person's message the loop did not answer lets Claude stop; a notification's turn does not", async () => {
  await E.prompt('а что такое C2?');
  assert.equal((await E.stop()).block, undefined);
  await E.bash(`${RUNNER} status --session ${id}`, { agentId: 'sub-1' });
  assert.equal((await E.stop()).block, undefined, "a subagent's run is not Claude answering");
  await E.bash(`${RUNNER} status --session ${id}`);
  assert.ok((await E.stop()).block);
  await E.prompt('<task-notification>', 'task-notification');
  assert.ok((await E.stop()).block);
});

await test('escalation: decision cue and toast, footer asks for you, the pane sends the chosen side to Claude', async () => {
  const r = duet(['reply', '--session', id, '--responses', '-'], responses([
    { id: 'C1', action: 'disputed', note: 'not reachable' },
    { id: 'C2', action: 'fixed', note: 'done' },
  ]));
  assert.equal(r.code, 0, r.err);
  await E.tick();
  assert.deepEqual(E.sounds, ['tool_approval_needed.mp3']);
  assert.ok(E.toasts.some((t) => /нужно твоё решение — C1/.test(t)));
  assert.match(lines(await E.render('AbovePrompt'))[0], /ждёт твоего решения: C1/);
  assert.deepEqual(await footer(E), ['[Duet 🙋 нужен ты]']);
  assert.equal((await E.stop()).block, undefined, 'escalated: the owner moves next');
  await E.press(await E.render('Pane'), 'pick-codex-C1');
  await E.press(await E.render('Pane'), 'send-decisions');
  assert.match(E.submitted.at(-1), new RegExp(`^codex-duet ${id}: мои решения[\\s\\S]*C1: прав Codex`));
});

await test('the board: a long title wraps whole beside its badge, an issue unfolds to both sides, closed issues fold away', async () => {
  const long = 'Строка с теми же полями в другом порядке проходит проверку, хотя схема требует порядок колонок'.repeat(3);
  rewrite(id, (st) => ({ issues: { ...st.issues, C1: { ...st.issues.C1, title: long } } }));
  await E.tick();
  let tree = await E.render('Pane');
  let rows = lines(tree);
  const title = nodes(tree).find((n) => n.type === 'Text' && n.children.join('').endsWith(long));
  assert.equal(title?.props.wrap, 'wrap', rows.join('\n'));
  assert.ok(!rows.some((l) => l.endsWith('…')), `the mod cuts no text but the task list's labels:\n${rows.join('\n')}`);
  assert.ok(rows.includes('[▸ закрытые · 1]') && !rows.includes('Issue C2'), `C2 is closed and folds while C1 is open:\n${rows.join('\n')}`);
  await E.press(tree, `fold-${id}:C1`);
  rows = lines(await E.render('Pane'));
  const unfolded = rows.slice(rows.indexOf('[▾]'));
  assert.deepEqual(unfolded.slice(3, 6), ['Codex: Still reachable', 'Claude (возразил): not reachable', 'споров: 1'], rows.join('\n'));
  await E.press(await E.render('Pane'), 'fold-closed');
  assert.ok(lines(await E.render('Pane')).includes('Issue C2'));
});

await test('the sound toggle: off silences the cues, toasts stay; the setting is saved', async () => {
  let pane = await E.render('Pane');
  assert.ok(lines(pane).includes('[▸ Настройки: строка вкл · звук вкл]'), 'the switches fold away under one line');
  await E.press(pane, 'settings');
  pane = await E.render('Pane');
  await E.press(pane, 'pref-sound');
  assert.equal(E.stored.get('prefs').sound, false);
  const r = duet(['reply', '--session', id, '--responses', '-'], responses([{ id: 'C1', action: 'owner-decided', note: 'owner: keep' }]));
  assert.equal(r.code, 0, r.err);
  await E.tick();
  assert.deepEqual(E.sounds, ['tool_approval_needed.mp3'], 'no done cue while muted');
  assert.ok(E.toasts.some((t) => /ревью завершено за 3/.test(t)));
  assert.match(lines(await E.render('AbovePrompt'))[0], /✅ готово · проверка: неизвестно/, 'a recently finished review shows its verification');
  assert.equal(await E.render('SessionMode'), BELOW);
  assert.equal((await E.command('duet', 'sound on')).text, 'codex-duet sound: вкл');
});

await test("/duet sound test: the Claude app's sounds in turn; without the app or a working afplay, the plugin's own", async () => {
  const hear = async () => {
    const before = E.sounds.length;
    assert.match((await E.command('duet', 'sound test')).text, /эскалация → конец ревью → сбой/);
    await waitFor(() => E.sounds.length >= before + 3);
    return E.sounds.slice(before);
  };
  assert.deepEqual(await hear(), APP_SOUNDS);
  setAppSounds(false);
  assert.deepEqual(await hear(), SYNTH_SOUNDS, 'no app: the synthesized cues');
  setAppSounds(true);
  E.setAfplayExit(1);
  assert.deepEqual(await hear(), SYNTH_SOUNDS, 'afplay failed: the engine plays the synthesized cues');
  E.setAfplayExit(0);
});

let failed;
await test('a failed round sounds the error cue', async () => {
  scriptCodex([{ fail: 'simulated network error' }]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 3;\n');
  const r = duet(['start', '--kind', 'code']);
  assert.equal(r.code, 1);
  failed = sessionId(r.out + r.err) ?? fs.readdirSync(home).filter((n) => n !== id && !n.startsWith('.')).at(-1);
  await E.tick();
  assert.equal(E.sounds.at(-1), 'disconnected.mp3');
  assert.deepEqual(await footer(E), ['[Duet ⚠️ сбой]']);
});

await test('a running turn: the band names its model, the pane shows it and wraps what Codex says', async () => {
  const long = `I will ${'carefully check one more thing, '.repeat(12)}then report.`;
  const said = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: long } };
  fs.writeFileSync(path.join(home, failed, 'round-1.events.jsonl'), `${JSON.stringify(said)}\n`);
  const codexModel = { model: 'gpt-6.1-sol', effort: 'max', fromConfig: ['model', 'effort'] };
  rewrite(failed, () => ({ phase: 'awaiting-codex', pending: { round: 1, startedAt: new Date().toISOString(), codexModel } }));
  fs.writeFileSync(path.join(home, failed, 'lock'), String(process.pid)); // a runner that lives
  await E.tick();
  assert.match(lines(await E.render('AbovePrompt'))[0], /^⏳ Codex gpt-6\.1-sol\/max · r1\/10 · /);
  const pane = await E.render('Pane');
  assert.ok(lines(pane).includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига)'), lines(pane).join('\n'));
  // markdown, which every surface wraps as it wraps a reply
  const words = nodes(pane).find((n) => n.type === 'Markdown' && n.props.text.startsWith('Codex: I will'));
  assert.equal(words?.props.text, `Codex: ${long}`, 'whole, not cut to one line');
});

await test('Fast: ⚡ on the band and in the pane while a turn runs in Fast; "(из конфига)" until Codex logs it', async () => {
  const runAs = async (tier, fromConfig) => {
    rewrite(failed, (st) => ({ pending: { ...st.pending, codexModel: { model: 'gpt-6.1-sol', effort: 'max', fromConfig, tier } } }));
    await E.tick();
    return { band: lines(await E.render('AbovePrompt'))[0], pane: lines(await E.render('Pane')) };
  };
  const asked = await runAs('priority', ['model', 'effort', 'tier']);
  assert.match(asked.band, /^⏳ Codex gpt-6\.1-sol\/max ⚡ · r1\/10 · /);
  assert.ok(asked.pane.includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига) · ⚡ Fast (из конфига)'), asked.pane.join('\n'));
  const logged = await runAs('priority', ['model', 'effort']);
  assert.ok(logged.pane.includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига) · ⚡ Fast'), logged.pane.join('\n'));
  const standard = await runAs('default', ['model', 'effort']);
  assert.match(standard.band, /^⏳ Codex gpt-6\.1-sol\/max · r1\/10 · /);
  assert.ok(!standard.pane.some((l) => l.includes('⚡')), standard.pane.join('\n'));
});

// ---- a quiet stream: how old Codex's words are, how long it has thought, whether its own log still grows
const MIN = 60_000;
const past = (ms) => new Date(Date.now() - ms);
// the running round's event stream as the runner writes it, last grown `quietMs` ago
const stream = (sid, events, quietMs) => {
  const file = path.join(home, sid, 'round-1.events.jsonl');
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  fs.utimesSync(file, past(quietMs), past(quietMs));
  return file;
};
const ran = (id, command, at) => [
  { type: 'item.started', item: { id, type: 'command_execution', command }, _at: at },
  { type: 'item.completed', item: { id, type: 'command_execution', command, exit_code: 0 }, _at: at },
];

await test('a quiet stream: the words show their age, the pane says how long Codex thinks and how fresh its own log is', async () => {
  const thread = '01a1-quiet-thread';
  const log = path.join(tmp, 'no-codex-home', 'sessions', '2026', '10', '04', `rollout-2026-10-04T00-32-25-${thread}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '{}\n');
  const touchLog = () => fs.utimesSync(log, past(20_000), past(20_000));
  const started = { type: 'thread.started', thread_id: thread, _at: past(60 * MIN).toISOString() };
  const said = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Closing the bypass now.' }, _at: past(30 * MIN).toISOString() };
  stream(failed, [started, said, ...ran('c1', "/bin/zsh -lc 'git status'", past(15 * MIN).toISOString())], 15 * MIN);
  touchLog();
  await E.tick();
  assert.match(lines(await E.render('AbovePrompt'))[0], /· думает 15 мин(?: ·|$)/, 'the band does not pass old words for news');
  let pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => /^Сейчас: думает 15 мин · журнал Codex обновлён 2\d с назад$/.test(l)), pane.join('\n'));
  assert.ok(pane.includes('Codex, 30 мин назад: Closing the bypass now.'), pane.join('\n'));
  // a runner from before 0.7.2 stamps nothing: the words are at least as old as the silence after them
  const bare = (e) => ({ ...e, _at: undefined });
  stream(failed, [started, said, ...ran('c1', "/bin/zsh -lc 'git status'")].map(bare), 15 * MIN);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex, больше 15 мин назад: Closing the bypass now.'), pane.join('\n'));
  // a long command: what it runs and for how long; a stream that just grew needs no age at all
  stream(failed, [started, { type: 'item.started', item: { id: 'c2', type: 'command_execution',
    command: "/bin/zsh -lc '/bin/bash scripts/test_import.sh > log 2>&1; tail -2 log'" } }].map(bare), 6 * MIN);
  touchLog();
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => /^Сейчас: запускает scripts\/test_import\.sh · 6 мин · журнал Codex обновлён 2\d с назад$/.test(l)), pane.join('\n'));
  stream(failed, [started, said].map(bare), 0);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: Closing the bypass now.'), pane.join('\n'));
  // markdown keeps its paragraphs and list in the pane; the band takes it as one line
  const listed = { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Checked `parser`.  \n\n\n- one\n- two' } };
  stream(failed, [started, listed].map(bare), 0);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: Checked `parser`.\n\n- one\n- two'), pane.join('\n'));
  assert.match(lines(await E.render('AbovePrompt'))[0], /· Checked `parser`\. - one - two/);
});

await test('commands read as what they do: the script it runs, the file after the options, no bare flags or long paths', async () => {
  const commands = [
    "/bin/zsh -lc 'IMPORT_TEST_REPORT=\"$PWD/r.tsv\" /bin/bash scripts/test_import.sh > .import-new.log 2>&1; result=$?; tail -2 .import-new.log'",
    "/bin/zsh -lc 'git diff --stat | tail -2'",
    "/bin/zsh -lc 'tail -n 20 build.log'",
    "/bin/zsh -lc 'tail -2 .import-old.log'",
    "/bin/zsh -lc 'PYTHONDONTWRITEBYTECODE=1 /Users/x/.codex/venvs/common/bin/python /Users/x/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/my-skill'",
    "/bin/zsh -lc 'LANG=C /opt/homebrew/bin/jq -r .version /Users/x/proj/package.json'",
  ];
  stream(failed, commands.flatMap((command, n) => ran(`k${n}`, command)), 0);
  await E.tick();
  const shown = lines(await E.render('Pane')).filter((l) => l.startsWith('  · ')).map((l) => l.slice(4));
  assert.deepEqual(shown, [
    'запускает scripts/test_import.sh',
    'git diff',
    'читает build.log',
    'читает .import-old.log',
    'запускает scripts/quick_validate.py',
    '…/jq -r .version …/package.json',
  ]);
  // code fed on stdin says nothing in its first line; a test run names its suite, never a redirection
  const more = [
    "/bin/zsh -lc \"python3 - <<'PY'\nimport json,sys\nsys.path.insert(0, '.')\nPY\"",
    "/bin/zsh -lc 'python3 -m unittest tests.test_importer_parse_rows'",
    "/bin/zsh -lc 'npm test 2>&1 | tail -5'",
    "/bin/zsh -lc 'node -e \"console.log(1)\"'",
  ];
  stream(failed, more.flatMap((command, n) => ran(`m${n}`, command)), 0);
  await E.tick();
  assert.deepEqual(lines(await E.render('Pane')).filter((l) => l.startsWith('  · ')).map((l) => l.slice(4)), [
    'запускает скрипт Python',
    'запускает тесты tests.test_importer_parse_rows',
    'запускает тесты',
    'запускает скрипт Node',
  ]);
});

await test('a stream past 4 MiB is read from its end: the latest words and the count of every command', async () => {
  const pad = 'x'.repeat(100_000);
  const big = [{ type: 'thread.started', thread_id: 'big-thread' }];
  for (let n = 0; n < 45; n += 1) {
    big.push({ type: 'item.started', item: { id: `b${n}`, type: 'command_execution', command: "/bin/zsh -lc 'git log'" } });
    big.push({ type: 'item.completed', item: { id: `b${n}`, type: 'command_execution', command: "/bin/zsh -lc 'git log'", aggregated_output: pad } });
  }
  big.push({ type: 'item.completed', item: { id: 'm9', type: 'agent_message', text: 'The latest words.' } });
  const file = stream(failed, big, 0);
  assert.ok(fs.statSync(file).size > 4_194_304, 'past what $.fs.read takes');
  await E.tick();
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: The latest words.'), pane.join('\n'));
  assert.ok(pane.includes('команд выполнено: 45'), pane.join('\n'));
});

await test('a runner gone mid-round: error cue and toast once, footer asks for retry', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  rewrite(failed, () => ({ phase: 'awaiting-codex', pending: { round: 1, startedAt: new Date().toISOString() } }));
  fs.writeFileSync(path.join(home, failed, 'lock'), String(dead));
  const before = E.sounds.length;
  await E.tick();
  assert.deepEqual(E.sounds.slice(before), ['disconnected.mp3']);
  assert.ok(E.toasts.some((t) => /процесс раунда 1 пропал/.test(t)));
  await E.tick();
  assert.equal(E.sounds.length, before + 1, 'once per round');
  assert.deepEqual(await footer(E), ['[Duet ⚠️ retry]']);
});

await test("build: Codex works in a worktree outside the project, yet the hold and the note follow the project", async () => {
  // as initBuildSubject leaves it: the session's cwd is its worktree, under the session's own folder
  const worktree = path.join(home, failed, 'worktree');
  rewrite(failed, () => ({
    kind: 'build', cwd: worktree, subject: { repo, worktree, branch: 'codex-duet/x' }, phase: 'awaiting-review', round: 1, pending: null,
  }));
  await E.tick();
  await E.bash(`${RUNNER} status --session ${failed}`);
  assert.match((await E.stop()).block ?? '', /Codex закончил раунд 1\/10 и ждёт ревью: .*review/);
  assert.ok((await E.prompt('как там build?')).context, "the note reaches the owner's messages in the project");
  assert.match((await E.bash(`git -C ${worktree} commit -m x`)).deny ?? '', /идёт ревью/, 'no commits in the worktree: finish makes them');
  assert.equal((await E.bash('git commit -m x')).result, 'core reached', "the project's own checkout stays the owner's");
  assert.deepEqual(await footer(E), ['[Duet r1 🔍]']);
});

let foreign;
await test("another Claude session's review: no band, footer, toasts, sounds or hold here; the pane names it; the guard holds", async () => {
  rewrite(failed, () => ({ phase: 'finished' }));
  await E.tick();
  scriptCodex([
    turn('revise', [issue('C1', 'open')]),
    turn('revise', [issue('C1', 'open', 'high', { reply: 'Still reachable' })]),
    turn('approve', [issue('C1', 'resolved')]),
  ]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 5;\n');
  const before = [E.toasts.length, E.sounds.length, E.opened.length];
  const r = duet(['start', '--kind', 'code'], '', { CLAUDE_CODE_SESSION_ID: 'claude-other' });
  assert.equal(r.code, 0, r.err);
  foreign = sessionId(r.out);
  await E.tick();
  assert.equal(await E.render('AbovePrompt'), BELOW);
  assert.equal(await E.render('SessionMode'), BELOW);
  assert.deepEqual([E.toasts.length, E.sounds.length, E.opened.length], before, 'nothing announced here');
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.includes('ведёт другая сессия Claude')) && pane.some((l) => l.includes(foreign)), pane.join('\n'));
  await E.bash(`${RUNNER} status --session ${foreign}`);
  assert.equal((await E.stop()).block, undefined, 'not this session to keep going');
  assert.equal((await E.prompt('что там у Codex?')).context, undefined);
  assert.match((await E.bash('git commit -m x')).deny ?? '', /идёт ревью/, 'the repository is guarded from every session');
});

await test('a reply from this session takes the review over: band, footer and cues come here', async () => {
  const r = duet(['reply', '--session', foreign, '--responses', '-'], responses([{ id: 'C1', action: 'disputed', note: 'not reachable' }]));
  assert.equal(r.code, 0, r.err);
  const before = E.sounds.length;
  await E.tick();
  assert.deepEqual(E.sounds.slice(before), ['tool_approval_needed.mp3'], 'round 2 escalates, and the cue sounds here now');
  assert.match(lines(await E.render('AbovePrompt'))[0], /ждёт твоего решения: C1/);
  assert.deepEqual(await footer(E), ['[Duet 🙋 нужен ты]']);
  assert.ok(!lines(await E.render('Pane')).some((l) => l.includes('другая сессия')));
});

await test('a second Claude session sees none of it; a review from before owners shows everywhere, but an old change is not news', async () => {
  const other = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), CODEX_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, sessionId: 'claude-third' });
  await other.tick();
  assert.equal(await other.render('AbovePrompt'), BELOW);
  // no owner, last written an hour ago: a review from before 0.6.0 that a fresh session meets for the first time
  const st = JSON.parse(fs.readFileSync(stateFile(foreign), 'utf8'));
  delete st.owner;
  st.updatedAt = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(stateFile(foreign), JSON.stringify(st));
  const late = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), CODEX_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, sessionId: 'claude-fourth' });
  await late.tick();
  assert.match(lines(await late.render('AbovePrompt'))[0], /ждёт твоего решения: C1/, 'shown here, as before owners');
  assert.deepEqual([late.sounds.length, late.toasts.length], [0, 0], 'an hour-old state is history, not a cue');
  // without an owner the hold keeps its old test: this session ran the runner, and sits in the project
  const waiting = JSON.parse(fs.readFileSync(stateFile(foreign), 'utf8'));
  waiting.phase = 'awaiting-author';
  fs.writeFileSync(stateFile(foreign), JSON.stringify(waiting));
  assert.equal((await late.stop()).block, undefined, 'a session that never ran the runner is left alone');
  await late.bash(`${RUNNER} status --session ${foreign}`);
  assert.match((await late.stop()).block ?? '', new RegExp(`^codex-duet ${foreign}:`));
});

await test('the commit guard covers every running review, not only the one this session shows', async () => {
  // the build from before runs again, now driven by another Claude session; this one shows its own review
  rewrite(failed, () => ({ phase: 'awaiting-review', owner: 'claude-other' }));
  await E.tick();
  assert.notEqual(lines(await E.render('Pane'))[1]?.startsWith(failed), true, 'not the review on screen');
  const worktree = path.join(home, failed, 'worktree');
  assert.match((await E.bash(`git -C ${worktree} commit -m x`)).deny ?? '', /идёт ревью/);
});

// ---- several tasks of one Claude session: the list, the queue, cues per task
// Sessions written by hand, as the runner would leave them; ids from the future sort as the newest.
const craft = (sid, fields) => {
  const base = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
  fs.mkdirSync(path.join(home, sid), { recursive: true });
  fs.writeFileSync(stateFile(sid), JSON.stringify({
    ...base, id: sid, owner: 'claude-me', issues: {}, rounds: [], decision: null, updatedAt: new Date().toISOString(), ...fields,
  }));
};
const buildOf = (branch) => ({
  kind: 'build', cwd: path.join(home, `wt-${branch}`),
  subject: { repo, worktree: path.join(home, `wt-${branch}`), branch: `codex-duet/${branch}` },
});
const T = { one: '20991231-000001-aaaa', two: '20991231-000002-bbbb', three: '20991231-000003-cccc' };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

await test('several tasks: the pane lists them, a row opens its details, footer and status line sum them up', async () => {
  const codexModel = { model: 'gpt-6.1-sol', effort: 'max', fromConfig: ['model', 'effort'] };
  craft(T.one, { ...buildOf('task-one'), phase: 'awaiting-codex', round: 0, pending: { round: 1, startedAt: ago(65_000), codexModel } });
  craft(T.two, { ...buildOf('task-two'), phase: 'queued', round: 0, pending: { round: 1, queuedAt: ago(30_000) } });
  craft(T.three, { ...buildOf('task-three'), phase: 'escalated', round: 2, decision: { action: 'escalate', reason: 'r', issues: ['C1'] } });
  for (const sid of [T.one, T.two]) fs.writeFileSync(path.join(home, sid, 'lock'), String(process.pid));
  await E.tick();
  const rows = lines(await E.render('Pane'));
  assert.ok(rows.some((l) => /^Задачи · идут 1 · в очереди 1 · всего \d+$/.test(l)), rows.join('\n'));
  assert.ok(rows.some((l) => /⏳ task-one · раунд 1\/10 · 1:0\d · gpt-6\.1-sol\/max\]$/.test(l)), rows.join('\n'));
  assert.ok(rows.some((l) => l.includes('⏸ task-two · в очереди: 1-я')));
  assert.ok(rows.some((l) => l.includes('🙋 task-three · нужно твоё решение: C1')));
  assert.ok(E.toasts.some((t) => t === 'task-two: раунд 1 ждёт в очереди к Codex'), E.toasts.slice(-5).join('\n'));
  await E.press(await E.render('Pane'), `task-${T.two}`);
  const detail = lines(await E.render('Pane'));
  assert.ok(detail.some((l) => l.startsWith(`${T.two} · `)) && detail.some((l) => l.startsWith('⏸ ждёт свободного Codex, в очереди 1-я')), detail.join('\n'));
  assert.match((await footer(E))[0], /^\[Duet ×\d+ ⏳1 ⏸1 🙋\]$/);
  assert.equal(E.statuses.at(-1), 'codex-duet: идут 1 · в очереди 1');
  assert.match(lines(await E.render('AbovePrompt'))[0], / · ещё задач: \d+$/);
});

await test('cues per task: each toast names its task, and one read sounds once, the decision first', async () => {
  const before = { sounds: E.sounds.length, toasts: E.toasts.length };
  craft(T.one, { ...buildOf('task-one'), phase: 'escalated', round: 1, decision: { action: 'escalate', reason: 'r', issues: ['C2'] } });
  craft(T.three, { ...buildOf('task-three'), phase: 'done', round: 3 });
  await E.tick();
  const toasts = E.toasts.slice(before.toasts);
  assert.ok(toasts.includes('task-one: codex-duet: нужно твоё решение — C2. Панель: /duet'), toasts.join('\n'));
  assert.ok(toasts.includes('task-three: codex-duet: ревью завершено за 3 раунда ✓'), toasts.join('\n'));
  assert.deepEqual(E.sounds.slice(before.sounds), ['tool_approval_needed.mp3'], 'two cues raised, one played: the decision');
});

await test('the Stop hold names every task that waits on Claude', async () => {
  craft(T.one, { ...buildOf('task-one'), phase: 'awaiting-review', round: 1 });
  craft(T.two, { ...buildOf('task-two'), phase: 'awaiting-review', round: 1 });
  await E.tick();
  await E.bash(`${RUNNER} status --session ${T.one}`);
  const block = (await E.stop()).block ?? '';
  assert.match(block, /^codex-duet: твоего хода ждут \d+ сессии — /);
  assert.match(block, /task-one: ревью раунда 1\/10/);
  assert.match(block, /task-two: ревью раунда 1\/10/);
});

await test('an audit: the list names it by its task; done, the pane shows its result and findings and no score', async () => {
  const sid = '20991231-000004-dddd';
  const auditOf = { kind: 'audit', cwd: repo, maxRounds: 1, subject: { task: path.join(home, sid, 'task.md'), title: 'Audit the ledger rechecks' } };
  craft(sid, { ...auditOf, phase: 'awaiting-codex', round: 0, pending: { round: 1, startedAt: ago(20_000) } });
  fs.writeFileSync(path.join(home, sid, 'lock'), String(process.pid));
  await E.tick();
  assert.ok(lines(await E.render('Pane')).some((l) => l.includes('⏳ Audit the ledger rechecks · раунд 1/1 · 0:2')));
  await E.press(await E.render('Pane'), `task-${sid}`);
  let pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.startsWith('⏳ Codex проводит аудит · 0:2')), pane.join('\n'));
  const before = E.toasts.length;
  craft(sid, {
    ...auditOf, phase: 'done', round: 1,
    findings: [
      { id: 'A1', severity: 'high', title: 'Stale outcome survives a recheck', location: 'ledger.py:38-44' },
      { id: 'A2', severity: 'low', title: 'Errored tickets vanish', location: '' },
    ],
    audit: { summary: 'Two stale outcomes.', coverage: 'Read ledger.py.', notes: '' },
    rounds: [{ n: 1, verdict: null, startedAt: ago(20_000), finishedAt: ago(0), open: 2, parked: 0 }],
    decision: { action: 'done', reason: 'audit finished, findings: 2', issues: [] },
  });
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.includes('✅ аудит · Audit the ledger rechecks · находок 2')), pane.join('\n'));
  assert.ok(pane.includes('Итог: Two stale outcomes.') && pane.includes('Находки · 2'), pane.join('\n'));
  const at = pane.findIndex((l) => /^● A1 +high/.test(l));
  assert.equal(pane[at + 1], 'Stale outcome survives a recheck — ledger.py:38-44', pane.join('\n'));
  assert.ok(!pane.includes('Табло') && !pane.some((l) => l.startsWith('Замечания')), 'nothing to negotiate or score');
  assert.ok(E.toasts.slice(before).some((t) => t.endsWith('codex-duet: аудит готов, находок 2 ✓')), E.toasts.slice(before).join('\n'));
});

// Language choices use their own session folders so the owner's shell locale and the preceding reviews
// cannot decide what these engines display. The text written by Codex and the policy remains untouched.
const LANGUAGE_TEXT = {
  en: {
    empty: /No codex-duet sessions found\./,
    pane: /Issues/,
    band: /Claude’s turn: 2 issues/,
    toast: /round 1/,
    footer: /Duet 🙋 your decision/,
    context: /Active review session/,
    hold: /round 1\/10 is complete, 2 open/,
    deny: /a review is in progress/,
    decisions: /my decisions/,
    codex: /Codex is right/,
    ownerMarker: /Owner decision: fix/,
  },
  ru: {
    empty: /Сессий codex-duet не найдено\./,
    pane: /Замечания/,
    band: /ход Claude/,
    toast: /раунд 1/,
    footer: /нужен ты/,
    context: /Активная сессия ревью/,
    hold: /раунд 1\/10 закончен/,
    deny: /идёт ревью/,
    decisions: /мои решения/,
    codex: /прав Codex/,
    ownerMarker: /Решение владельца: исправить/,
  },
  zh: {
    empty: /未找到 codex-duet 会话。/,
    pane: /问题 · 2 个未解决/,
    band: /轮到 Claude：2 个问题/,
    toast: /第 1 轮/,
    footer: /Duet 🙋 等你决定/,
    context: /活跃审查会话/,
    hold: /第 1\/10 轮已完成，还有 2 个未解决问题/,
    deny: /正在进行审查/,
    decisions: /我对争议问题的决定/,
    codex: /Codex 是对的/,
    ownerMarker: /所有者决定：修复/,
  },
};
let languageFixture = 0;
async function languageEngine(options, localeEnv = {}, defaultsResult) {
  const stateHome = path.join(tmp, `language-${++languageFixture}`);
  fs.mkdirSync(stateHome);
  const engine = await boot(compiled, {
    options, defaultsResult, cwd: repo,
    env: { HOME: os.homedir(), CODEX_DUET_HOME: stateHome, CODEX_HOME: baseEnv.CODEX_HOME, ...localeEnv },
  });
  const sid = '20991231-123456-abcd';
  const write = (fields = {}) => {
    fs.mkdirSync(path.join(stateHome, sid), { recursive: true });
    fs.writeFileSync(path.join(stateHome, sid, 'state.json'), JSON.stringify({
      id: sid, kind: 'code', cwd: repo, owner: 'claude-me', subject: { mode: 'diff' },
      round: 1, maxRounds: 10, phase: 'awaiting-author', updatedAt: new Date().toISOString(),
      rounds: [{ n: 1, verdict: 'revise', startedAt: ago(10_000), finishedAt: ago(0), open: 2, parked: 0 }],
      codex: { model: null, effort: null },
      issues: { C1: { ...issue('C1', 'open'), disputes: 1 }, C2: { ...issue('C2', 'open', 'medium'), disputes: 0 } },
      decision: { action: 'continue', reason: 'Open issues remain', issues: [] },
      ...fields,
    }));
  };
  return { engine, sid, write };
}

for (const [language, missing, other] of [
  ['en', 'quote missing', 'quote in another file'],
  ['ru', 'цитата не найдена', 'цитата в другом файле'],
  ['zh', '未找到引文', '引文在其他文件中'],
]) {
  await test(`${language}: the board marks only open MISSING and other_file citations`, async () => {
    const { engine, write } = await languageEngine({ language });
    const citations = ['MISSING', 'other_file:elsewhere.js', 'ok', 'moved:88', 'unchecked', null, 'MISSING', 'other_file:elsewhere.js', 'ok'];
    write({ issues: Object.fromEntries(citations.map((mark, n) => {
      const iid = `C${n + 1}`;
      return [iid, { ...issue(iid, n === 7 ? 'withdrawn' : n >= 6 ? 'resolved' : 'open'), ...(mark ? { quoteCheck: { mark, round: 1 } } : {}) }];
    })) });
    await engine.tick();
    await engine.press(await engine.render('Pane'), 'fold-closed');
    const pane = lines(await engine.render('Pane'));
    assert.ok(pane.includes(`Issue C1 · ${missing}`), pane.join('\n'));
    assert.ok(pane.includes(`Issue C2 · ${other}`), pane.join('\n'));
    for (const iid of ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']) assert.ok(pane.includes(`Issue ${iid}`), pane.join('\n'));
    assert.equal(pane.filter((line) => line.includes(missing) || line.includes(other)).length, 2);
  });
}

for (const [language, done, labels, skipped, failed, gaps] of [
  ['en', '✅ done · verification: ', ['executed', 'partial', 'static-analysis-only', 'unknown'], 'skipped', 'failed', 'Not examined fully: '],
  ['ru', '✅ готово · проверка: ', ['выполнена', 'частичная', 'только статический анализ', 'неизвестно'], 'пропущено', 'упало', 'Проверено не полностью: '],
  ['zh', '✅ 已完成 · 验证：', ['已执行', '部分执行', '仅静态分析', '未知'], '已跳过', '失败', '未完整检查：'],
]) {
  await test(`${language}: DONE in pane and band carries the last Codex verification, including after post-approval`, async () => {
    const { engine, write } = await languageEngine({ language });
    for (const [i, label] of ['executed', 'partial', 'static-analysis-only', 'unknown'].entries()) {
      const receipt = {
        label,
        checks: label === 'executed' ? [{ command: 'node --test', outcome: 'passed', note: '', confirmation: 'confirmed' }] : [
          { command: 'npm run integration', outcome: 'skipped', note: 'Missing credentials', confirmation: 'skipped' },
          ...(label === 'partial' ? [{ command: 'node repro.mjs', outcome: 'failed', note: 'Reproduced crash', confirmation: 'confirmed', event: { exit_code: 1, status: 'failed' } }] : []),
        ],
        gaps: label === 'executed' ? [] : ['Browser path not inspected'],
      };
      write({
        ...buildOf('receipt'), phase: 'done', round: 2,
        rounds: [
          { n: 1, verdict: 'approve', ...(label === 'unknown' ? {} : { verification: receipt }) },
          { n: 2, kind: 'post-approval', verdict: 'approve' },
        ],
        decision: { action: 'done', reason: 'Approved', issues: [] }, issues: {},
      });
      await engine.tick();
      const pane = lines(await engine.render('Pane'));
      const band = lines(await engine.render('AbovePrompt'));
      assert.ok(pane.includes(`${done}${labels[i]}`), pane.join('\n'));
      assert.ok(band[0].includes(`${done}${labels[i]}`), band.join('\n'));
      if (label === 'partial' || label === 'static-analysis-only') {
        assert.ok(pane.some((line) => line.includes(`${skipped}: npm run integration — Missing credentials`)), pane.join('\n'));
        if (label === 'partial') assert.ok(pane.some((line) => line.includes(`${failed}: node repro.mjs (exit 1) — Reproduced crash`)), pane.join('\n'));
        assert.ok(pane.includes(`${gaps}Browser path not inspected`), pane.join('\n'));
      }
    }
    write({ phase: 'done', updatedAt: ago(11 * 60_000) });
    await engine.tick();
    assert.equal(await engine.render('AbovePrompt'), BELOW, 'an old DONE does not occupy the band');
  });
}

await test('the default option draws English with an English locale and with no locale available', async () => {
  for (const env of [{ LANG: 'en_US.UTF-8' }, {}]) {
    const { engine } = await languageEngine(undefined, env);
    const pane = lines(await engine.render('Pane')).join('\n');
    assert.match(pane, LANGUAGE_TEXT.en.empty);
    assert.doesNotMatch(pane, /[А-Яа-яЁё\u3400-\u9fff]/);
  }
});

await test('auto uses the first nonempty LC_ALL, LC_MESSAGES or LANG', async () => {
  const cases = [
    [{ LANG: 'ru_RU.UTF-8' }, 'ru'],
    [{ LANG: 'zh_CN.UTF-8' }, 'zh'],
    [{ LC_ALL: 'en_US.UTF-8', LANG: 'ru_RU.UTF-8' }, 'en'],
    [{ LC_ALL: 'ru_RU.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }, 'ru'],
    [{ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'ru_RU.UTF-8' }, 'zh'],
    [{ LC_ALL: '', LC_MESSAGES: '', LANG: 'zh_CN.UTF-8' }, 'zh'],
    [{ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, 'en'],
    [{ LANG: 'de_DE.UTF-8' }, 'en'],
  ];
  for (const [env, language] of cases) {
    const { engine } = await languageEngine({ language: 'auto' }, env);
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty, JSON.stringify(env));
  }
});

const appleLanguages = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '' });
await test('auto falls back to the first macOS preferred language when locale variables are empty', async () => {
  const cases = [
    ['(\n    "ru-CY",\n    "el-CY",\n    "en-CY"\n)\n', 'ru'],
    ['(\n    "zh-Hans-CN",\n    en\n)', 'zh'],
    ['("en-US", "ru-CY")', 'en'],
    ['(en)', 'en'],
    ['(ru, en)', 'ru'],
    ['(zh, en)', 'zh'],
    ['("el-CY", "ru-CY")', 'en'],
  ];
  for (const [stdout, language] of cases) {
    const { engine } = await languageEngine(undefined, { LC_ALL: '', LC_MESSAGES: '', LANG: '' }, appleLanguages(stdout));
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty, stdout);
    assert.deepEqual(engine.procs.filter((command) => command.startsWith('defaults')), ['defaults read -g AppleLanguages']);
  }
});

await test('unavailable, failed, empty or malformed macOS preferences fall back to English', async () => {
  const cases = [
    new Error('spawn defaults ENOENT'),
    appleLanguages('(ru)', 1),
    ...['', '()', '( )', 'ru-CY', '("ru-CY)', '("ru-CY"', '("ru-CY", ???)', '("ru-CY",)'].map((text) => appleLanguages(text)),
  ];
  for (const result of cases) {
    const { engine } = await languageEngine({ language: 'auto' }, {}, result);
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT.en.empty);
  }
});

await test('environment variables and explicit settings win without reading macOS preferences', async () => {
  const cases = [
    [undefined, { LANG: 'en_US.UTF-8' }, 'en'],
    [{ language: 'auto' }, { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, 'en'],
    [{ language: 'auto' }, { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, 'zh'],
    ...['en', 'ru', 'zh'].map((language) => [{ language }, {}, language]),
  ];
  for (const [options, env, language] of cases) {
    const { engine } = await languageEngine(options, env, appleLanguages('("ru-CY")'));
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty);
    assert.ok(!engine.procs.some((command) => command.startsWith('defaults')), JSON.stringify({ options, env }));
  }
});

for (const language of ['auto', 'en', 'ru', 'zh']) {
  await test(`${language}: pane, band, footer, toast, context, Stop hold, guard and decisions use the chosen language`, async () => {
    // An explicit option must override the locale, including an English option over a Russian locale.
    const options = language === 'auto' ? undefined : { language };
    const env = language === 'auto' ? { LANG: 'en_US.UTF-8' } : { LC_ALL: language === 'ru' ? 'zh_CN.UTF-8' : 'ru_RU.UTF-8' };
    const { engine, sid, write } = await languageEngine(options, env);
    const expected = LANGUAGE_TEXT[language === 'auto' ? 'en' : language];
    assert.match(lines(await engine.render('Pane')).join('\n'), expected.empty);
    write();
    await engine.tick();
    const pane = lines(await engine.render('Pane')).join('\n');
    const band = lines(await engine.render('AbovePrompt')).join('\n');
    assert.match(pane, expected.pane);
    assert.match(band, expected.band);
    assert.ok(engine.toasts.some((text) => expected.toast.test(text)), engine.toasts.join('\n'));
    const context = (await engine.prompt('How is the review going?')).context.join('\n');
    assert.match(context, expected.context);
    assert.ok(context.includes(`status --session ${sid}`), context);
    await engine.bash(`${RUNNER} status --session ${sid}`);
    const hold = (await engine.stop()).block ?? '';
    assert.ok(hold.startsWith(`codex-duet ${sid}:`), hold);
    assert.match(hold, expected.hold);
    const deny = (await engine.bash('git commit -m test')).deny ?? '';
    assert.match(deny, expected.deny);
    write({ phase: 'escalated', decision: { action: 'escalate', reason: 'Owner decision needed', issues: ['C1'] } });
    await engine.tick();
    const footerText = (await footer(engine)).join('\n');
    assert.match(footerText, expected.footer);
    await engine.press(await engine.render('Pane'), 'pick-codex-C1');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    const submitted = engine.submitted.at(-1);
    assert.ok(submitted.startsWith(`codex-duet ${sid}:`), submitted);
    assert.match(submitted, expected.decisions);
    assert.match(submitted, expected.codex);
    // Build reverses the roles: siding with Claude keeps the issue open with an owner ruling;
    // siding with Codex withdraws it. The structured flag stays stable in every language.
    write({
      kind: 'build', subject: { repo, worktree: repo, branch: 'codex-duet/localized' },
      phase: 'escalated', decision: { action: 'escalate', reason: 'Owner decision needed', issues: ['C1', 'C2'] },
    });
    await engine.tick();
    await engine.press(await engine.render('Pane'), 'pick-claude-C1');
    await engine.press(await engine.render('Pane'), 'pick-codex-C2');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    const buildSubmitted = engine.submitted.at(-1);
    assert.ok(buildSubmitted.startsWith(`codex-duet ${sid}:`), buildSubmitted);
    assert.match(buildSubmitted, expected.decisions);
    assert.match(buildSubmitted, expected.ownerMarker);
    assert.match(buildSubmitted, /C1:.*owner: true/);
    assert.match(buildSubmitted, /C2:.*status withdrawn, owner: true/);
    if (language === 'en' || language === 'auto') {
      const commands = await Promise.all(['', 'status', 'sound on', 'stop', 'help'].map((args) => engine.command('duet', args)));
      assert.doesNotMatch([
        pane, band, context, hold, deny, footerText, submitted, buildSubmitted, ...engine.toasts, ...engine.statuses,
        ...engine.suggested, ...commands.map((reply) => reply.text ?? ''),
      ].join('\n'), /[А-Яа-яЁё\u3400-\u9fff]/, 'all mod-authored text is English');
    }
  });
}

const localeTables = {};
await test('locale tables have exactly the English keys and matching value types', async () => {
  const tables = localeTables;
  for (const language of ['en', 'ru', 'zh']) {
    const dir = path.join(tmp, `locale-${language}`);
    fs.mkdirSync(dir);
    const file = compile(path.join(HERE, '..', 'hooks', 'locales', `${language}.ts`), dir);
    const module = await import(pathToFileURL(file).href);
    tables[language] = module[language];
    assert.equal(typeof tables[language], 'object', `${language} exports its locale table`);
  }
  const contract = (table) => Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value && typeof value === 'object' ? contract(value) : typeof value]));
  assert.deepEqual(contract(tables.ru), contract(tables.en));
  assert.deepEqual(contract(tables.zh), contract(tables.en));
});

await test('English uses singular and plural, Russian one/few/many, and Chinese unchanged nouns', async () => {
  const { en, ru, zh } = localeTables;
  for (const [n, issueWord, roundWord] of [
    [0, 'замечаний', 'раундов'], [1, 'замечание', 'раунд'], [2, 'замечания', 'раунда'],
    [5, 'замечаний', 'раундов'], [11, 'замечаний', 'раундов'], [21, 'замечание', 'раунд'],
  ]) {
    assert.ok(en.bandAuthor(1, 10, n).endsWith(`${n} ${n === 1 ? 'issue' : 'issues'}`));
    assert.equal(en.toastReviewDone('', n), `codex-duet: review complete in ${n} ${n === 1 ? 'round' : 'rounds'} ✓`);
    assert.ok(ru.bandAuthor(1, 10, n).endsWith(`${n} ${issueWord}`));
    assert.equal(ru.toastReviewDone('', n), `codex-duet: ревью завершено за ${n} ${roundWord} ✓`);
    assert.ok(zh.bandAuthor(1, 10, n).endsWith(`${n} 个问题`));
    assert.equal(zh.toastReviewDone('', n), `codex-duet: 审查完成，共 ${n} 轮 ✓`);
  }
});

await test('durations and the age of Codex messages use each language’s units and phrasing', async () => {
  const expected = {
    en: ['2s', '6 min', '1h 5m', ', 2s ago', ', over 6 min ago'],
    ru: ['2 с', '6 мин', '1ч 5м', ', 2 с назад', ', больше 6 мин назад'],
    zh: ['2 秒', '6 分钟', '1 小时 5 分钟', '，2 秒前', '，超过 6 分钟前'],
  };
  for (const language of ['en', 'ru', 'zh']) {
    const locale = localeTables[language];
    assert.deepEqual([
      locale.seconds(2), locale.minutes(6), locale.hoursMinutes(1, 5),
      locale.wordsAgo(locale.seconds(2)), locale.wordsOlder(locale.minutes(6)),
    ], expected[language]);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} mod tests passed`);

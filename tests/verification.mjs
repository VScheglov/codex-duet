// Focused receipt regressions; also run by tests/run.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmVerification, verificationClaims, verificationLines } from '../scripts/verification.mjs';

export async function matchingTests(test, dir) {
  const file = path.join(dir, 'matching.events.jsonl');
  for (const { name, claim, events, want, selected, outcome = 'passed' } of [
    { name: 'ls inside tools cannot replace a failing exact event', claim: 'pytest tests/test_tools.py',
      events: [['pytest tests/test_tools.py', 1], ['ls', 0]], want: 'contradicted', selected: 'pytest tests/test_tools.py' },
    { name: 'a bare executable cannot confirm a longer command', claim: 'node tests/check.mjs', events: [['node', 0]], want: 'unconfirmed' },
    { name: 'a read command inside an argument cannot confirm a check', claim: 'node --test "cat x.test.mjs"', events: [['cat x', 0]], want: 'unconfirmed' },
    { name: 'pwd inside a filename cannot confirm a check', claim: 'node test_pwd.mjs', events: [['pwd', 0]], want: 'unconfirmed' },
    { name: 'npm test is distinct from npm test:e2e', claim: 'npm test', events: [['npm test:e2e', 0]], want: 'unconfirmed' },
    { name: 'a complete segment after cd confirms a check', claim: 'npm test', events: [['cd pkg && npm test', 0]], want: 'confirmed' },
    { name: 'a complete segment can add arguments', claim: 'npm test', events: [['cd pkg && npm test -- --runInBand', 0]], want: 'confirmed' },
    { name: 'exact events outrank later compound matches', claim: 'npm test',
      events: [['npm test', 1], ['cd pkg && npm test', 0]], want: 'contradicted', selected: 'npm test' },
    { name: 'the last event at the best match level wins', claim: 'npm test',
      events: [['npm test', 0], ['npm test', 1], ['cd pkg && npm test', 0]], want: 'contradicted', selected: 'npm test' },
    { name: 'the last segment match wins when no exact event exists', claim: 'npm test',
      events: [['cd first && npm test', 1], ['cd second && npm test', 0]], want: 'confirmed', selected: 'cd second && npm test' },
    { name: 'a partial compound claim is unconfirmed', claim: 'npm test && npm run lint', events: [['npm test', 0]], want: 'unconfirmed' },
    { name: 'every segment of a compound claim must run', claim: 'npm test && npm run lint',
      events: [['npm test', 0], ['npm run lint', 0]], want: 'confirmed' },
    { name: 'a compound claim with a failed component contradicts passed', claim: 'npm test && npm run lint',
      events: [['npm test', 0], ['npm run lint', 1]], want: 'contradicted' },
    { name: 'a failed compound claim retains all its evidence', claim: 'npm test && npm run lint', outcome: 'failed',
      events: [['npm test', 0], ['npm run lint', 1]], want: 'confirmed' },
    { name: 'one event cannot stand for two repeated compound segments', claim: 'npm test && npm test', events: [['npm test', 0]], want: 'unconfirmed' },
    { name: 'operators inside quoted arguments are not segments', claim: 'npm test', events: [["printf '%s' 'npm test && pwd'", 0]], want: 'unconfirmed' },
    { name: 'a command substitution is not a top-level segment', claim: 'npm test', events: [['printf "%s" "$(npm test)"', 0]], want: 'unconfirmed' },
    { name: 'newlines separate commands rather than arguments', claim: 'npm test pwd', events: [['npm test\npwd', 0]], want: 'unconfirmed' },
    { name: 'a pipe hides the test segment exit', claim: 'pytest -q', events: [['pytest -q | tail -5', 0]], want: 'unconfirmed' },
    { name: 'OR true hides the test segment exit', claim: 'npm test', events: [['npm test || true', 0]], want: 'unconfirmed' },
    { name: 'a later echo hides the lint segment exit', claim: 'make lint', events: [['make lint; echo done', 0]], want: 'unconfirmed' },
    { name: 'backgrounding hides an AND chain failure', claim: 'npm test', events: [['npm test && false & true', 0]], want: 'unconfirmed' },
    { name: 'a successful AND chain proves its final test passed', claim: 'go test ./...', events: [['cd pkg && go test ./...', 0]], want: 'confirmed' },
    { name: 'a final sequence segment can contradict a passed claim', claim: 'npm test', events: [['a; npm test', 1]], want: 'contradicted' },
    { name: 'a final sequence segment can confirm a failed claim', claim: 'npm test', outcome: 'failed', events: [['a; npm test', 1]], want: 'confirmed' },
    { name: 'an AND failure does not show whether the final test ran', claim: 'npm test', events: [['cd pkg && npm test', 1]], want: 'unconfirmed' },
    { name: 'an AND failure cannot confirm the final test failed', claim: 'npm test', outcome: 'failed', events: [['cd pkg && npm test', 1]], want: 'unconfirmed' },
    { name: 'an AND success proves an earlier test passed', claim: 'npm test', events: [['npm test && echo done', 0]], want: 'confirmed' },
    { name: 'an AND failure cannot identify an earlier failed segment', claim: 'npm test', outcome: 'failed', events: [['npm test && echo done', 1]], want: 'unconfirmed' },
    { name: 'an earlier newline segment has no exit evidence', claim: 'npm test', events: [['npm test\npwd', 0]], want: 'unconfirmed' },
    { name: 'a final newline segment can confirm failure', claim: 'npm test', outcome: 'failed', events: [['pwd\nnpm test', 1]], want: 'confirmed' },
    { name: 'a mixed sequence with AND can skip its final test on failure', claim: 'npm test', outcome: 'failed', events: [['a; cd pkg && npm test', 1]], want: 'unconfirmed' },
    { name: 'a mixed sequence with AND proves its final test on success', claim: 'npm test', events: [['a; cd pkg && npm test', 0]], want: 'confirmed' },
    { name: 'a safe earlier segment event cannot prove a later masked attempt', claim: 'npm test', events: [['cd pkg && npm test', 0], ['npm test || true', 0]], want: 'unconfirmed' },
    { name: 'an exact OR claim cannot prove verification passed', claim: 'npm test || true', events: [['npm test || true', 0]], want: 'unconfirmed' },
    { name: 'an exact pipeline cannot prove verification passed', claim: 'pytest -q | tail -5', events: [['pytest -q | tail -5', 0]], want: 'unconfirmed' },
    { name: 'an exact sequence success can hide an earlier failure', claim: 'make lint; echo done', events: [['make lint; echo done', 0]], want: 'unconfirmed' },
    { name: 'an exact AND success proves verification passed', claim: 'a && b', events: [['a && b', 0]], want: 'confirmed' },
    { name: 'an exact AND failure proves verification failed', claim: 'a && b', outcome: 'failed', events: [['a && b', 1]], want: 'confirmed' },
    { name: 'an exact sequence failure proves verification failed', claim: 'a; b', outcome: 'failed', events: [['a; b', 1]], want: 'confirmed' },
    { name: 'an exact sequence failure contradicts passed', claim: 'a; b', events: [['a; b', 1]], want: 'contradicted' },
    { name: 'an exact sequence success does not contradict a failed check', claim: 'a; b', outcome: 'failed', events: [['a; b', 0]], want: 'unconfirmed' },
    { name: 'an exact newline sequence success can hide failure', claim: 'a\nb', events: [['a\nb', 0]], want: 'unconfirmed' },
    { name: 'an exact newline sequence failure proves failure', claim: 'a\nb', outcome: 'failed', events: [['a\nb', 1]], want: 'confirmed' },
    { name: 'descriptor redirects keep the command exit', claim: 'node x 2>&1', events: [['node x 2>&1', 1]], want: 'contradicted' },
    { name: 'file redirects keep the command exit', claim: 'node x > log', events: [['node x > log', 0]], want: 'confirmed' },
    { name: 'redirects in an AND chain preserve its failure', claim: 'node x 2>&1 && node y > log', outcome: 'failed', events: [['node x 2>&1 && node y > log', 1]], want: 'confirmed' },
    { name: 'an exact pipeline failure has no verification evidence', claim: 'pytest -q | tail -5', outcome: 'failed', events: [['pytest -q | tail -5', 1]], want: 'unconfirmed' },
    { name: 'an exact OR failure has no verification evidence', claim: 'npm test || true', outcome: 'failed', events: [['npm test || true', 1]], want: 'unconfirmed' },
    { name: 'an exact background list cannot prove passed', claim: 'npm test & true', events: [['npm test & true', 0]], want: 'unconfirmed' },
    { name: 'an exact backgrounded AND chain cannot prove passed', claim: 'npm test && false & true', events: [['npm test && false & true', 0]], want: 'unconfirmed' },
    { name: 'an exact grouped mask cannot prove passed', claim: '(npm test || true)', events: [['(npm test || true)', 0]], want: 'unconfirmed' },
    { name: 'an opaque exact command cannot bypass masking rules', claim: 'npm test || true # note', events: [['npm test || true # note', 0]], want: 'unconfirmed' },
    { name: 'quoted pipes in arguments keep the single command exit', claim: "node x --name 'a|b'", events: [["node x --name 'a|b'", 0]], want: 'confirmed' },
    { name: 'an exact failed compound event keeps its complete command exit', claim: 'cd pkg && npm test', events: [['cd pkg && npm test', 1]], want: 'contradicted' },
    // a here-document body is the program's data, not shell: the exit is the program's
    ...(() => {
      const script = "python3 - <<'PY'\nimport sys\n# a comment, not shell: || true\nsys.exit(0)\nPY";
      return [
        { name: 'a script fed on a here-document is confirmed by its exit', claim: script, events: [[script, 0]], want: 'confirmed' },
        { name: 'a failing here-document script contradicts passed', claim: script, events: [[script, 1]], want: 'contradicted' },
        { name: 'another script with the same first line cannot confirm a check', claim: script,
          events: [["python3 - <<'PY'\nprint('other')\nPY", 0]], want: 'unconfirmed' },
        { name: 'a pipe after a here-document hides its exit', claim: "python3 - <<'PY' | tail -1\nprint(1)\nPY",
          events: [["python3 - <<'PY' | tail -1\nprint(1)\nPY", 0]], want: 'unconfirmed' },
        { name: 'a command after a here-document hides its exit', claim: `${script}\necho done`, events: [[`${script}\necho done`, 0]], want: 'unconfirmed' },
        { name: 'a shell fed a here-document runs its body as commands', claim: "bash <<'EOF'\nnpm test || true\nEOF",
          events: [["bash <<'EOF'\nnpm test || true\nEOF", 0]], want: 'unconfirmed' },
        { name: 'an unquoted here-document runs substitutions out of the exit\'s sight', claim: "python3 - <<PY\nprint('$(npm test || true)')\nPY",
          events: [["python3 - <<PY\nprint('$(npm test || true)')\nPY", 0]], want: 'unconfirmed' },
        { name: 'an unterminated here-document proves nothing', claim: "python3 - <<'PY'\nprint(1)", events: [["python3 - <<'PY'\nprint(1)", 0]], want: 'unconfirmed' },
        { name: 'a here-document with <<- may indent its delimiter with tabs', claim: "node - <<-'JS'\n\tconsole.log(1)\n\tJS",
          events: [["node - <<-'JS'\n\tconsole.log(1)\n\tJS", 0]], want: 'confirmed' },
        { name: 'a here-string keeps the command exit', claim: "python3 - <<< 'print(1)'", events: [["python3 - <<< 'print(1)'", 0]], want: 'confirmed' },
      ];
    })(),
    ...[['||', 'unconfirmed'], [';', 'confirmed'], ['|', 'unconfirmed'], ['\n', 'confirmed']].map(([op, want]) => ({
      name: `exit evidence for a final segment after ${JSON.stringify(op)}`, claim: 'npm test', events: [[`false ${op} npm test`, 0]], want })),
    { name: 'separate OR components do not bypass masking rules', claim: 'npm test || npm run lint',
      events: [['npm test', 1], ['npm run lint', 0]], want: 'unconfirmed' },
    { name: 'a sequence final success does not hide a separate failed check', claim: 'npm test; npm run lint',
      events: [['npm test', 1], ['npm run lint', 0]], want: 'unconfirmed' },
    { name: 'separate pipeline components cannot bypass masking rules', claim: 'npm test | npm run lint',
      events: [['npm test', 1], ['npm run lint', 0]], want: 'unconfirmed' },
  ]) {
    await test(`verification matching: ${name}`, async () => {
      fs.writeFileSync(file, events.map(([command, exit_code]) => JSON.stringify({
        type: 'item.completed', item: { type: 'command_execution',
          command: `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`, exit_code, status: exit_code ? 'failed' : 'completed' },
      })).join('\n'));
      const receipt = await confirmVerification({ checks: [{ command: claim, outcome, note: '' }], gaps: [] }, file);
      const check = receipt.checks[0];
      assert.equal(check.confirmation, want);
      assert.equal(receipt.label, want === 'confirmed' ? 'executed' : 'static-analysis-only');
      if (selected) assert.equal(check.event.command, selected);
      if (claim.includes(' && ') && events.length > 1 && want !== 'unconfirmed') assert.equal(check.events.length, events.length);
      if (check.events) for (const [command, exit] of events) {
        assert.ok(verificationLines(receipt).some((line) => line.includes(`${command}: exit ${exit}`)));
      }
    });
  }
  await test('verification matching: a here-document script in the double-quoted wrapper Codex logs is confirmed', async () => {
    // Codex logs `/bin/zsh -lc "python3 - <<'PY' … PY"`; the check names the script as written.
    const script = "python3 - <<'PY'\nfrom pathlib import Path\nassert Path('a.txt').read_text() == \"x\", 'differs'\nprint('PASS')\nPY";
    fs.writeFileSync(file, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
      command: `/bin/zsh -lc "${script.replace(/["\\$`]/g, '\\$&')}"`, exit_code: 0, status: 'completed' } }));
    const receipt = await confirmVerification({ checks: [{ command: script, outcome: 'passed', note: '' }], gaps: [] }, file);
    assert.equal(receipt.checks[0].confirmation, 'confirmed');
    assert.equal(receipt.label, 'executed');
  });
}

export async function normalizationTests(test, dir) {
  await test('verification normalization: malformed receipts keep valid checks and expose the missing coverage', async () => {
    const file = path.join(dir, 'normalization.events.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', command: 'node --test', exit_code: 0, status: 'completed',
    } }));
    const valid = { command: 'node --test', outcome: 'passed', note: '' };
    for (const [raw, label, count] of [
      [{ checks: [valid, { command: 'npm test', outcome: 'passed' }, null], gaps: 'not an array' }, 'partial', 1],
      [{ checks: 'not an array', gaps: [] }, 'static-analysis-only', 0],
      [{ checks: [valid], gaps: ['Browser path not examined', 1, null] }, 'partial', 1],
      [{ checks: [{ command: 1, outcome: 'passed', note: '' }], gaps: [] }, 'static-analysis-only', 0],
    ]) {
      let claims;
      assert.doesNotThrow(() => { claims = verificationClaims(raw); });
      const receipt = await confirmVerification(claims, file);
      assert.equal(receipt.label, label);
      assert.equal(receipt.checks.length, count);
      assert.ok(receipt.gaps.some((gap) => /malformed/i.test(gap)), receipt.gaps.join('\n'));
      if (count) assert.equal(receipt.checks[0].confirmation, 'confirmed');
      if (Array.isArray(raw.gaps) && raw.gaps.includes('Browser path not examined')) {
        assert.ok(receipt.gaps.includes('Browser path not examined'));
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-verification-'));
  let passed = 0;
  try {
    const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };
    await matchingTests(test, dir);
    await normalizationTests(test, dir);
    console.log(`\n${passed} verification tests passed`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

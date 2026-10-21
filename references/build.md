# Build mode: Codex implements, Claude reviews

The point of build mode is the budget: Codex explores, writes and tests; Claude spends tokens on the specification and on reading diffs. Every habit below serves that.

## The specification

Codex sees the specification and the repository, never the conversation. Write it so a strong engineer new to the task could execute it:

```markdown
# <Title: becomes the commit subject>

## Goal
What should exist when this is done, and why.

## Scope
- In: modules, files, endpoints involved.
- Out: what must not change.

## Constraints
Conventions to follow, dependencies not to add, compatibility to keep.

## Acceptance criteria
- Observable checks: commands, inputs and expected outputs, behaviors.

## How to test
The commands that prove it (unit tests, a script, a curl).
```

Pass it on stdin: `start --kind build --subject - <<'DUET_SPEC'` … `DUET_SPEC`. The worktree lives in the session folder, on branch `codex-duet/<id>` (or `--branch`), started from HEAD (or `--base`).

## Reviewing on a budget

1. Read the summary: what Codex claims, which tests it ran, its questions.
2. Read the round diff in the summary. Past the size limit it is truncated; inspect the rest per file with the `git -C … diff … -- <path>` command shown above it.
3. Open a whole file only when the diff cannot be judged without its context.
4. Run the acceptance tests in the worktree yourself: `cd <worktree> && <test command>`. Command output costs little and checks Codex's claims.
5. Raise only material issues (wrong, unsafe, fragile, untested, off-spec), each with a concrete fix. Do not rewrite style.

## Review JSON

```bash
node "<base>/scripts/duet.mjs" review --session <id> --issues - <<'DUET_JSON'
{"verdict": "revise", "summary": "Parser works; the empty-input path crashes and is untested.",
 "issues": [
  {"id": "C1", "status": "open", "severity": "high", "title": "parse('') throws TypeError",
   "body": "parse.js:12 indexes the first token without a length check; node -e \"require('./parse')('')\" throws.",
   "location": "parse.js:12", "recommendation": "Return [] for empty input and add a test.",
   "confidence": 0.9, "reply": "", "owner": false},
  {"id": "C2", "status": "resolved", "severity": "medium", "title": "Missing README section",
   "body": "", "location": "", "recommendation": "", "confidence": 0.9, "reply": "Verified.", "owner": false}
 ]}
DUET_JSON
```

- `verdict`: `approve` when nothing is left that should block the merge, otherwise `revise`.
- Ids are permanent: new issues take the next free number; never reuse one.
- For an issue Codex answered: `resolved` (the fix holds; check it), `withdrawn` (its dispute convinces you), or `open` with `reply` saying exactly what is still wrong. Do not repeat yourself: bring new evidence or withdraw.
- Issues Codex parked (`needs-user`) stay open until the user decides.

## Owner rulings

When a deadlock or a parked issue goes to the user, relay the decision in the next review with `"owner": true` on that issue:

- the user sides with Codex: `"status": "withdrawn", "owner": true, "reply": "Owner decision: leave it as is"`;
- the user sides with Claude: `"status": "open", "owner": true, "reply": "Owner decision: make this change"`. Codex sees it as final and must comply.

Write the reply in the user's language: “Owner decision”, “Решение владельца”, or “所有者决定” are equivalent introductions. The structured `owner` flag is authoritative regardless of wording; the runner marks the ruling `Owner decision (final)` when passing it to Codex.

An owner ruling resets the issue's dispute count, and the runner gives Codex a turn to act on it even when the stall rule would stop the loop.

## Finish or discard

After `DONE` (or whenever the user decides to stop), present the result and ask:

- `finish --session <id>` commits the worktree on its branch with the spec title as the subject and removes the worktree; the summary prints how to look at, merge or drop the branch.
- `discard --session <id>` removes the worktree and deletes the branch.

Both change the user's repository: run them only after the user agrees.

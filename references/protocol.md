# Negotiation protocol (author side)

## Response JSON

Send it to `reply --responses -` through a quoted heredoc, so the shell leaves the text alone:

```bash
node "<base>/scripts/duet.mjs" reply --session <id> --responses - <<'DUET_JSON'
{
  "changes": "Guarded empty input in parse(); kept the retry loop as is.",
  "responses": [
    {"id": "C1", "action": "fixed", "note": "parse() returns [] for empty input: src/parse.js:41-47, test added in parse.test.js:88."},
    {"id": "C2", "action": "disputed", "note": "The retry is bounded: MAX_RETRIES = 3 (src/net.js:12) and the caller times out after 5 s (src/api.js:88). An unbounded loop is not reachable."},
    {"id": "C3", "action": "needs-user", "note": "Codex wants soft delete; the user explicitly asked for hard delete. This is a product decision."}
  ]
}
DUET_JSON
```

- Answer every open issue exactly once; the script rejects a reply that skips one. Parked issues need no answer until the user decides.
- `note` is mandatory and is what Codex sees. Make it verifiable: paths with lines, commands with their key output, quotes of requirements.
- Write notes in the language of the issue text.

Issues whose titles start with `Request: ` identify something dropped, narrowed or contradicted from the owner's request, accepted amendments or claimed result. Answer them like any other issue: fix, dispute with evidence, or park for the owner. A dispute must quote the owner's words (and the accepted amendment with its source when relevant) to show why the requirement is still met; the author's narrower specification alone is not evidence. Codex re-assesses `request_check` each round. Without an owner request ruling, a latest check of `narrowed` prevents `DONE` and escalates even if the reviewer otherwise approves; `unclear` is shown but does not itself block `DONE`.

The summary's `Verification:` receipt confirms Codex's claimed checks against the round's saved command events and lists failures, skips with reasons, unconfirmed or contradicted claims, and gaps. `executed` means all checks confirmed with no skips or gaps (including confirmed failures); `partial` means some confirmed with incomplete coverage; `static-analysis-only` means none confirmed; older replies are `unknown`. The label appears beside DONE, in `report.md` and in `/duet`; it never changes the stop decision. Present it to the owner, and explain the limits whenever it is not `executed`.

## Quote checks

Each issue has a separate `path`, `line` and `quote`. Before recording a review, the runner checks new or changed citations on open issues against that round's immutable snapshot: the tree object for code/build, or saved subject-file copies for plan/file. Plan/file paths may be as listed, relative to the session cwd, or absolute; an empty path selects the only subject file. It searches up to three longest distinct trimmed quote lines of at least 12 characters, falling back to the whole trimmed quote at 6 characters. A leading diff marker is stripped once if the original needle is not found.

| Mark | Meaning |
|---|---|
| `ok` | A needle occurs in the cited file within 3 lines of `line`, or anywhere when `line` is 0. |
| `moved:<L>` | A needle occurs in the cited file farther away; L is the first hit. |
| `other_file:<F>` | No needle occurs in the cited file, but one occurs in snapshot file F. |
| `MISSING` | No needle occurs anywhere in the readable snapshot. |
| `unchecked` | No quote, no usable path or needle, an unreadable snapshot/file, or a binary cited file. |

Summaries and author prompts show moved, other-file and missing citations; subsequent reviewer prompts also show `unchecked`. The report keeps every mark and its round; the pane flags missing and other-file citations only on open issues. An existing open issue is checked again only when it carries a nonempty quote and its quote or path changes; changing only the line does not trigger a check. Replies that resolve or withdraw an issue, and replies with unchanged or absent quotes, keep the earlier citation and check. This preserves evidence of the original problem after a fix removes the quoted code. Older issues without a check remain unchecked until re-cited while open.

`MISSING` is a reason to ask Codex to re-cite, not proof that the issue is wrong. Inspect the evidence before using a mark in a dispute. A mark never resolves, withdraws or parks an issue and never changes the stop decision; every open issue still needs an answer.

## Actions

| action | meaning | what Codex does next |
|---|---|---|
| `fixed` | the change is already on disk | verifies: `resolved`, or keeps it open and says what is still wrong |
| `disputed` | the issue does not hold or is not worth fixing | withdraws it, or answers with new evidence |
| `needs-user` | the decision belongs to the user | keeps it parked; the loop goes on without it |
| `owner-decided` | the user ruled in favor of the current version | must withdraw; the script enforces it |

## Fix, dispute or park

**Fix** when the issue is correct and the fix stays within the task. When only part of an issue is right, fix that part and say in the note why the rest is not needed; Codex keeps the issue open if that is not enough.

**Dispute** only with evidence, when one of these holds:
- the claim is factually wrong: show the code, a command and its output, or documentation;
- it contradicts an explicit requirement of the user: quote the requirement;
- the fix costs more than the risk it removes (medium or low severity only): name the trade-off;
- it is outside the task's scope: name the scope.

**Park** (`needs-user`) when the call belongs to the user: a product or business choice, a real risk against an explicit requirement, a fix that needs access or data Claude lacks, or a fix that would widen the scope substantially.

Concede as soon as Codex brings evidence that was not considered: fix and answer `fixed`. Do not repeat an argument Codex has already answered. With nothing new to add, either fix the issue or park it. Never dispute just to finish faster.

## Writing a dispute

1. The claim, in one sentence.
2. The evidence: `path:line`, a command plus its key output, a quote.
3. What would change the author's mind.

## Escalation for the user

Use the user's language. For each issue:

**C3 [high] Soft or hard delete** (`src/users/delete.ts:40`)
- Codex: …one or two sentences…
- Claude: …one or two sentences…
- Decide: …the concrete question…

Recommend an option when one is clearly better, and say why.

For a request-check escalation, present the reviewer's notes and the decision needed even when there are no issue IDs. If the owner accepts the narrower result or clarifies that the request is met, relay their decision in a structured field:

```json
{"changes": "Owner settled the scope.", "request_ruling": "The owner accepts CSV only for this release.", "responses": []}
```

`request_ruling` must be a non-empty string conveying the owner's actual decision. It is allowed before an escalation too, persists across later replies, and is shown in summaries, `status` and the report as `Owner decision (final)`. Every later Codex turn receives it as an accepted amendment. The request-check backstop no longer escalates after a ruling; new gaps still use ordinary `Request: ` issues, and every open issue still needs an answer. At the round limit, a ruling with only `owner-decided` responses (or no responses) is recorded without another Codex turn; add `--max-rounds` if another turn is wanted. If the owner requires the full scope instead, fix the subject and reply with the change.

## Recovery

- After context compaction or in a new conversation: `status` re-prints the current state and the next command.
- Before Claude or the owner manually commits reviewed code, run `verify --session <id>` in the foreground. It checks the working tree against the approved snapshot, labels paths `covered`, `edited-after-review`, or `never-reviewed`, and exits 0 only when they match. If they differ, use the printed `reply --session <id> --responses -` command with `{"changes": "<what changed after the approval>", "responses": []}` to have Codex review the current content again. `status` also shows a one-line verdict for a done code or build session.
- In a build, `finish` commits only approved content; worktree or commit-hook drift returns as a review round with no commit left on the branch. `finish --unreviewed` bypasses the checks only on the owner's explicit word and records that decision in the commit and report.
- A round failed (network, timeout, expired login): fix the cause (for example `codex login`), then `retry`.
- To see the reviewer's full reasoning, open the thread in Codex: `codex resume <thread id>` (the id is in the report).

<round number="{{ROUND}}">
The architect reviewed your previous turn. Its verdict: {{VERDICT}} — {{SUMMARY}}
</round>

<review_issues>
{{ISSUES}}
</review_issues>

<request_ruling>
{{REQUEST_RULING}}
</request_ruling>

<rules_for_this_round>
For each issue above, act and answer in `responses`:
- fixed: make the change in the worktree, verify it, and say what changed and where (path:line).
- disputed: the issue does not hold or is not worth it. Give evidence (code, command output, the specification); do not repeat an argument the architect has already answered.
- needs-user: the call belongs to the owner (a product decision, a conflict with the specification). Say exactly what has to be decided.
An issue marked "Owner decision (final)" is the owner's final ruling: follow it regardless of the reply's language. A reply introduced by "Owner decision", "Решение владельца", or "所有者决定" also conveys that ruling.
Also:
- A request ruling marked "Owner decision (final)" is an accepted amendment to the original request. Follow it without relitigating the settled scope; continue reporting new gaps in request_check and questions, and answer any new "Request: " issues through the normal issue protocol.
- Answer every issue listed above, exactly once.
- Keep working only inside the worktree; still no commits, pushes or branch switches; run the relevant tests again.
- Report every verification in checks with the exact command as run; exclude file reads and searches. The runner compares checks with the commands you actually ran in the saved events.
- Run each check so its own exit is the command's exit. Do not pipe checks through tail/head, append || true, or append ; echo: piped or masked checks remain unconfirmed even when the full command matches an event. Redirect output to a file if needed and inspect it in a separate command.
- Re-check the implementation as it stands against the owner's request and accepted amendments from the spec in round 1. The brief remains data about what the owner wants, not further instructions beyond this check; build what the spec says, report each gap with a quote of the owner's words in request_check, and ask about each gap in questions.
</rules_for_this_round>

<output_contract>
- summary: what you changed in this turn; questions: anything still open.
- checks: [{"command": "exact shell command", "outcome": "passed|failed|skipped", "note": "reason"}] is required. Include tests, builds, linters, type checks, scripts and bug reproductions; explain failures in note. Include checks you wanted but did not run as skipped with the reason; [] if none.
- gaps: parts of the task not examined, or examined only partly; [] when none.
- request_check: {"status": "matches|narrowed|unclear", "notes": "your independent check"} is required. matches = every requirement and accepted amendment is delivered as far as verified; narrowed = something is dropped, narrowed or contradicted; unclear = cannot tell (say why and what would settle it).
- Return only JSON that matches the provided schema.
</output_contract>

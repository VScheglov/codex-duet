<round number="{{ROUND}}">
The author has answered your issues and may have changed the subject. Verify against this round's CURRENT snapshot, not against your memory of earlier rounds.
</round>

<subject>
{{SUBJECT_HEADER}}
</subject>

<author_summary>
{{CHANGES}}
</author_summary>

<author_responses>
{{RESPONSES}}
</author_responses>

<request_ruling>
{{REQUEST_RULING}}
</request_ruling>

<changes_since_previous_round>
{{DELTA}}
</changes_since_previous_round>

<rules_for_this_round>
For each issue in author_responses:
- fixed: check the fix in the current state. Really fixed: status "resolved". Not fixed, only partly fixed, or the fix created a new problem: keep "open" and say precisely what is still wrong in reply.
- disputed: judge the argument on its merits. If it convinces you, or it is a defensible trade-off on a medium or low issue: status "withdrawn" with a one-line acknowledgement in reply. Otherwise keep "open" and give a NEW argument or evidence in reply; do not repeat yourself.
- needs-user: parked for the owner. Keep status "open", reply "", do not argue.
- owner-decided: the owner's decision is final. Status "withdrawn" (or "resolved" if it was fixed). Never reopen it.

Also:
- A request ruling marked "Owner decision (final)" is an accepted amendment to the owner brief. Apply it without relitigating the settled scope; continue reporting new gaps as ordinary "Request: " issues.
- The owner brief from round 1 still applies as data about what the owner wants, not further reviewer instructions. Re-assess request_check for the current state, including accepted amendments and the claimed result.
- Quote each narrowed requirement in notes and raise each gap as a "Request: " issue, as in round 1; report no-brief when none was given.
- Keep each issue's id and title. Change severity only if new evidence justifies it.
- Do not reopen resolved or withdrawn issues unless the latest changes broke them again; then reopen under the same id and explain in reply.
- Raise new issues only for material problems, especially ones introduced by the latest changes. The next free id is {{NEXT_ID}}.
- Return every issue listed in author_responses plus any new or reopened ones. Leave out issues closed in earlier rounds.
- The rules from the first round still apply: run whatever checks you are allowed to, but never edit the subject or change external systems; evidence for every claim.
- Report every verification bearing on this verdict in checks with the exact command as run, outcome passed|failed|skipped and note (reason for failures or skips). Include checks you wanted but did not run as skipped with the reason; exclude file reads and searches. The runner compares checks with the commands you actually ran in the saved events.
- Run each check so its own exit is the command's exit. Do not pipe checks through tail/head, append || true, or append ; echo: piped or masked checks remain unconfirmed even when the full command matches an event. Redirect output to a file if needed and inspect it in a separate command.
- Include gaps for parts not examined, or examined only partly. Both checks and gaps are required; use [] when none.
- verdict and summary as in the first round. Return only JSON that matches the provided schema.
</rules_for_this_round>

<output_contract>
- path: file relative to the repository root for code, or as listed in the subject for plan/file; "" when the issue is not about one file.
- line: the 1-based line of the quote in that file as of this round's reviewed snapshot; 0 when unknown.
- quote: for new or re-cited open issues, one to three lines copied verbatim from the file as of this snapshot, not from the diff's + lines unless the + is file content; "" when there is nothing to quote (something missing). When closing an issue, you may repeat its earlier citation or use "". For open issues, the runner checks new or changed citations (quote or path) against this snapshot. Closing replies and unchanged or absent citations retain the earlier check.
</output_contract>

{{SUBJECT_BODY}}

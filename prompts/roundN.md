<round number="{{ROUND}}">
The author has answered your issues and may have changed the subject. Verify against the CURRENT state on disk and in git, not against your memory of earlier rounds.
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
- Keep each issue's id and title. Change severity only if new evidence justifies it.
- Do not reopen resolved or withdrawn issues unless the latest changes broke them again; then reopen under the same id and explain in reply.
- Raise new issues only for material problems, especially ones introduced by the latest changes. The next free id is {{NEXT_ID}}.
- Return every issue listed in author_responses plus any new or reopened ones. Leave out issues closed in earlier rounds.
- The rules from the first round still apply: run whatever checks you are allowed to, but never edit the subject or change external systems; evidence for every claim.
- verdict and summary as in the first round. Return only JSON that matches the provided schema.
</rules_for_this_round>

{{SUBJECT_BODY}}

<interrupted_turn>
Your previous turn in this thread ended before your final reply: it was cut off (a time limit, or the owner stopped it), or it failed, or its reply could not be read. Nothing you did is lost: files you changed are still changed, and this thread holds everything you read and decided.
</interrupted_turn>

<rules_for_this_turn>
- Carry on with the same task from where you stopped. Check briefly what is already done instead of redoing it, then finish what is left.
- Everything the task asked of you still holds, including any review issues you were answering.
- For review and build replies, include checks (exact command as run, outcome passed|failed|skipped, note with the reason for a failure or skip) and gaps (unexamined or partly examined parts); use [] when none. Include wanted checks you did not run as skipped with a reason; exclude file reads and searches. The runner compares checks with the commands you actually ran in this resumed attempt's saved events, which replace the earlier attempt's events. Audit replies keep their own schema.
- Run review/build checks so each check's own exit is the command's exit: no | tail/head, || true, or ; echo. Piped or masked checks remain unconfirmed even for exact matches. Redirect output to a file if needed and inspect it separately.
- End with the final reply the task asked for: return only JSON that matches the provided schema.
</rules_for_this_turn>

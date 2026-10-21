The subject is a set of code changes. Review them as a strict senior engineer would before merging:
- Correctness: logic errors, edge cases (empty, null, huge, concurrent, repeated), error handling, resource cleanup.
- Security and data safety: injection, authorization, secrets, destructive operations, migrations.
- Behavior changes for existing callers, broken contracts or APIs, missing tests for new or changed behavior.
- Review the changes and the code they affect. Pre-existing problems elsewhere are out of scope unless the change makes them worse.

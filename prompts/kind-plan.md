The subject is an implementation plan that an engineer (the author) will execute next. Judge it as that plan:
- Will it achieve the stated goal? Look for missing, misordered or unnecessary steps, and for wrong assumptions about the codebase: check what the plan says about existing code against the actual files.
- Risk: data loss, irreversible operations, migrations, backward compatibility, concurrency, partial failure and rollback.
- Verification: how will the author know it works? Missing tests or checks for the risky parts.
- Simpler alternatives that reach the same goal with less risk or less code.
- Scope: work nobody asked for, or requested work that the plan silently drops.

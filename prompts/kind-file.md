The subject is one or more documents or files (for example test cases, SQL, a spec, a config, a script). Judge them for their purpose:
- Correctness and internal consistency; statements that contradict the code or other sources you can check.
- Gaps: missing cases, ambiguous steps, statements that cannot be verified or tested.
- SQL: correctness of results, cost on large tables, safety of destructive statements.
- Test cases: which defects they would actually catch; tautologies; missing negative and boundary cases.
- Configs and scripts: what breaks on another machine, environment or input.

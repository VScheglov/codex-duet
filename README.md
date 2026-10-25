[Русский](README.ru.md) | [简体中文](README.zh-CN.md)

# codex-duet

A review where Claude and Codex work things out themselves. Codex raises issues; Claude fixes each one, disputes it with evidence, or leaves the decision to you. The loop continues until they agree, reach a deadlock, or run out of rounds. No copying text between chats.

It also works the other way around: in **build** mode, Codex writes the code while Claude acts as architect and reviewer. Most of the work uses your Codex allowance.

## Installation

You need:

- Claude Code 2.1.275 or newer;
- [Codex CLI](https://github.com/openai/codex), signed in, with `codex` on your `PATH` (set `CODEX_DUET_CODEX_BIN` to use another binary);
- Node.js 22 or newer: the runner starts as `node scripts/duet.mjs`;
- git for code and build modes.

In a Claude Code terminal session:

```
/plugin install codex-duet --marketplace VScheglov/codex-duet
```

Answer `y` to `Add marketplace?` and choose a scope: user scope makes the plugin available in every project. From a shell, the equivalent is:

```bash
claude plugin install codex-duet --marketplace VScheglov/codex-duet
```

In the Claude app, where `/plugin` is unavailable, click + next to the input, then Plugins, Add marketplace with `VScheglov/codex-duet`, and Add plugin.

If `/codex-duet` and `/duet` do not appear after installation, open a new session or run `/reload-plugins`. The skill's full command name is `/codex-duet:codex-duet`; the short `/codex-duet` works as long as another command has not taken that name.

**Recommended: allow 12 hours for background commands.** A Codex turn can take a long time, so Claude runs it in the background with `timeout: 43200000`. Without configuration, Claude Code caps this at 2 hours and interrupts long turns (you can continue with `retry`). To prevent that, add this to `~/.claude/settings.json`:

```json
{ "env": { "BASH_MAX_TIMEOUT_MS": "43200000" } }
```

The setting applies to sessions opened after the change.

## Language

The plugin's `language` setting offers `auto` (the default), `en` (English), `ru` (Russian), and `zh` (Simplified Chinese). With `auto`, the plugin uses the first nonempty environment variable among `LC_ALL`, `LC_MESSAGES`, and `LANG`, in that order: a value starting with `ru` selects Russian, one starting with `zh` selects Chinese, and anything else selects English.

Only when all three variables are unset or empty, macOS uses the first preferred language in `AppleLanguages`, with the same `ru`/`zh` mapping. A nonempty locale variable always takes precedence. Other platforms, an empty preferred-language list, or a failed lookup fall back to English.

To set Russian from a shell:

```bash
echo '{"language":"ru"}' | claude plugin configure codex-duet --values-stdin
```

Replace `ru` with `en`, `zh`, or `auto` as needed. `--values-stdin` reads a JSON object whose values are single-line strings; options omitted from it keep their current values. Without `--values-stdin`, `claude plugin configure codex-duet` only displays the configuration. You can also change the language in the plugin's row in the `/plugin` menu.

The module reloads when the setting changes. The setting covers the plugin's interface and the notes and messages it sends to Claude; the runner's output remains English.

## Supported platforms

| Platform | Support |
|---|---|
| macOS | Everything |
| Linux | Everything except sound: Claude Code has no player on Linux, but toasts and the band still work. If a runner was killed with `kill -9` or the machine crashed, remove its leftover session lock manually: the `stale lock` error names the file. On macOS, the kernel releases that lock automatically (`O_EXLOCK`) |
| Windows | Unsupported: the runner and module invoke `kill`, `tail`, `head`, `grep`, and `diff`. WSL should behave like Linux but has not been tested |

If your organization manages Claude Code through managed settings, the `Stop` hook does not run for plugins installed by the user. In that case, the module cannot return Claude to the loop after its turn ends (see “Keeping the loop going”). Everything else works.

## Usage

```
/codex-duet plan                      plan from plan mode or the current conversation
/codex-duet code                      uncommitted changes, including untracked files
/codex-duet code --base main          the whole branch from its merge-base with main
/codex-duet file docs/spec.md         any files: test cases, SQL, specs, configuration
/codex-duet code -- check migrations  text after `--` sets the review's focus
/codex-duet status                    current progress, including after context compaction
```

You can also ask in plain language: “have Codex review this” or “discuss the plan with Codex.”

Options: `--max-rounds N` (default 10), `--model`, `--effort` (defaults from `~/.codex/config.toml`; you can name the model in plain language, such as “delegate to Codex, Astra model, max effort”), `--timeout-min` (limit per Codex turn; no limit by default), and `--sandbox` (default `inherit`: your own Codex settings; optionally `read-only`).

The runner checks the model and effort against your Codex model cache (`~/.codex/models_cache.json`). It refuses to start and lists the available choices if:

- the model does not exist (you can use an ID such as `gpt-6-astra` or a name such as `GPT-6-Astra`);
- the effort level does not exist;
- the model does not support that effort level, including the default in `config.toml`.

If there is no cache, the check is skipped. To switch the model or effort during a session, add `--model`/`--effort` to `reply`, `review`, or `retry`. The `Model:` line in the round summary shows what the session is using.

**⚡ Fast.** There is no separate flag: Codex takes its speed mode from `config.toml` (`service_tier = "priority"`, the model catalog's name for Fast). The ⚡ icon in the band above the input, the task list, and the pane (“Model: … · ⚡ Fast”) appears only when the turn is known to use Fast. “(from config)” means Fast is enabled in the configuration and the model catalog offers it for that model. This qualifier disappears when Codex records the turn's mode in the thread log (`~/.codex/sessions/…/rollout-…-<thread>.jsonl`, a `thread_settings_applied` entry). If the log reports the standard mode, the icon disappears. Codex 0.160 writes this entry at the beginning of every resumed turn, but the first turn in a new thread may not have one.

**Timing.** Codex turns take a long time, especially builds, so Claude runs `start`, `reply`, `review`, and `retry` in the background with `timeout: 43200000` (12 hours). Claude Code caps background commands at 2 hours unless you raise the limit: `max(2 hours, BASH_MAX_TIMEOUT_MS)`. “Installation” explains how to raise it to 12 hours; this also raises the maximum timeout for foreground commands to 12 hours. Claude Code silently caps any timeout above that ceiling. Without an explicit `timeout`, a foreground command lasts 2 minutes and a background command 30 minutes. The runner itself has no limit per turn by default; set one with `--timeout-min N`. Sessions started before 0.6.0 retain their old 60-minute limit; remove it with `retry --timeout-min 0` (or with `reply`/`review`).

**Interrupted turns.** If a turn is interrupted after Codex has started working (the background command times out, you press Stop, or Codex crashes), `retry` resumes the same Codex thread with a short “continue where you left off” prompt, even in the first round. Codex keeps its work and what it has read in context. Resuming is possible while the thread log in `~/.codex/sessions` is intact; without it, the turn starts over. `retry --fresh` always starts over.

**Several tasks at once.** You can delegate multiple tasks: every build gets its own worktree and branch. At most ten Codex turns run simultaneously on the machine (`CODEX_DUET_MAX_PARALLEL`); the rest wait in order in the queue (phase `queued`) and start automatically when a slot opens. Each Codex turn starts every MCP server in its configuration and consumes one quota slot, so ten tasks without a queue can mean hundreds of processes. A slot is held only while Codex is working; it is free while Claude reviews. Queue time counts toward the background command's two-hour ceiling, so prefer a few tasks at a time over dozens at once.

## Build mode: Codex writes, Claude reviews

```
/codex-duet build                     “delegate to Codex …”, “have Codex implement …”
```

1. Claude writes a specification: goal, scope, constraints, acceptance criteria, and how to test.
2. The runner creates a `codex-duet/<id>` branch in a separate worktree from HEAD. Your working tree is untouched. Codex does not see uncommitted changes.
3. Codex implements, runs tests, and reports what it did, what it checked, and what remains uncertain.
4. Claude reviews the round's diff, runs tests in the worktree itself, and raises issues C1…Cn. Codex fixes or disputes them. The stop policy is the same; deadlocks come to you (and the `/duet` pane).
5. Once everything is agreed, with your approval `finish` commits the work on the branch and removes the worktree; you merge it yourself. `discard` removes both the worktree and the branch.

Instructions for Claude are in `references/build.md`.

## Audit mode: Codex checks without changing anything

```
/codex-duet audit                     “audit this with Codex …”, “have Codex check … and report back”
```

A one-off report without negotiation: audit code, data, a reference standard, or a policy. Claude does not spend tokens responding to every finding. If a reference standard cannot change without your `APPROVED`, review mode is a poor fit: almost everything would come back to you. Build is also unsuitable, because an audit must not change anything.

1. Claude writes the task: what to examine, which question to answer, the scope, what counts as a finding, and what belongs in notes (a ranking or a table).
2. Codex works directly in the project directory, always with a read-only sandbox: the runner rejects any other `--sandbox` value. The prompt also prohibits writes through MCP tools; this is an instruction, not sandbox enforcement (see “Security”).
3. One turn produces a summary, findings A1…An (severity, location, evidence, recommendation, confidence), and what was and was not checked. Claude's summary has one line per finding; everything else is in the session's `report.md`.
4. There is nothing to answer: `reply` and `review` reject audits. For a different angle, start another audit with a more precise task. Findings remain Codex's claims: before relying on them, Claude checks the relevant ones or says they are unverified.

The queue, pane (`/duet` shows the summary and findings), ⚡ Fast, 12-hour turns, and `retry` resuming interrupted threads work just as they do in other modes.

## How negotiation works

```
start ─► Codex: issues C1…Cn (JSON matching the schema)
          │
          ▼
   Claude answers each issue:  fixed · disputed · needs-user
          │
reply ─► Codex (same session, resume): resolved · withdrawn · open + counterargument · new issues
          │
          ▼
   scripts/policy.mjs → continue · done · escalate (deadlock → you)
```

- Each issue has a permanent ID. Codex sees Claude's answers and the diff between rounds.
- If you rule in favor of the current version (`owner-decided`), the issue closes even if Codex disagrees.
- Reaching the round limit always escalates, regardless of the policy's decision.
- Claude never commits anything.

## Stop policy (`scripts/policy.mjs`)

Rules are checked from top to bottom; the first match wins:

1. Claude parked a critical/high issue (`needs-user`) → **escalate** immediately.
2. Codex says `approve` and no critical/high issues remain open → **done**. Medium/low issues go into the report; other parked decisions come to you.
3. Codex rejected disputes on the same issue twice → **escalate** (deadlock).
4. The number of open issues did not decrease for two consecutive rounds → **escalate** (stall).
5. Otherwise → **continue**.

The thresholds are the `MAX_DISPUTES` and `STALL_ROUNDS` constants. If you change the rules, update the `policy …` tests in `tests/run.mjs` too.

## The `/duet` pane and safeguards

The plugin includes a Claude Code module (`hooks/register.tsx`). Every 2 seconds, it reads session files and displays the review owned by **this** Claude session: the runner records the calling Claude session (`CLAUDE_CODE_SESSION_ID`) in its state and updates it on every turn. If you continue the review from another session, the first `reply` or `retry` moves it there. Reviews owned by another session appear only in the `/duet` pane, labeled and without decision buttons; they do not produce a band, footer, toasts, or sounds. Reviews started before 0.6.0 have no owner marker and remain visible everywhere, as before.

| Surface | Contents |
|---|---|
| **Pane** `/duet` | With multiple tasks, a list at the top (⏳ running, ⏸ queued with position, 🙋 needs you, ✅ done; timer and model); click a row for details. Then the phase and round timer; model and effort, with ⚡ Fast when the turn uses it; “Now: …” with Codex's command, or “thinking for N min” if its event stream has been quiet for more than two minutes, plus “Codex log updated N s ago”: the thread log keeps growing even while Codex thinks silently. Codex's latest words appear in full, with paragraphs, lists, and `code` rendered as Markdown, their age if older than two minutes, and actions (“running tests …”, “running a Python script”); its plan; an issue board (● open, ⏸ parked, ✓ fixed, ↩ withdrawn, ⚔×N disputes) with a “N of M closed” bar. Titles wrap beneath themselves instead of being cut off; ▸ expands both sides' statements; closed issues stay collapsed while any are open. Also the scoreboard, round history, Stop button (also stops a queued turn), and collapsed Settings at the bottom. Pane text wraps to fit; only task-list rows and Codex commands are truncated |
| ↳ on escalation | Codex's and Claude's positions and [Codex is right] / [Claude is right] buttons, followed by “Send decisions to Claude” |
| **Band above the prompt** and status line | Phase, timer, current Codex action; other modules' bands remain below it |
| **Footer** | A label such as “Duet r3 ⏳ 4:12”; click to open the pane. Visible even when the band above the prompt is disabled |
| **Toasts** | Round start and end, escalation, failure; after a round, a “continue codex-duet” suggestion (Tab) |
| **Sound** | Escalation (your decision is needed), review completion, round failure, or a missing Codex process; Claude's turns make no sound. Uses the Claude app's built-in sounds: `tool_approval_needed`, `enter_voice_mode`, `disconnected`. They play directly from the app and are not copied into the plugin. Without the app, fallback sounds from `sounds/` play |

**Keeping the loop going.** If a session is waiting for Claude (to answer issues, or to review a Codex build round) and Claude ends its turn, the module returns it to the loop once through the `Stop` hook. It does not do so when:

- Claude has asked you a question;
- you sent a message and Claude answered it without touching the loop;
- a background task is running or a session wake-up is scheduled;
- the session is waiting for your decision (escalation);
- Claude has just been returned to the loop already.

The reminder and context summary work only in the Claude session that owns the review.

While a code review or build is active (for 12 hours after its last turn), Claude cannot run `git commit`, `push`, or `stash` in that repository from any session (for a build, in its worktree). The guard reads executable shell commands, including quoted paths, `cd`/`pushd`, Git global options, environment assignments, command wrappers, compound commands, substitutions, `eval`, shell `-c`, and heredocs fed to a shell. When both a Git directory and a work tree are supplied, a write is blocked if either is in a guarded tree. Quoted mentions, comments, data heredocs, `stash list`, and `stash show` pass. A Git write whose directory depends on variables, substitutions, or globs is blocked whenever any session is guarded. If parsing fails (for example, from excessive nesting), commands containing the word `git` are blocked whenever a session is guarded; other commands pass. Git aliases (`git ci`, `git -c alias.x=commit x`), scripts and Makefiles that commit (`sh release.sh`, `npm run release`), and other commands assembled at run time are not recognized. The guard enforces Claude's own rule against slips; it is not a sandbox.

Your messages in the reviewed project receive a session summary, so Claude does not lose the loop after context compaction. Background task notifications do not receive it: the runner's output already contains everything.

Commands: `/duet` opens the pane; `/duet stop` stops the current round (you can continue later with `retry`); `/duet band|toasts|score|sound on|off` enables or disables interface features (also available as buttons in the collapsed Settings at the bottom of the pane); `/duet sound test` or the “▶ Sounds” button plays all three sounds in sequence. The module does not write session files; it only leaves a one-line `.ui-trace.json` trace for debugging.

## Security

- Codex runs with your **full harness**: your configuration, model, effort, all MCP servers, apps, and skills.
- The sandbox is **inherited** by default (`--sandbox inherit`): Codex can do whatever your regular Codex can, such as run tests. An explicit mode (`read-only`, `workspace-write`, `danger-full-access`) is applied on every turn: `-s` at start and `-c sandbox_mode=…` on `resume`, because `resume` has no `--sandbox` flag.
- The bans on changing files during review, committing, and modifying external systems are **prompt instructions, not a sandbox**. With `inherit` and your `danger-full-access`, an unattended agent has full access, so review other people's code (external PRs, downloaded files) with `--sandbox read-only`.
- **The sandbox does not restrict MCP tools.** The reviewer has the same MCP servers as your Codex, including ones that can write to external systems such as a production database. The prompt explicitly prohibits changes through any tools, but this is an instruction, not sandbox enforcement.
- **The keychain and a redirected `HOME` (macOS).** A program started with `HOME` pointing to a temporary directory (`claude`, `gh`, git credential helpers, `security`) cannot find the macOS keychain, so every sign-in attempt opens a “keychain not found” dialog. These dialogs stay open until dismissed. Click Cancel: “Reset to Defaults” creates a new, empty keychain in place of yours. Symlinking `~/Library/Keychains` removes the dialogs but gives the program your entire keychain; its entries can be changed through securityd. That is why the Codex prompts (build and review) and Claude's rules in SKILL.md require credentials through the environment: `CLAUDE_CODE_OAUTH_TOKEN` (created with `claude setup-token`) or `GH_TOKEN`. If credentials are unavailable, ask. Such dialogs have been caused, for example, by `claude -p` smoke runs in the Claude session overseeing a build; Codex itself did not run `claude` or `security`.

## File layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | `plugin.json`: plugin manifest; `marketplace.json`: the single-plugin marketplace used for installation |
| `SKILL.md`, `references/protocol.md`, `references/build.md` | Instructions for Claude |
| `README.md`, `README.ru.md`, `README.zh-CN.md` | Documentation in English, Russian, and Simplified Chinese |
| `scripts/duet.mjs` | Runner: Codex calls, issue ledger, snapshots, output |
| `scripts/policy.mjs` | **Your** `decideNextStep` stop policy |
| `prompts/`, `schemas/` | Reviewer prompts and response JSON schemas |
| `hooks/register.tsx`, `types/index.d.ts` | Module: pane, band, footer, toasts, sound, loop reminder, commit guard, context summary |
| `hooks/locales/en.ts`, `hooks/locales/ru.ts`, `hooks/locales/zh.ts` | Interface and session-message translations; English defines the key contract |
| `sounds/` | Fallback sounds when the Claude app is unavailable; `node sounds/make.mjs` synthesizes them again |
| `tests/` | `run.mjs`: runner and policy; `mod.mjs`: module with a stand-in engine; `pane.test.tsx`: rendering through the real engine's test kit |
| `~/.local/state/codex-duet/<id>/` | Sessions: `state.json`, prompts and replies for each round, `report.md` |

Open the reviewer's full reasoning in Codex with `codex resume <thread id>`; the report contains the ID.

## Environment variables

| Variable | Purpose |
|---|---|
| `CODEX_DUET_MODEL`, `CODEX_DUET_EFFORT` | Default model and effort |
| `CODEX_DUET_TIMEOUT_MIN` | Limit per Codex turn in minutes (default 0, unlimited) |
| `CODEX_DUET_MAX_PARALLEL` | Concurrent Codex turns on the machine (default 10); the rest wait in the queue |
| `CODEX_DUET_SANDBOX` | Default sandbox (`inherit`) |
| `CODEX_DUET_HOME` | Session storage location |
| `CODEX_DUET_POLICY` | Alternate policy file (used by tests) |
| `CODEX_DUET_CODEX_BIN` | Alternate codex binary (used by tests) |

## Tests

```bash
node tests/run.mjs
node tests/mod.mjs
claude plugin test .
claude plugin validate .
```

Run these from the plugin directory. `run.mjs` and `mod.mjs` also run in GitHub Actions (`.github/workflows/tests.yml`) on macOS and Linux.

`run.mjs` tests the runner with a fake Codex (`tests/fake-codex.mjs`): the ledger, disputes, escalation, `retry`, read-only on `resume`, diffs between rounds, and the policy's English reasons.

`mod.mjs` transpiles the real `hooks/register.tsx` and its local static imports, then runs its hooks against a stand-in engine (`tests/mod-engine.mjs`). `duet.mjs` creates its sessions with the same fake Codex. Tests cover the pane, band, footer, toasts, sound, loop reminder, commit guard, and context summary, including English by default, explicit Russian and Chinese, locale priority in `auto`, the macOS preferred-language fallback and English on lookup failure, translated session messages and decisions, and matching keys across the three locale tables. Transpilation requires esbuild (the copy bundled with a global `tsx` works) or `typescript`; set its path through `ESBUILD` or `TYPESCRIPT`. The stand-in catches logic errors but cannot catch misunderstandings of the API: check new engine calls against `claude-code.d.ts` and `claude plugin validate`. The idea comes from plan-progress ([zycck/claude-mods](https://github.com/zycck/claude-mods)).

`tests/pane.test.tsx` renders the pane through the engine's own test kit (`claude plugin test`) on terminal, desktop, and mobile surfaces in English, Russian, and Chinese. Each surface's component registry validates the tree, which the stand-in cannot do. The review session lives in test memory. Tests check that long titles and the label for another session are fully visible, issues expand, and Codex's words render as Markdown; the narrow 44-column layout also checks wrapping with double-width Chinese characters.

## Codex CLI pitfalls (0.159)

- `codex exec` waits for EOF on stdin if stdin is not a terminal, and hangs silently. The runner sends the prompt through stdin and closes it.
- `codex exec resume` does not accept `--sandbox`, `--cd`, or `--color`.
- `-c 'mcp_servers={}'` does not disable MCP: values are merged, not replaced.
- `codex mcp list --json` prints server environment variables **unmasked**, including tokens.

## Development

Claude Code automatically loads a clone in `~/.claude/skills/codex-duet` as `codex-duet@skills-dir`, without installation. Changes apply to new sessions. Do not also install the same plugin from the marketplace: an installed plugin takes precedence over a skills-dir plugin with the same name, and the clone appears as “Not loaded.”

## Disable or uninstall

```bash
claude plugin disable codex-duet@codex-duet
claude plugin uninstall codex-duet@codex-duet
```

A clone in `~/.claude/skills` can be disabled the same way using `codex-duet@skills-dir`; delete its directory to uninstall it.

## License

MIT; see [LICENSE](LICENSE).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, TextProps } from 'claude-code'

import { en } from './locales/en.ts'
import type { Locale } from './locales/en.ts'
import { ru } from './locales/ru.ts'
import { zh } from './locales/zh.ts'

import type { DuetChoice, DuetDiag, DuetIssue, DuetModel, DuetPlanStep, DuetPrefs, DuetRound, DuetView } from '../types'

// The codex-duet runner keeps everything a session knows in <state home>/<session>/:
// state.json (the ledger) and round-N.events.jsonl (Codex's live event stream).
// This mod reads those files on a timer and draws them; it never writes them.

const PANE = 'codex-duet'
const TITLE = 'Codex Duet'
const POLL_MS = 2000
const ACTIVE_MS = 12 * 60 * 60 * 1000 // a session counts as active this long after its last write
const DEFAULT_PREFS: DuetPrefs = { band: true, toasts: true, score: true, sound: true }
const ACTIVE_PHASES = ['queued', 'awaiting-codex', 'awaiting-author', 'awaiting-review', 'escalated', 'codex-failed']
// Phases where the loop waits on Claude; the Stop hold sends Claude back to them once.
const CLAUDE_PHASES = ['awaiting-author', 'awaiting-review']
// A cue sounds only where the person is needed; Claude's own turns stay quiet.
type Cue = 'decision' | 'done' | 'error'
const CUE_BY_PHASE: Record<string, Cue> = { escalated: 'decision', done: 'done', 'codex-failed': 'error' }
const CUE_ORDER: Cue[] = ['decision', 'done', 'error']
// The Claude app's own interface sounds, chosen by the owner; sounds/<cue>.wav stand in without the app.
const APP_SFX = '/Applications/Claude.app/Contents/Resources/ion-dist/audio/voice/sfx'
const APP_SOUND: Record<Cue, string> = { decision: 'tool_approval_needed.mp3', done: 'enter_voice_mode.mp3', error: 'disconnected.mp3' }
const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }
const SEVERITY_COLOR: Record<string, string> = { critical: 'red', high: 'red', medium: 'yellow', low: 'gray' }
// Four letters at most, so the id and severity of every row fit one fixed column and the titles line up.
const SEVERITY_SHORT: Record<string, string> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' }
const BADGE_CELLS = 11 // "● C10 crit" and a space
// The engine reloads the module when the language setting changes.
let locale: Locale = en
const phaseLabel = (phase: string) => (locale.phase as Record<string, string>)[phase] ?? phase
const actionLabel = (action: string) => (locale.action as Record<string, string>)[action] ?? action
const statusLabel = (status: string) => (locale.status as Record<string, string>)[status]
const SPARK = '▁▂▃▄▅▆▇█'
const NARRATION_MAX = 1500 // Codex's latest words, wrapped in the pane: a few paragraphs, not a whole essay
const STALE_MS = 2 * 60_000 // words older than this show their age, and a stream quiet this long reads as thinking
const BIG_STREAM = 3_500_000 // an event stream from this size on is read from its end (STREAM_TAIL bytes)
const STREAM_TAIL = 2_000_000
// `git [-C dir] [-c k=v] [--flags] commit|push|stash`: the subcommand, not a word in its arguments
const GIT_WRITE = /\bgit(?:\s+(?:-C|-c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(?:commit|push|stash)\b/

const viewAtom = atom({ plugin: 'codex-duet', key: 'view' } as const, null)
const listAtom = atom({ plugin: 'codex-duet', key: 'list' } as const, [])
const focusAtom = atom({ plugin: 'codex-duet', key: 'focus' } as const, '')
const prefsAtom = atom({ plugin: 'codex-duet', key: 'prefs' } as const, DEFAULT_PREFS)
const choicesAtom = atom({ plugin: 'codex-duet', key: 'choices' } as const, {})
const expandedAtom = atom({ plugin: 'codex-duet', key: 'expanded' } as const, {})
const diagAtom = atom({ plugin: 'codex-duet', key: 'diag' } as const, { root: '', error: '' })

// ---------------------------------------------------------------- text helpers

const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()
// Codex's words keep their paragraphs for the pane, which draws them as markdown; the band takes one line.
const paragraphs = (text: unknown) => String(text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text)
const tail = (file: string) => String(file).split('/').filter(Boolean).slice(-2).join('/')
const isBlocking = (issue: DuetIssue) => (SEVERITY_RANK[issue.severity] ?? 0) >= SEVERITY_RANK.high

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? locale.hoursMinutes(Math.floor(m / 60), m % 60) : `${m}:${String(s % 60).padStart(2, '0')}`
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// How long ago Codex spoke, or since its log last changed.
function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return locale.seconds(s)
  return s < 3600 ? locale.minutes(Math.floor(s / 60)) : locale.hoursMinutes(Math.floor(s / 3600), Math.floor((s % 3600) / 60))
}

// How old Codex's words are, once that matters: their own time when the runner stamped it, else at least as
// old as the silence of the stream they came in.
function wordsAge(v: DuetView) {
  if (v.narrationAgeMs !== null) return v.narrationAgeMs >= STALE_MS ? locale.wordsAgo(ago(v.narrationAgeMs)) : ''
  return v.quietMs !== null && v.quietMs >= STALE_MS ? locale.wordsOlder(ago(v.quietMs)) : ''
}

// What Codex does now: a command it runs (and for how long, once long), else thinking; then how fresh its own
// log is, which keeps growing while it thinks in silence.
function nowText(v: DuetView) {
  const quiet = v.quietMs !== null && v.quietMs >= STALE_MS ? ago(v.quietMs) : ''
  const what = v.current ? `${v.current}${quiet ? ` · ${quiet}` : ''}` : quiet ? locale.thinkingFor(quiet) : locale.thinking
  return v.logAgeMs === null ? what : locale.logUpdated(what, ago(v.logAgeMs))
}

// The band's short form: a command it runs, else its words while fresh, else how long it has been quiet.
function bandNow(v: DuetView) {
  if (v.current) return v.current
  const age = v.narrationAgeMs ?? v.quietMs
  if (v.narration && age !== null && age < STALE_MS) return oneLine(v.narration)
  return v.quietMs !== null && v.quietMs >= STALE_MS ? locale.thinkingFor(ago(v.quietMs)) : locale.thinking
}

// Fast is the "priority" service tier, as the runner records it from config.toml or Codex's own log.
const isFast = (m: DuetModel) => m.tier === 'priority' || m.tier === 'fast'

// Model and effort show their source; nothing known at all reads as Codex's own defaults.
function modelText(m: DuetModel) {
  const part = (value: string | null, key: string) => (value ? `${value}${m.fromConfig.includes(key) ? locale.fromConfig : ''}` : locale.configDefault)
  const fast = isFast(m) ? ` · ⚡ ${part('Fast', 'tier')}` : ''
  if (!m.model && !m.effort) return locale.modelDefaults(fast)
  return `${part(m.model, 'model')} · ${part(m.effort, 'effort')}${fast}`
}

// "gpt-6.1-sol/max ⚡" for the band, or nothing when the turn runs on unrecorded defaults.
const modelTag = (m: DuetModel) => [[m.model, m.effort].filter(Boolean).join('/'), isFast(m) ? '⚡' : ''].filter(Boolean).join(' ')

// "▰▰▰▱▱▱▱▱▱▱": how many of the issues are closed, at a glance
const progress = (done: number, total: number, cells = 10) =>
  total ? '▰'.repeat(Math.round((done / total) * cells)) + '▱'.repeat(cells - Math.round((done / total) * cells)) : ''

function sparkline(values: number[]) {
  const max = Math.max(1, ...values)
  return values.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('')
}

function statusMark(issue: DuetIssue) {
  if (issue.status === 'resolved') return '✓'
  if (issue.status === 'withdrawn') return '↩'
  return issue.parked ? '⏸' : '●'
}

// A raw shell command from Codex's event stream, as a short human line.
function describeCommand(raw: string) {
  const cmd = raw.replace(/^\/bin\/(?:zsh|bash|sh) -lc /, '').replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
  // a script it runs says more than the log it reads after: `bash scripts/test.sh > log; tail -2 log`
  const script = /(?:^|[\s;&|(])(?:\S*\/)?(?:bash|sh|zsh|python3?|node)\s+(?!-)([^\s;&|<>]+\.(?:sh|py|mjs|cjs|js|ts))(?=$|[\s;&|)])/.exec(cmd)
  if (script) return locale.runsScript(tail(script[1]))
  // code fed on stdin or in an argument says nothing in its first line: `python3 - <<'PY' import json…`
  const inline = /(?:^|[\s;&|(])(?:\S*\/)?(python3?|node|ruby|perl)\s+(?:-\s*<<|-c\s|-e\s|--eval\b|--input-type\b)/.exec(cmd)
  if (inline) return locale.runsInline(inline[1].startsWith('python') ? 'Python' : inline[1][0].toUpperCase() + inline[1].slice(1))
  const suite = /(?:\bpython3?\s+-m\s+(?:unittest|pytest)|\bpytest|\bgo\s+test|\bcargo\s+test|\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test|\bnode\s+--test|\bvitest|\bjest)\b(?:\s+(?!-|\d*[<>])([^\s;&|<>]+))?/.exec(cmd)
  if (suite) return locale.runsTests(suite[1] ? tail(suite[1]) : '')
  const lines = /sed -n '?(\d+),(\d+)p/.exec(cmd)
  // the file comes after the options (`tail -2`, `head -n 40`); a head or tail on a pipe reads no file
  const file = /git show [^\s:]+:(\S+)/.exec(cmd)?.[1]
    ?? /(?:sed -n '?[\d,;p]+'?|\bcat|\bnl -ba|\b(?:head|tail)(?:\s+-(?:[nc]\s*)?\d+)?)\s+(?!-)([^\s|;&<>]+)/.exec(cmd)?.[1]
  if (file && lines) return locale.readsLines(tail(file), lines[1], lines[2])
  if (file) return locale.readsFile(tail(file))
  const search = /\b(?:rg|grep)\b(?:\s+-[\w-]+)*\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(cmd)
  if (search && !/--files/.test(cmd)) return locale.searches(clip(search[1] ?? search[2] ?? search[3], 40))
  if (/\bcodex\b[\s\S]*--help/.test(cmd)) return locale.checksHelp
  const gitCmd = /\bgit (diff|log|status|blame|ls-files|rev-parse|show)\b/.exec(cmd)
  if (gitCmd) return `git ${gitCmd[1]}`
  if (/\b(?:ls|find|tree)\b|rg --files/.test(cmd)) return locale.browsesFiles
  // the rest as typed, without leading VAR=value settings and with absolute paths cut to their last part
  const bare = cmd
    .replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, '')
    .replace(/(^|[\s='"(])(?:\/[\w.@+-]+){2,}\/([\w.@+-]+)/g, '$1…/$2')
  return clip(oneLine(bare), 70)
}

// ---------------------------------------------------------------- reading a session

// narrationAt: when Codex said its last words, from the time the runner stamps on each event (_at, since
// 0.7.2); fileAt: when the event stream last grew.
type Digest = {
  activity: string[]; current: string; narration: string; narrationAt: number | null; plan: DuetPlanStep[]; commands: number
  threadId: string; fileAt: number
}

function digestEvents(text: string): Omit<Digest, 'fileAt'> {
  const activity: string[] = []
  const running = new Map<string, string>()
  let narration = ''
  let narrationAt: number | null = null
  let plan: DuetPlanStep[] = []
  let commands = 0
  let threadId = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue // the line being written right now
    }
    if (event?.type === 'thread.started') threadId = String(event.thread_id ?? '')
    const item = event?.item
    if (!item) continue
    const isStart = event.type === 'item.started'
    const isDone = event.type === 'item.completed'
    if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
      if (isStart) {
        const what = item.type === 'command_execution'
          ? describeCommand(String(item.command ?? ''))
          : `MCP ${item.server ?? '?'} · ${item.tool ?? '?'}`
        running.set(item.id, what)
        activity.push(what)
        if (item.type === 'command_execution') commands += 1
      } else if (isDone) {
        running.delete(item.id)
      }
    } else if (item.type === 'web_search' && isStart) {
      activity.push(locale.searchesWeb(clip(oneLine(item.query), 40)))
    } else if ((item.type === 'agent_message' || item.type === 'reasoning') && isDone) {
      const said = paragraphs(item.text)
      if (said && !said.startsWith('{')) { // "{…}" is the final reply
        narration = item.type === 'reasoning' ? `💭 ${said}` : said
        narrationAt = Date.parse(event._at) || null
      }
    } else if (item.type === 'todo_list' && Array.isArray(item.items)) {
      plan = item.items.map((step: any) => ({ text: oneLine(step.text), done: Boolean(step.completed) }))
    }
  }
  return { activity: activity.slice(-6), current: [...running.values()].at(-1) ?? '', narration, narrationAt, plan, commands, threadId }
}

const cache = { root: '' }
let ticking: Promise<void> | null = null
let lastJson = ''
let lastListJson = ''
let lastDiagJson = ''
let lastTrace = ''
let lastView: DuetView | null = null
// This session's tasks in play, as last published: what the Stop hold, the session note and the cues use.
let lastList: DuetView[] = []
let hasStatus = false
const openedFor = new Set<string>()
const goneAnnounced = new Set<string>()
// Whether a running or queued turn's runner still lives, per session; and Codex's event digest for the
// sessions the pane details. Both are re-read only when their files change.
type Liveness = { pid: number; gone: boolean }
const liveness = new Map<string, Liveness & { checkedAt: number; mtimeMs: number }>()
const digests = new Map<string, { key: string; digest: Digest }>()
const RECENT_MS = 10 * 60 * 1000 // a task that finished this recently stays in the list, so its end is announced
// The phase last announced per session. A session first seen this long after its last change is history,
// not news: a reload, or the pane falling back to an old review, must not replay its cue.
const announced = new Map<string, string>()
const FRESH_MS = 15_000

// This Claude session's id, the same one the runner records as a review's owner from CLAUDE_CODE_SESSION_ID.
let mySessionId = ''
// The newest sessions' states, re-read only when state.json changes; and the code reviews and builds that
// run anywhere, which the commit guard protects whichever Claude session drives them.
const states = new Map<string, { mtimeMs: number; st: any }>()
let guarded: { id: string; cwd: string; phase: string }[] = []

// What the Stop hold knows about this Claude session: whether it drives a duet at all, whether the
// person spoke last in the current turn, and whether Claude ran the runner since. A reload starts it over.
const loop = { drives: false, userSpoke: false, ranSinceUser: false }

async function stateRoot($: EngineInterface) {
  if (!cache.root) {
    const explicit = await $.env.get('CODEX_DUET_HOME')
    const xdg = await $.env.get('XDG_STATE_HOME')
    const home = await $.env.get('HOME')
    cache.root = explicit || `${xdg || `${home}/.local/state`}/codex-duet`
  }
  return cache.root
}

// A short name for a task in lists and toasts: a build's branch, a review's repository or files.
function labelOf(st: any) {
  if (st.kind === 'build') return String(st.subject?.branch ?? st.id).replace(/^codex-duet\//, '')
  if (st.kind === 'audit') return clip(oneLine(st.subject?.title) || locale.audit, 50)
  if (st.kind === 'code') return String(st.cwd ?? st.id).split('/').filter(Boolean).pop() ?? st.id
  return (st.subject?.paths ?? []).map((p: string) => String(p).split('/').pop()).join(', ') || st.id
}

// The pid in the lock file of a session whose turn runs or waits, checked at most every 5 s.
async function aliveOf($: EngineInterface, root: string, s: { id: string; mtimeMs: number; st: any }, now: number) {
  if (s.st.phase !== 'awaiting-codex' && s.st.phase !== 'queued') return null
  const known = liveness.get(s.id)
  if (known && known.mtimeMs === s.mtimeMs && now - known.checkedAt <= 5000) return known
  const pid = Number(await $.fs.read(`${root}/${s.id}/lock`).catch(() => '')) || 0
  const gone = !pid || (await $.process.run(['kill', '-0', String(pid)])).exitCode !== 0
  const next = { pid, gone, checkedAt: now, mtimeMs: s.mtimeMs }
  liveness.set(s.id, next)
  return next
}

// Codex's live events for a running turn, re-read when the file grows. $.fs.read stops at 4 MiB, so a longer
// stream is read from its end, with what fell out of that window kept from before and the commands counted
// by grep over the whole file.
async function digestOf($: EngineInterface, root: string, s: { id: string; st: any }) {
  if (s.st.phase !== 'awaiting-codex') return null
  const file = `${root}/${s.id}/round-${s.st.pending?.round}.events.jsonl`
  const known = digests.get(s.id)
  const stat = await $.fs.stat(file).catch(() => null)
  if (!stat) return known?.digest ?? null
  const key = `${file}:${stat.size}:${stat.mtimeMs}`
  if (known?.key === key) return known.digest
  let digest: Digest
  if (stat.size < BIG_STREAM) {
    digest = { ...digestEvents(String(await $.fs.read(file))), fileAt: stat.mtimeMs }
  } else {
    const end = (await $.process.run(['tail', '-c', String(STREAM_TAIL), file])).stdout
    const head = (await $.process.run(['head', '-n', '1', file])).stdout
    const counted = (await $.process.run(['grep', '-c', '"type":"item.started","item":{"id":"[^"]*","type":"command_execution"', file])).stdout
    const recent = digestEvents(end.slice(end.indexOf('\n') + 1)) // the first line is cut
    const before = known?.digest
    digest = {
      ...recent,
      narration: recent.narration || before?.narration || '',
      narrationAt: recent.narration ? recent.narrationAt : before?.narrationAt ?? null,
      plan: recent.plan.length ? recent.plan : before?.plan ?? [],
      commands: Number(counted.trim()) || recent.commands,
      threadId: digestEvents(head).threadId || before?.threadId || '',
      fileAt: stat.mtimeMs,
    }
  }
  digests.set(s.id, { key, digest })
  return digest
}

// Codex's own log of the thread (~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl) grows while Codex thinks
// in silence, when its event stream says nothing: its mtime is the sign of life. The runner remembers the path
// (st.codex.rollout); else it is looked for among the latest days, once a minute until found.
const codexLogs = new Map<string, { path: string; triedAt: number }>()
async function codexLogOf($: EngineInterface, st: any, threadId: string, now: number) {
  if (!threadId) return ''
  const known = codexLogs.get(threadId)
  if (known && (known.path || now - known.triedAt < 60_000)) return known.path
  let found = String(st.codex?.rollout ?? '').endsWith(`-${threadId}.jsonl`) ? String(st.codex.rollout) : ''
  if (!found) {
    const home = (await $.env.get('CODEX_HOME')) || `${await $.env.get('HOME')}/.codex`
    const below = async (dir: string) => (await $.fs.list(dir).catch(() => []))
      .filter((e) => e.kind === 'dir' && /^\d+$/.test(e.name)).map((e) => `${dir}/${e.name}`).sort().reverse()
    const days: string[] = []
    for (const year of await below(`${home}/sessions`)) {
      for (const month of await below(year)) {
        days.push(...await below(month))
        if (days.length >= 10) break
      }
      if (days.length >= 10) break
    }
    for (const day of days.slice(0, 10)) {
      const hit = (await $.fs.list(day).catch(() => [])).find((e) => e.name.endsWith(`-${threadId}.jsonl`))
      if (hit) {
        found = `${day}/${hit.name}`
        break
      }
    }
  }
  codexLogs.set(threadId, { path: found, triedAt: now })
  return found
}

async function logAtOf($: EngineInterface, st: any, digest: Digest, now: number) {
  const file = await codexLogOf($, st, digest.threadId, now)
  return file ? (await $.fs.stat(file).catch(() => null))?.mtimeMs || null : null
}

function buildView(st: any, now: number, live: Liveness | null, digest: Digest | null, queuedAhead: number | null, logAt: number | null = null): DuetView {
  const runningRound: number | null = st.phase === 'awaiting-codex' ? st.pending?.round ?? null : null
  const isQueued = st.phase === 'queued'
  const since = runningRound ? st.pending?.startedAt : isQueued ? st.pending?.queuedAt : null
  const raw = Object.values(st.issues ?? {}) as any[]
  const issues: DuetIssue[] = raw
    .map((i) => ({
      id: String(i.id),
      severity: String(i.severity),
      title: oneLine(i.title),
      status: String(i.status),
      parked: Boolean(i.parked),
      disputes: i.disputes ?? 0,
      lastAction: i.author?.action ?? null,
      codexReply: oneLine(i.codexReply || i.body),
      authorNote: oneLine(i.author?.note),
    }))
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
      || (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
      || Number(a.id.slice(1)) - Number(b.id.slice(1)))
  const rounds: DuetRound[] = (st.rounds ?? []).map((r: any) => ({
    n: r.n,
    verdict: r.verdict,
    seconds: Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) || 0,
    open: r.open ?? 0,
    tokens: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0),
  }))
  // In a review Claude is the author and Codex reviews; in a build it is the other way round.
  const roles = st.kind === 'build' ? { author: 'Codex', reviewer: 'Claude' } : { author: 'Claude', reviewer: 'Codex' }
  const answers = raw.flatMap((i) => (i.history ?? []).filter((h: any) => h.by === roles.author.toLowerCase()))
  const count = (action: string) => answers.filter((h: any) => h.action === action).length
  return {
    id: st.id,
    kind: st.kind,
    label: labelOf(st),
    cwd: st.cwd,
    // A build's Codex works in a worktree outside the project; Claude's session sits in the repository.
    project: st.kind === 'build' ? st.subject?.repo ?? st.cwd : st.cwd,
    owner: st.owner ?? null,
    isMine: isMine(st),
    updatedAt: st.updatedAt,
    // recorded by the runner when a turn starts; a session from before that knows only its own choice
    codexModel: (runningRound ? st.pending?.codexModel : st.rounds?.at(-1)?.codexModel)
      ?? { model: st.codex?.model ?? null, effort: st.codex?.effort ?? null, fromConfig: [] },
    subject: st.kind === 'build'
      ? `${tail(st.subject.repo)} → ${st.subject.branch}`
      : st.kind === 'audit' ? `${tail(st.cwd)} · ${oneLine(st.subject?.title)}`
      : st.kind === 'code' ? `${tail(st.cwd)} (git)` : (st.subject?.paths ?? []).map(tail).join(', '),
    // an audit's result: what Codex found, read-only, with nothing to negotiate
    findings: (st.findings ?? []).map((f: any) => ({
      id: String(f.id), severity: String(f.severity), title: oneLine(f.title), location: oneLine(f.location),
    })),
    result: oneLine(st.audit?.summary),
    roles,
    round: st.round ?? 0,
    maxRounds: st.maxRounds ?? 10,
    phase: st.phase,
    isActive: ACTIVE_PHASES.includes(st.phase) && now - Date.parse(st.updatedAt) < ACTIVE_MS,
    runningRound,
    isQueued,
    queuedAhead: isQueued ? queuedAhead : null,
    elapsedMs: since ? now - Date.parse(since) : 0, // Codex's time on the turn, or the wait in the queue
    pid: live?.pid ?? 0,
    isProcessGone: Boolean(live?.gone),
    failure: st.phase === 'codex-failed' ? oneLine(st.pending?.error) : '',
    decision: st.decision
      ? { action: st.decision.action, reason: oneLine(st.decision.reason), issues: st.decision.issues ?? [] }
      : null,
    issues,
    rounds,
    activity: digest?.activity ?? [],
    current: digest?.current ?? '',
    narration: digest?.narration ?? '',
    narrationAgeMs: digest?.narrationAt ? now - digest.narrationAt : null,
    quietMs: digest?.fileAt ? now - digest.fileAt : null,
    logAgeMs: logAt ? now - logAt : null,
    plan: digest?.plan ?? [],
    commands: digest?.commands ?? 0,
    score: {
      fixed: count('fixed'),
      disputed: count('disputed'),
      conceded: raw.filter((i) => i.status === 'withdrawn' && i.author?.action === 'disputed').length,
      parked: count('needs-user'),
      ownerDecided: count('owner-decided'),
    },
  }
}

// A review this Claude session drives: the runner recorded it as the owner, or the review is older than
// owners and so shows everywhere, as it used to.
const isMine = (st: any) => !st.owner || st.owner === mySessionId
const isRunning = (st: any, now: number) => ACTIVE_PHASES.includes(st.phase) && now - Date.parse(st.updatedAt) < ACTIVE_MS

// Session ids start with a UTC timestamp, so the newest names are the newest sessions; newest change first.
// A directory's own mtime reads 0, so state.json is what is stat'ed. A state that cannot be read is skipped
// and named, so one broken session does not blind the pane to the rest.
async function scanSessions($: EngineInterface, root: string) {
  const entries = await $.fs.list(root).catch(() => [])
  const names = entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.name).sort().reverse().slice(0, 30)
  const seen: { id: string; mtimeMs: number; st: any }[] = []
  let error = ''
  for (const id of names) {
    const stat = await $.fs.stat(`${root}/${id}/state.json`).catch(() => null)
    if (stat?.kind !== 'file') continue
    let known = states.get(id)
    if (!known || known.mtimeMs !== stat.mtimeMs) {
      try {
        known = { mtimeMs: stat.mtimeMs, st: JSON.parse(String(await $.fs.read(`${root}/${id}/state.json`))) }
      } catch (err) {
        error ||= `${id}: ${String((err as Error)?.message ?? err)}`
        continue
      }
      states.set(id, known)
    }
    seen.push({ id, ...known })
  }
  for (const id of [...states.keys()]) if (!names.includes(id)) states.delete(id)
  return { seen: seen.sort((a, b) => b.mtimeMs - a.mtimeMs), error }
}

// Which review this Claude session shows: its own while it runs; else one that runs elsewhere (the pane
// shows it, nothing announces it); else its own last one; else whatever ran last.
function pickSession(seen: { id: string; mtimeMs: number; st: any }[], now: number) {
  return seen.find((s) => isMine(s.st) && isRunning(s.st, now))
    ?? seen.find((s) => !isMine(s.st) && isRunning(s.st, now))
    ?? seen.find((s) => isMine(s.st))
    ?? seen[0]
    ?? null
}

async function setDiag($: EngineInterface, diag: DuetDiag) {
  const json = JSON.stringify(diag)
  if (json === lastDiagJson) return
  lastDiagJson = json
  await update($, diagAtom, () => diag)
}

// What the pane last read, one line beside the sessions, for debugging the mod from a shell.
async function trace($: EngineInterface, root: string, note: object) {
  const text = JSON.stringify(note)
  if (text === lastTrace) return
  lastTrace = text
  await $.fs.write(`${root}/.ui-trace.json`, `${text}\n`).catch(() => {})
}

// One read at a time; a caller that needs fresh state (the Stop hold) waits for the read in flight.
function tick($: EngineInterface) {
  ticking ??= readSession($).finally(() => {
    ticking = null
  })
  return ticking
}

async function readSession($: EngineInterface) {
  try {
    const root = await stateRoot($)
    mySessionId ||= await $.session.id().catch(() => '')
    const now = await $.clock.now()
    const { seen, error } = await scanSessions($, root)
    guarded = seen
      .filter((s) => (s.st.kind === 'code' || s.st.kind === 'build') && isRunning(s.st, now))
      .map((s) => ({ id: s.id, cwd: s.st.cwd, phase: s.st.phase }))
    // Places in the queue, across every owner: the runner serves waiting turns in the order they queued.
    const queue = seen
      .filter((s) => s.st.phase === 'queued')
      .sort((a, b) => String(a.st.pending?.queuedAt).localeCompare(String(b.st.pending?.queuedAt)))
      .map((s) => s.id)
    // This session's tasks in play: running, waiting on someone, or finished a moment ago.
    const mine = seen.filter((s) => isMine(s.st) && (isRunning(s.st, now) || now - Date.parse(s.st.updatedAt) < RECENT_MS))
    const picked = pickSession(seen, now)
    const focus: string = (await read($, focusAtom)) ?? ''
    const detailed = new Set([picked?.id, focus].filter(Boolean))
    const viewOf = async (s: { id: string; mtimeMs: number; st: any }) => {
      const ahead = queue.indexOf(s.id)
      const digest = detailed.has(s.id) ? await digestOf($, root, s) : null
      const logAt = digest ? await logAtOf($, s.st, digest, now) : null
      return buildView(s.st, now, await aliveOf($, root, s, now), digest, ahead >= 0 ? ahead : null, logAt)
    }
    const list: DuetView[] = []
    for (const s of mine) list.push(await viewOf(s))
    const view = picked ? list.find((v) => v.id === picked.id) ?? await viewOf(picked) : null
    for (const id of [...digests.keys()]) if (!detailed.has(id)) digests.delete(id)
    await publish($, view, list)
    await setDiag($, { root, error })
    await trace($, root, view ? { session: view.id, phase: view.phase, round: view.round, mine: view.isMine, tasks: list.length } : { session: null })
  } catch (err) {
    // A half-written file or a vanished session is retried next tick; the pane shows what failed.
    const error = String((err as Error)?.message ?? err)
    await setDiag($, { root: cache.root, error }).catch(() => {})
    if (cache.root) await trace($, cache.root, { error }).catch(() => {})
  }
}

async function publish($: EngineInterface, view: DuetView | null, list: DuetView[]) {
  lastView = view
  lastList = list
  const json = JSON.stringify(view)
  if (json !== lastJson) {
    lastJson = json
    await update($, viewAtom, () => view)
  }
  const listJson = JSON.stringify(list)
  if (listJson !== lastListJson) {
    lastListJson = listJson
    await update($, listAtom, () => list)
  }
  await announce($, list)
}

// A Codex round runs for minutes and the person looks away, so the moments that need them also sound.
// The app's sounds play from the app itself, never copied into the plugin; without the app, or once an
// update moves them, the plugin's synthesized cues play instead.
async function play($: EngineInterface, cue: Cue) {
  const file = `${APP_SFX}/${APP_SOUND[cue]}`
  const isThere = await $.fs.stat(file).then((st) => st.kind === 'file', () => false)
  const played = isThere ? await $.process.run(['afplay', file], { timeoutMs: 10_000 }).catch(() => null) : null
  if (played?.exitCode === 0) return
  await $.audio.play({ asset: `sounds/${cue}.wav` }).catch(() => {}) // no player at all: the toast still shows
}

// Every cue in turn, for the owner to hear what the review will sound like.
async function playAll($: EngineInterface) {
  for (const cue of CUE_ORDER) {
    await play($, cue)
    await $.clock.sleep(400)
  }
}

// Of the cues several tasks raise in one read, the one that matters most: the owner's decision, a
// failure, an end. One sound per read, so tasks that change together do not play over one another.
const CUE_RANK: Record<Cue, number> = { decision: 3, error: 2, done: 1 }
const loudest = (cues: Cue[]) => cues.reduce<Cue | null>((best, c) => (!best || CUE_RANK[c] > CUE_RANK[best] ? c : best), null)

// Status line, auto-opened pane, toasts and sounds for every task this Claude session drives; another
// session's reviews stay silent here. With several tasks, each toast names its task.
async function announce($: EngineInterface, list: DuetView[]) {
  const prefs: DuetPrefs = { ...DEFAULT_PREFS, ...(await read($, prefsAtom)) }
  const running = list.filter((v) => v.runningRound)
  const queued = list.filter((v) => v.isQueued)
  if (prefs.band && (running.length || queued.length)) {
    const one = running.length === 1 && !queued.length ? running[0] : null
    $.ui.status(one
      ? `codex-duet r${one.runningRound}/${one.maxRounds} · ${clock(one.elapsedMs)}`
      : locale.statusTasks(running.length, queued.length))
    hasStatus = true
  } else if (hasStatus) {
    $.ui.status(undefined)
    hasStatus = false
  }
  const isMany = list.filter((v) => v.isActive).length > 1
  const raised: Cue[] = []
  for (const view of list) raised.push(...await announceOne($, view, prefs, isMany ? `${view.label}: ` : ''))
  const sound = loudest(raised)
  if (sound && prefs.sound) void play($, sound)
}

// One task's change of phase: its toasts, and the cues it raises for announce to sound. A session seen for
// the first time is announced only if it changed a moment ago, so a reload or a fallback to an old review
// replays nothing.
async function announceOne($: EngineInterface, view: DuetView, prefs: DuetPrefs, tag: string): Promise<Cue[]> {
  const raised: Cue[] = []
  const key = `${view.phase}:${view.runningRound ?? view.round}`
  const before = announced.get(view.id)
  announced.set(view.id, key)
  // The runner died mid-turn (its phase still says running or queued): once per turn, never on a first look.
  const goneKey = view.isProcessGone ? `${view.id}:${view.runningRound ?? view.round}` : ''
  if (goneKey && !goneAnnounced.has(goneKey)) {
    goneAnnounced.add(goneKey)
    if (before !== undefined) {
      if (prefs.toasts) $.ui.toast(locale.toastGone(tag, view.runningRound ?? view.round + 1), { timeoutMs: 15000 })
      raised.push('error')
    }
  }
  if (key === before) return raised
  if (view.phase === 'awaiting-codex' && !openedFor.has(view.id)) {
    openedFor.add(view.id)
    void $.ui.open({ id: PANE, title: TITLE })
  }
  const isNews = before !== undefined || (await $.clock.now()) - Date.parse(view.updatedAt) < FRESH_MS
  if (!isNews) return raised
  const name = CUE_BY_PHASE[view.phase]
  if (name) raised.push(name)
  if (!prefs.toasts) return raised
  const open = view.issues.filter((i) => i.status === 'open' && !i.parked)
  const blocking = open.filter(isBlocking).length
  if (view.phase === 'awaiting-codex') {
    $.ui.toast(locale.toastStarted(tag, view.kind === 'audit', view.runningRound))
  } else if (view.phase === 'queued') {
    $.ui.toast(locale.toastQueued(tag, view.round + 1))
  } else if (view.phase === 'awaiting-review') {
    $.ui.toast(locale.toastReview(tag, view.round), { timeoutMs: 8000 })
  } else if (view.phase === 'awaiting-author') {
    $.ui.toast(locale.toastAuthor(tag, view.round, open.length, blocking), { timeoutMs: 8000 })
    void $.prompt.suggest({ text: locale.continuePrompt })
  } else if (view.phase === 'escalated') {
    $.ui.toast(locale.toastEscalated(tag, (view.decision?.issues ?? []).join(', ')), { timeoutMs: 15000 })
  } else if (view.phase === 'done') {
    $.ui.toast(view.kind === 'audit'
      ? locale.toastAuditDone(tag, view.findings.length)
      : locale.toastReviewDone(tag, view.round), { timeoutMs: 8000 })
  } else if (view.phase === 'codex-failed') {
    $.ui.toast(locale.toastFailed(tag, clip(view.failure, 80)), { timeoutMs: 15000 })
  }
  return raised
}

// ---------------------------------------------------------------- actions

async function setPref($: EngineInterface, name: keyof DuetPrefs, value?: boolean) {
  let saved: DuetPrefs = DEFAULT_PREFS
  await update($, prefsAtom, (prefs: DuetPrefs | undefined) => {
    const current = { ...DEFAULT_PREFS, ...prefs }
    saved = { ...current, [name]: value ?? !current[name] }
    return saved
  })
  await $.store.set('prefs', saved).catch(() => {}) // the toggle works this session even if saving fails
  return saved[name]
}

// Stops the given task's turn, running or waiting in the queue; /duet stop takes the one shown by default.
async function stopRound($: EngineInterface, given?: DuetView | null) {
  const view: DuetView | null = given ?? await read($, viewAtom)
  const round = view?.runningRound ?? (view?.isQueued ? view.round + 1 : null)
  if (!round || !view?.pid) return locale.noRoundToStop
  const { exitCode } = await $.process.run(['kill', '-TERM', String(view.pid)])
  if (exitCode !== 0) return locale.stopFailed(view.pid)
  return locale.stoppingRound(round, view.isQueued)
}

const pick = ($: EngineInterface, key: string, side: DuetChoice) =>
  update($, choicesAtom, (all: Record<string, DuetChoice> | undefined) => ({ ...all, [key]: side }))

async function sendDecisions($: EngineInterface, sessionId: string, kind: string, issues: DuetIssue[]) {
  let picked: Record<string, DuetChoice> = {}
  await update($, choicesAtom, (all: Record<string, DuetChoice> | undefined) => {
    picked = all ?? {}
    return Object.fromEntries(Object.entries(picked).filter(([key]) => !key.startsWith(`${sessionId}:`)))
  })
  const lines = issues.flatMap((issue) => {
    const side = picked[`${sessionId}:${issue.id}`]
    // In a build Claude is the reviewer: siding with Codex withdraws the issue, siding with Claude makes Codex fix it.
    if (kind === 'build') {
      if (side === 'codex') return [locale.buildChooseCodex(issue.id)]
      if (side === 'claude') return [locale.buildChooseClaude(issue.id)]
      return []
    }
    if (side === 'codex') return [locale.reviewChooseCodex(issue.id)]
    if (side === 'claude') return [locale.reviewChooseClaude(issue.id)]
    return []
  })
  if (!lines.length) {
    $.ui.toast(locale.chooseFirst)
    return
  }
  await $.prompt.submit({ text: locale.decisionsMessage(sessionId, lines.join('\n')) })
  $.ui.toast(locale.decisionsSent)
}

function commandDir(command: string, cwd: string, home: string) {
  const dir = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]
    ?? /(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]
  if (!dir) return cwd
  const plain = dir.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home)
  return plain.startsWith('/') ? plain : `${cwd}/${plain}`
}

const covers = (root: string, dir: string) => dir === root || dir.startsWith(`${root}/`)

// One folder inside the other: the review's repository and this Claude session are the same project.
const sameTree = (a: string, b: string) => covers(a, b) || covers(b, a)

// Whether this Claude session drives the review: the runner recorded it as the owner. A review from before
// owners falls back to the old test: this session sits in its project (and, where asked, ran the runner here).
function drives(view: DuetView, cwd: string, hasRunHere = true) {
  return view.owner ? view.owner === mySessionId : hasRunHere && sameTree(view.project, cwd)
}

type StopFacts = {
  stop_hook_active: boolean
  last_assistant_message?: string
  background_tasks?: readonly unknown[]
  session_crons?: readonly unknown[]
}

// The loop waits on Claude, yet Claude ended its turn: the text that sends it back, or null to let it stop.
// It stays quiet when the person is the one to move: a question to them, their own message that the loop
// did not answer, background work that will wake the session, or a second stop in a row.
async function holdReason($: EngineInterface, e: StopFacts) {
  if (e.stop_hook_active || (loop.userSpoke && !loop.ranSinceUser)) return null
  if ((e.background_tasks?.length ?? 0) > 0 || (e.session_crons?.length ?? 0) > 0) return null
  if (/\?\s*$/.test(e.last_assistant_message ?? '')) return null
  await tick($) // the round may have ended a moment ago
  const cwd = await $.session.cwd()
  const waiting = lastList.filter((v) => v.isActive && CLAUDE_PHASES.includes(v.phase) && drives(v, cwd, loop.drives))
  if (!waiting.length) return null
  const after = locale.holdAfter
  if (waiting.length > 1) {
    const each = waiting.map((v) => `${v.id} (${v.label}: ${v.phase === 'awaiting-review' ? locale.holdReview : locale.holdReply} ${v.round}/${v.maxRounds})`)
    return locale.holdMany(waiting.length, each.join('; '), after)
  }
  const view = waiting[0]
  const open = view.issues.filter((i) => i.status === 'open' && !i.parked).length
  const step = view.phase === 'awaiting-review'
    ? locale.holdReviewStep(view.round, view.maxRounds)
    : locale.holdReplyStep(view.round, view.maxRounds, open)
  return locale.holdOne(view.id, step, after)
}

function footerLabel(view: DuetView) {
  if (view.isQueued) return view.isProcessGone ? 'Duet ⚠️ retry' : locale.footerQueued(view.queuedAhead)
  if (view.runningRound) return view.isProcessGone ? 'Duet ⚠️ retry' : `Duet r${view.runningRound} ⏳ ${clock(view.elapsedMs)}`
  if (view.phase === 'escalated') return locale.footerEscalated
  if (view.phase === 'codex-failed') return locale.footerFailed
  return `Duet r${view.round} ${view.phase === 'awaiting-review' ? '🔍' : '✍️'}`
}

// "Duet ×5 ⏳3 ⏸1 🙋" for several tasks: how many run, wait in the queue, and need the owner.
function footerSummary(active: DuetView[]) {
  const running = active.filter((v) => v.runningRound && !v.isProcessGone).length
  const queued = active.filter((v) => v.isQueued && !v.isProcessGone).length
  const needYou = active.some((v) => v.phase === 'escalated' || v.phase === 'codex-failed' || v.isProcessGone)
  return `Duet ×${active.length}${running ? ` ⏳${running}` : ''}${queued ? ` ⏸${queued}` : ''}${needYou ? ' 🙋' : ''}`
}

// One line per task for the pane's list: what it is, where it stands, how long, on what model.
function taskLine(v: DuetView) {
  const model = modelTag(v.codexModel)
  if (v.isProcessGone) return locale.taskGone(v.label)
  if (v.isQueued) return locale.taskQueued(v.label, v.queuedAhead, clock(v.elapsedMs))
  if (v.runningRound) return locale.taskRunning(v.label, v.runningRound, v.maxRounds, clock(v.elapsedMs), model)
  if (v.phase === 'escalated') return locale.taskEscalated(v.label, (v.decision?.issues ?? []).join(', '))
  if (v.kind === 'audit' && v.phase === 'done') return locale.taskAuditDone(v.label, v.findings.length)
  return locale.taskOther(phaseLabel(v.phase), v.label, v.round, v.maxRounds)
}

// Several tasks at once: one short line each, so the note stays small.
function tasksNote(active: DuetView[], runner: string) {
  const each = active.map((v) => {
    const open = v.issues.filter((i) => i.status === 'open' && !i.parked).length
    return locale.taskNote(v.id, v.kind, v.label, v.runningRound ?? v.round, v.maxRounds, phaseLabel(v.phase), open)
  })
  return locale.tasksNote(active.length, each.join('; '), runner)
}

function contextNote(view: DuetView, runner: string) {
  if (view.kind === 'audit') {
    return locale.auditNote(view.id, view.subject, view.runningRound ? locale.codexWorking : phaseLabel(view.phase), view.phase === 'done' ? view.findings.length : null, runner)
  }
  const open = view.issues.filter((i) => i.status === 'open' && !i.parked).map((i) => `${i.id} [${i.severity}] ${clip(i.title, 60)}`)
  const parked = view.issues.filter((i) => i.status === 'open' && i.parked).map((i) => i.id)
  return [
    locale.reviewNote(view.id, view.kind, view.subject, view.runningRound ?? view.round, view.maxRounds, Boolean(view.runningRound), phaseLabel(view.phase), view.decision ? locale.noteDecision(view.decision.action, view.decision.reason) : ''),
    open.length ? locale.noteOpen(open.join('; ')) : locale.noOpenIssues,
    parked.length ? locale.noteParked(parked.join(', ')) : '',
    locale.noteNext(runner, view.id),
  ].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- hooks

async function preferredLanguage($: EngineInterface) {
  const value = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  if (value) return value
  // macOS GUI sessions often have no POSIX locale variables.
  try {
    const { exitCode, stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'])
    if (exitCode !== 0) return ''
    const list = /^\s*\(([\s\S]*)\)\s*$/.exec(stdout)
    if (!list) return ''
    const languages = list[1].split(',').map((entry) => entry.trim())
    if (!languages.every((entry) => /^(?:"[a-zA-Z][a-zA-Z0-9_-]*"|[a-zA-Z][a-zA-Z0-9_-]*)$/.test(entry))) return ''
    return languages[0].replace(/"/g, '')
  } catch {
    // Missing commands and unreadable preferences leave English as the default.
    return ''
  }
}

export const register: Register = (on, options) => {
  const language = options.language
  locale = language === 'ru' ? ru : language === 'zh' ? zh : en
  on('session.start', async ($, e, next) => {
    if (language !== 'en' && language !== 'ru' && language !== 'zh') {
      const code = (await preferredLanguage($)).toLowerCase()
      locale = code.startsWith('ru') ? ru : code.startsWith('zh') ? zh : en
    }
    await $.command.register({
      name: 'duet',
      description: locale.commandDescription,
    })
    const stored = await $.store.get('prefs')
    if (stored && typeof stored === 'object') await update($, prefsAtom, () => ({ ...DEFAULT_PREFS, ...(stored as Partial<DuetPrefs>) }))
    $.clock.every(POLL_MS, () => tick($))
    void tick($)
    return next(e)
  })

  on('command.run', { command: 'duet' }, async ($, e) => {
    const [what = '', value = ''] = e.args.trim().split(/\s+/)
    if (!what) {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: locale.paneOpened }
    }
    if (what === 'stop') return { text: await stopRound($) }
    if (what === 'sound' && value === 'test') {
      void playAll($)
      return { text: locale.soundPreview }
    }
    if (what === 'band' || what === 'toasts' || what === 'score' || what === 'sound') {
      const isOn = await setPref($, what, value === 'on' ? true : value === 'off' ? false : undefined)
      return { text: locale.commandSetting(what, isOn) }
    }
    return { text: locale.commandUsage }
  })

  // Remembers that this session ran the runner, then keeps Claude from committing, pushing or stashing in
  // a repository while a code review or a build runs there, whichever Claude session drives it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    if (!e.agentId && command.includes('duet.mjs')) {
      loop.drives = true
      loop.ranSinceUser = true
    }
    if (!GIT_WRITE.test(command) || !guarded.length) return next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const dir = commandDir(command, await $.session.cwd(), home)
    const hit = guarded.find((g) => covers(g.cwd, dir))
    if (!hit) return next(e)
    return {
      deny: locale.commitDenied(hit.cwd, hit.id, phaseLabel(hit.phase)),
    }
  })

  // The person's own messages in the review's project carry the session's state, so a compacted context
  // still knows the loop. Notifications do not: a finished round's output already says everything.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isPerson) {
      loop.userSpoke = true
      loop.ranSinceUser = false
    } else if (!e.turnId) {
      loop.userSpoke = false // a turn of its own that the person did not start
    }
    if (!isPerson) return next(e)
    const cwd = await $.session.cwd()
    const active = lastList.filter((v) => v.isActive && drives(v, cwd))
    if (!active.length) return next(e)
    const runner = `${$.plugin.root}/scripts/duet.mjs` // wherever the plugin is installed
    const note = active.length === 1 ? contextNote(active[0], runner) : tasksNote(active, runner)
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // A turn that ends while the loop waits on Claude goes back once; see holdReason.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block) return result
    const reason = await holdReason($, e).catch(() => null)
    return reason ? { ...result, block: reason } : result
  })

  // Other mods may draw above the prompt too: their rows stay under ours.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const view: DuetView | null = await read($, viewAtom)
    const prefs: DuetPrefs = { ...DEFAULT_PREFS, ...(await read($, prefsAtom)) }
    if (e.props.hasSurvey || !view?.isActive || !view.isMine || !prefs.band) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns ?? e.viewport?.columns ?? 80) - 10)
    let line = locale.bandAuthor(view.round, view.maxRounds, view.issues.filter((i) => i.status === 'open' && !i.parked).length)
    let color = 'cyan'
    if (view.isQueued) {
      line = view.isProcessGone
        ? locale.bandQueueGone
        : locale.bandQueued(view.label, view.queuedAhead, clock(view.elapsedMs))
    } else if (view.runningRound) {
      line = view.isProcessGone
        ? locale.bandRoundGone(view.runningRound)
        : `⏳ Codex${modelTag(view.codexModel) ? ` ${modelTag(view.codexModel)}` : ''} · r${view.runningRound}/${view.maxRounds} · ${clock(view.elapsedMs)} · ${bandNow(view)}`
    } else if (view.phase === 'awaiting-review') {
      line = locale.bandReview(view.round, view.maxRounds)
    } else if (view.phase === 'escalated') {
      line = locale.bandEscalated((view.decision?.issues ?? []).join(', '))
      color = 'yellow'
    } else if (view.phase === 'codex-failed') {
      line = locale.bandFailed(view.failure)
      color = 'red'
    }
    // the others go into a count; the pane lists them
    const others = ((await read($, listAtom)) ?? []).filter((v: DuetView) => v.isActive && v.id !== view.id).length
    if (others) line = locale.bandOthers(line, others)
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color={color}>{clip(line, width)}</Text>
          <Button key="open-pane" label={locale.paneButton} plain onPress={() => { void $.ui.open({ id: PANE, title: TITLE }) }} />
        </Box>
        {below}
      </Box>
    )
  })

  // A short label in the footer while a session is live, even with the band off; it opens the pane.
  // A terminal outside fullscreen takes no clicks there, so it gets plain text.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const view: DuetView | null = await read($, viewAtom)
    if (!view?.isActive || !view.isMine) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const active = ((await read($, listAtom)) ?? []).filter((v: DuetView) => v.isActive)
    const label = active.length > 1 ? footerSummary(active) : footerLabel(view)
    const isPressable = e.surface !== 'terminal' || e.viewport?.isFullscreen === true
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {isPressable
          ? <Button key="duet-footer" label={label} plain dimColor onPress={() => { void $.ui.open({ id: PANE, title: TITLE }) }} />
          : <Text dimColor>{label}</Text>}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    // Several tasks: a list on top, and below the details of the one picked there (the default otherwise).
    const list: DuetView[] = (await read($, listAtom)) ?? []
    const focus: string = (await read($, focusAtom)) ?? ''
    const view: DuetView | null = list.find((v) => v.id === focus) ?? await read($, viewAtom)
    const prefs: DuetPrefs = { ...DEFAULT_PREFS, ...(await read($, prefsAtom)) }
    const choices: Record<string, DuetChoice> = (await read($, choicesAtom)) ?? {}
    const expanded: Record<string, boolean> = (await read($, expandedAtom)) ?? {}
    const diag: DuetDiag = (await read($, diagAtom)) ?? { root: '', error: '' }
    // Only the task list's buttons are cut to the width (a label is one line); every other text wraps, since a
    // docked pane is narrow and what Codex says, a path or an issue's title loses its point when cut.
    const width = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    // A part the person folds and unfolds; `fallback` is how it stands until they touch it.
    const isOpen = (key: string, fallback = false) => expanded[key] ?? fallback
    const toggle = (key: string, fallback = false) => () => {
      void update($, expandedAtom, (all: Record<string, boolean> | undefined) => ({ ...all, [key]: !(all?.[key] ?? fallback) }))
    }
    const fold = (key: string, shown: boolean) => (
      <Button key={`fold-${key}`} label={shown ? '▾' : '▸'} plain dimColor onPress={toggle(key)} />
    )
    // A row whose text wraps under itself, beside a mark that keeps its column: a hanging indent.
    const row = (key: string, mark: RenderChildren, text: string, props: TextProps = {}) => (
      <Box key={key} gap={1}>
        {mark}
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="wrap" {...props}>{text}</Text>
        </Box>
      </Box>
    )
    const switches = (
      <Box flexWrap="wrap" gap={1}>
        <Button key="pref-band" label={locale.prefBand(prefs.band)} onPress={() => { void setPref($, 'band') }} />
        <Button key="pref-toasts" label={locale.prefToasts(prefs.toasts)} onPress={() => { void setPref($, 'toasts') }} />
        <Button key="pref-score" label={locale.prefScore(prefs.score)} onPress={() => { void setPref($, 'score') }} />
        <Button key="pref-sound" label={locale.prefSound(prefs.sound)} onPress={() => { void setPref($, 'sound') }} />
        <Button key="sound-test" label={locale.soundsButton} plain onPress={() => { void playAll($) }} />
      </Box>
    )
    if (!view) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>{locale.noSessions}</Text>
          <Text dimColor wrap="wrap">{locale.lookingIn(diag.root || '…')}</Text>
          {diag.error ? <Text color="red" wrap="wrap">{locale.readError(diag.error)}</Text> : null}
          <Text dimColor wrap="wrap">{locale.startHint}</Text>
          {switches}
        </Box>
      )
    }
    // The switches are set once and rarely touched, so in a review they fold away under one line.
    const settingsShown = isOpen('settings')
    const settings = (
      <Box flexDirection="column">
        <Button
          key="settings"
          label={locale.settings(settingsShown, prefs.band, prefs.sound)}
          plain
          dimColor
          onPress={toggle('settings')}
        />
        {settingsShown ? switches : null}
      </Box>
    )
    const open = view.issues.filter((i) => i.status === 'open' && !i.parked)
    const parked = view.issues.filter((i) => i.status === 'open' && i.parked)
    const closedIssues = view.issues.filter((i) => i.status !== 'open')
    const closed = closedIssues.length
    const escalated = view.phase === 'escalated'
      ? (view.decision?.issues ?? []).map((id) => view.issues.find((i) => i.id === id)).filter(Boolean) as DuetIssue[]
      : []
    const picked = escalated.filter((i) => choices[`${view.id}:${i.id}`]).length
    const phaseColor = view.phase === 'escalated' ? 'yellow' : view.phase === 'codex-failed' ? 'red' : view.phase === 'done' ? 'green' : 'cyan'
    const isWaiting = Boolean(view.runningRound || view.isQueued)
    const phaseText = isWaiting && view.isProcessGone
      ? locale.phaseGone
      : view.isQueued
        ? locale.phaseQueued(view.queuedAhead, clock(view.elapsedMs))
        : `${view.runningRound && view.kind === 'build' ? locale.phaseBuild : view.runningRound && view.kind === 'audit' ? locale.phaseAudit : phaseLabel(view.phase)}${view.runningRound ? ` · ${clock(view.elapsedMs)}` : ''}`
    const tasks = list.length > 1 ? (
      <Box flexDirection="column">
        <Text weight="semibold" wrap="wrap">
          {locale.taskCounts(list.filter((v) => v.runningRound).length, list.filter((v) => v.isQueued).length, list.length)}
        </Text>
        {list.map((v) => (
          <Button
            key={`task-${v.id}`}
            label={clip(`${v.id === view.id ? '▸' : ' '} ${taskLine(v)}`, width)}
            plain
            onPress={() => { void update($, focusAtom, () => v.id) }}
          />
        ))}
      </Box>
    ) : null

    // The mark, id and severity in a column of one width, in the monospaced face so the titles line up.
    const badge = (mark: string, id: string, severity: string, dim = false) => (
      <Box width={BADGE_CELLS} flexShrink={0}>
        <Text color={SEVERITY_COLOR[severity] ?? 'gray'} dimColor={dim} mono>
          {`${mark} ${id.padEnd(3)} ${SEVERITY_SHORT[severity] ?? severity}`}
        </Text>
      </Box>
    )
    // One issue on a row, its title wrapping beside the badge; unfolded, what each side said about it.
    const issueRow = (issue: DuetIssue) => {
      const key = `${view.id}:${issue.id}`
      const shown = isOpen(key)
      const isDone = issue.status !== 'open'
      const answer = issue.lastAction ? ` (${actionLabel(issue.lastAction)})` : ''
      const said = [
        issue.codexReply ? `${view.roles.reviewer}: ${issue.codexReply}` : '',
        issue.lastAction || issue.authorNote ? `${view.roles.author}${answer}: ${issue.authorNote || '—'}` : '',
        [statusLabel(issue.status), issue.parked ? locale.parkedForOwner : '', issue.disputes ? locale.disputes(issue.disputes) : '']
          .filter(Boolean).join(' · '),
      ].filter(Boolean)
      return (
        <Box key={`issue-${issue.id}`} flexDirection="column">
          <Box gap={1}>
            {fold(key, shown)}
            {badge(statusMark(issue), issue.id, issue.severity, isDone)}
            <Box flexShrink={1} flexGrow={1}>
              <Text dimColor={isDone} wrap="wrap">{`${issue.disputes ? `⚔×${issue.disputes} ` : ''}${issue.title}`}</Text>
            </Box>
          </Box>
          {shown ? (
            <Box flexDirection="column" paddingLeft={2}>
              {said.map((text, n) => (
                <Box key={`said-${issue.id}-${n}`}>
                  <Text dimColor wrap="wrap">{text}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }
    // Closed issues fold away while any is still open: the board shows what is left to settle.
    const closedKey = `${view.id}:closed`
    const closedByDefault = open.length + parked.length === 0
    const closedShown = isOpen(closedKey, closedByDefault)
    const board = (
      <Box flexDirection="column">
        <Text weight="semibold" wrap="wrap">{locale.issueCounts(open.length, parked.length, closed)}</Text>
        {view.issues.length ? <Text dimColor>{`${progress(closed, view.issues.length)} ${closed}/${view.issues.length}`}</Text> : null}
        {[...open, ...parked].map(issueRow)}
        {closed ? (
          <Button
            key="fold-closed"
            label={locale.closedIssues(closedShown, closed)}
            plain
            dimColor
            onPress={toggle(closedKey, closedByDefault)}
          />
        ) : null}
        {closedShown ? closedIssues.map(issueRow) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tasks}
        <Box flexDirection="column">
          <Text weight="semibold" wrap="wrap">{locale.paneHeading(view.kind, view.runningRound ?? view.round, view.maxRounds)}</Text>
          <Text dimColor wrap="wrap">{`${view.id} · ${view.subject}`}</Text>
          <Text dimColor wrap="wrap">{locale.model(modelText(view.codexModel))}</Text>
          {view.isMine ? null : (
            <Text color="yellow" wrap="wrap">{locale.otherSession}</Text>
          )}
          <Box gap={1} flexWrap="wrap" alignItems="center">
            <Text color={phaseColor} wrap="wrap">{phaseText}</Text>
            {isWaiting && view.pid && !view.isProcessGone ? (
              <Button key="stop" label={locale.stopButton} onPress={() => { void stopRound($, view).then((text) => $.ui.toast(text)) }} />
            ) : null}
          </Box>
          {view.decision && !view.runningRound ? <Text dimColor wrap="wrap">{locale.decision(view.decision.action, view.decision.reason)}</Text> : null}
          {view.failure ? <Text color="red" wrap="wrap">{view.failure}</Text> : null}
          {diag.error ? <Text color="red" wrap="wrap">{locale.readErrorStale(diag.error)}</Text> : null}
        </Box>

        {view.runningRound ? (
          <Box flexDirection="column">
            <Text wrap="wrap">{locale.now(nowText(view))}</Text>
            {/* Codex writes markdown (`code`, lists, paragraphs): drawn as a reply is, it reads as Codex meant it */}
            {view.narration ? <Markdown text={clip(`Codex${wordsAge(view)}: ${view.narration}`, NARRATION_MAX)} dimColor /> : null}
            {view.plan.map((step, n) => row(`plan-${n}`, <Text dimColor={step.done}>{step.done ? '☑' : '☐'}</Text>, step.text, { dimColor: step.done }))}
            {/* a command is a glance at what Codex does: one line, cut by the surface at the pane's edge */}
            {view.activity.map((what, n) => (
              <Box key={`act-${n}`}>
                <Text dimColor wrap="truncate-end">{`  · ${what}`}</Text>
              </Box>
            ))}
            <Text dimColor>{locale.commandsCompleted(view.commands)}</Text>
          </Box>
        ) : null}

        {escalated.length ? (
          <Box flexDirection="column" gap={1}>
            <Text weight="semibold" color="yellow">{locale.yourDecision}</Text>
            {escalated.map((issue) => {
              const key = `${view.id}:${issue.id}`
              const choice = choices[key]
              return (
                <Box key={`esc-${issue.id}`} flexDirection="column">
                  <Text weight="semibold" wrap="wrap">{`${issue.id} [${issue.severity}] ${issue.title}`}</Text>
                  <Text wrap="wrap">{`${view.roles.reviewer}: ${issue.codexReply || '—'}`}</Text>
                  <Text wrap="wrap">{`${view.roles.author}: ${issue.authorNote || '—'}`}</Text>
                  {view.isMine ? <Box gap={1} flexWrap="wrap">
                    <Button
                      key={`pick-codex-${issue.id}`}
                      label={locale.chooseCodex(choice === 'codex')}
                      variant={choice === 'codex' ? 'primary' : 'secondary'}
                      onPress={() => { void pick($, key, 'codex') }}
                    />
                    <Button
                      key={`pick-claude-${issue.id}`}
                      label={locale.chooseClaude(choice === 'claude')}
                      variant={choice === 'claude' ? 'primary' : 'secondary'}
                      onPress={() => { void pick($, key, 'claude') }}
                    />
                  </Box> : null}
                </Box>
              )
            })}
            {/* A decision goes to the Claude session that drives the review, so only that one sends it. */}
            {view.isMine ? (
              <Button
                key="send-decisions"
                variant="primary"
                label={locale.sendDecisions(picked, escalated.length)}
                onPress={() => { void sendDecisions($, view.id, view.kind, escalated) }}
              />
            ) : null}
          </Box>
        ) : null}

        {view.kind === 'audit' ? (
          view.phase === 'done' ? (
            <Box flexDirection="column">
              {view.result ? <Text wrap="wrap">{locale.result(view.result)}</Text> : null}
              <Text weight="semibold">{locale.findings(view.findings.length)}</Text>
              {view.findings.map((f) => row(`finding-${f.id}`, badge('●', f.id, f.severity), `${f.title}${f.location ? ` — ${f.location}` : ''}`))}
              <Text dimColor wrap="wrap">{locale.reportHint}</Text>
            </Box>
          ) : null
        ) : board}

        {prefs.score && view.kind !== 'audit' ? (
          <Box flexDirection="column">
            <Text weight="semibold">{locale.scoreHeading}</Text>
            <Text wrap="wrap">{locale.authorScore(view.roles.author, view.score.fixed, view.score.disputed, view.score.parked)}</Text>
            <Text wrap="wrap">{locale.reviewerScore(view.roles.reviewer, view.score.conceded, view.score.ownerDecided)}</Text>
            {view.rounds.length ? (
              <Text dimColor wrap="wrap">{locale.openByRound(sparkline(view.rounds.map((r) => r.open)), view.rounds.map((r) => r.open).join(' → '))}</Text>
            ) : null}
            {view.rounds.map((r) => (
              <Box key={`round-${r.n}`}>
                <Text dimColor wrap="wrap">{locale.roundSummary(r.n, clock(r.seconds * 1000), r.verdict, r.open, r.tokens ? tokens(r.tokens) : '')}</Text>
              </Box>
            ))}
          </Box>
        ) : null}

        {settings}
      </Box>
    )
  })
}

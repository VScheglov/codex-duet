export type DuetChoice = 'codex' | 'claude'

export type DuetPrefs = { band: boolean; toasts: boolean; score: boolean; sound: boolean }

// What the pane says about its own reading: which folder, and the last error if a read failed.
export type DuetDiag = { root: string; error: string }

export type DuetIssue = {
  id: string
  severity: string
  title: string
  status: string
  parked: boolean
  disputes: number
  lastAction: string | null
  codexReply: string
  authorNote: string
}

export type DuetRound = { n: number; verdict: string; seconds: number; open: number; tokens: number }

// One finding of an audit (--kind audit); the evidence and the recommendation stay in the session's report.md.
export type DuetFinding = { id: string; severity: string; title: string; location: string }

export type DuetPlanStep = { text: string; done: boolean }

export type DuetScore = { fixed: number; disputed: number; conceded: number; parked: number; ownerDecided: number }

// What a Codex turn runs on, recorded when the turn starts; fromConfig names what came from config.toml.
// tier: a service tier beyond the standard one ("priority" is Fast), from config.toml, then from Codex's own
// log while the turn runs ("default" once it says the turn got the standard tier); absent when unknown.
export type DuetModel = { model: string | null; effort: string | null; fromConfig: string[]; tier?: string }

export type DuetView = {
  id: string
  kind: string
  label: string // a short name for lists and toasts: a build's branch, a review's repository or files
  isQueued: boolean // the turn waits for a free Codex slot (at most CODEX_DUET_MAX_PARALLEL run at once)
  queuedAhead: number | null // turns queued before this one, across every owner
  cwd: string // where Codex works: the session's folder, or a build's worktree
  project: string // the folder the session belongs to: a build's repository, else cwd
  owner: string | null // the Claude session id that drives the review; null for reviews from before owners
  isMine: boolean // this Claude session drives it (or it predates owners): only then the mod announces it
  updatedAt: string // the state's last write, ISO
  codexModel: DuetModel // the running turn's, else the last round's; before 0.6.1, the session's own choice
  subject: string
  roles: { author: string; reviewer: string } // who writes and who reviews: Claude/Codex, or the reverse in a build
  round: number
  maxRounds: number
  phase: string
  isActive: boolean
  runningRound: number | null
  elapsedMs: number
  pid: number
  isProcessGone: boolean
  failure: string
  decision: { action: string; reason: string; issues: string[] } | null
  issues: DuetIssue[]
  findings: DuetFinding[] // an audit's, [] for every other kind
  result: string // an audit's summary, '' for every other kind
  rounds: DuetRound[]
  activity: string[]
  current: string
  narration: string // Codex's latest words with their paragraphs, markdown as Codex wrote it
  narrationAgeMs: number | null // how old Codex's last words are; known from the runner's _at stamps (0.7.2 on)
  quietMs: number | null // since Codex's event stream last grew
  logAgeMs: number | null // since Codex's own log of the thread changed: it grows while Codex thinks in silence
  plan: DuetPlanStep[]
  commands: number
  score: DuetScore
}

declare module 'claude-code' {
  interface PluginState {
    'codex-duet': {
      view: DuetView | null
      list: DuetView[] // this Claude session's tasks in play, newest change first
      focus: string // the task picked in the pane's list
      prefs: DuetPrefs
      choices: Record<string, DuetChoice>
      // what the person unfolded in the pane: an issue ('<session>:<issue>'), a session's closed issues
      // ('<session>:closed'), the settings ('settings'); absent is the default
      expanded: Record<string, boolean>
      diag: DuetDiag
    }
  }
}

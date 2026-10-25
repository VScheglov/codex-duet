// A static shell reader for the commit guard, not a shell interpreter. Quoted words keep their values
// for paths and shell -c/eval; only executable positions and substitutions are inspected for Git.
type Dir = string | null
type Word = { value: string; quoted: boolean; tilde: boolean; assignment?: string }
type Heredoc = { tag: Word; tabs: boolean; body: string }
type Redirects = { substitutions: Node[][]; docs: Heredoc[]; stdin?: Heredoc | null; stdout: boolean }
type Simple = Redirects & { kind: 'simple'; words: Word[]; end: string }
type Group = Redirects & { kind: 'group'; body: Node[]; isolated: boolean; end: string }
type Node = Simple | Group
type DirStack = { cwd: Dir; next: DirStack | null }
type Context = { cwd: Dir; previous: Dir; stack: DirStack | null; env: Record<string, Word> }
// cwd is the primary work tree; dirs also protects the repository selected by an explicit Git dir.
export type GitWrite = { action: 'commit' | 'push' | 'stash'; cwd: Dir; dirs: Dir[] }

const redirects = (): Redirects => ({ substitutions: [], docs: [], stdout: false })
const simple = (): Simple => ({ ...redirects(), kind: 'simple', words: [], end: '' })
const group = (body: Node[], isolated: boolean, end = ''): Group => ({ ...redirects(), kind: 'group', body, isolated, end })
const space = (c: string) => c === ' ' || c === '\t' || c === '\r'
const boundary = (c: string) => '; &|\n()<>'.includes(c)
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const reserved = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'])
const assignment = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/s
const dynamic = /[$`*?[]/
const program = (value: string) => value.slice(value.lastIndexOf('/') + 1)
const fork = (ctx: Context): Context => ({ ...ctx, env: { ...ctx.env } })

function join(a: Context | null, b: Context): Context {
  if (!a) return fork(b)
  const env = { ...a.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE']) {
    if (a.env[key]?.value !== b.env[key]?.value || a.env[key]?.tilde !== b.env[key]?.tilde) {
      env[key] = { value: '$?', quoted: false, tilde: false }
    }
  }
  return { cwd: a.cwd === b.cwd ? a.cwd : null, previous: a.previous === b.previous ? a.previous : null, stack: a.stack === b.stack ? a.stack : null, env }
}

// A shared cursor consumes each source level once, including comments and pending heredocs. In
// particular, no regexp repeatedly searches the unconsumed suffix of a long command.
class Reader {
  private at = 0
  constructor(private text: string) {}

  read(stop = ''): Node[] {
    const nodes: Node[] = []
    const pending: Heredoc[] = []
    let cmd = simple()
    let jobStart = 0
    const flush = (end = '') => {
      if (cmd.words.length || cmd.docs.length || cmd.substitutions.length) {
        cmd.end = end
        nodes.push(cmd)
        cmd = simple()
      } else if (nodes.length && end) nodes[nodes.length - 1].end = end
    }
    while (this.at < this.text.length) {
      const c = this.text[this.at]
      const braceEnd = this.at + 1 === this.text.length || space(this.text[this.at + 1]) || boundary(this.text[this.at + 1])
      if (stop && c === stop && (stop !== '}' || (braceEnd && !cmd.words.length))) {
        this.at++
        break
      }
      if (space(c)) {
        this.at++
      } else if (c === '\\' && this.text[this.at + 1] === '\n') {
        this.at += 2
      } else if (c === '#') {
        const end = this.text.indexOf('\n', this.at)
        this.at = end < 0 ? this.text.length : end
      } else if (c === '\n') {
        this.at++
        const continued = !cmd.words.length && !cmd.docs.length && !cmd.substitutions.length
          && ['&&', '||', '|'].includes(nodes.at(-1)?.end ?? '')
        if (!continued) {
          flush('\n')
          jobStart = nodes.length
        }
        for (const doc of pending) this.heredoc(doc)
        pending.length = 0
      } else if (c === ';' || c === '&' || c === '|') {
        this.at++
        let op = c
        if (this.text[this.at] === c) op += this.text[this.at++]
        // Bash's |& is a pipe too; & here belongs to the pipe, not to a second job.
        if (op === '|' && this.text[this.at] === '&') this.at++
        flush(op)
        if (op === '&') {
          // & backgrounds the entire AND/OR list, so its earlier cd must not escape either.
          const body = nodes.splice(jobStart)
          nodes.push(group(body, true, '&'))
        }
        if (op === ';' || op === '&') jobStart = nodes.length
      } else if (c === '(' || (c === '{' && braceEnd && cmd.words.every((w) => !w.quoted && (reserved.has(w.value) || w.value === 'time' || w.value === '-p')))) {
        this.at++
        flush()
        nodes.push(group(this.read(c === '(' ? ')' : '}'), c === '('))
      } else if (c === ')') {
        this.at++
        flush()
      } else if ((c === '<' || c === '>') && this.text[this.at + 1] === '(') {
        this.at += 2
        cmd.substitutions.push(this.read(')')) // process substitution
      } else {
        // An IO number is part of a redirection, not an argument (2>file, 3<<EOF).
        let io = this.at
        while (io < this.text.length && /[0-9]/.test(this.text[io])) io++
        if (this.text[io] === '<' || this.text[io] === '>') {
          const fd = io > this.at ? Number(this.text.slice(this.at, io)) : this.text[io] === '<' ? 0 : 1
          this.at = io
          const last = nodes.at(-1)
          const target = !cmd.words.length && !cmd.docs.length && !cmd.substitutions.length && last?.kind === 'group' && !last.end ? last : cmd
          this.redirect(target, pending, fd)
        } else {
          cmd.words.push(this.word(cmd.substitutions))
        }
      }
    }
    flush()
    return nodes
  }

  private redirect(cmd: Redirects, pending: Heredoc[], fd: number) {
    const c = this.text[this.at++]
    if (fd === 0) cmd.stdin = null
    if (fd === 1) cmd.stdout = true
    if (c === '<' && this.text[this.at] === '<' && this.text[this.at + 1] !== '<') {
      this.at++
      const tabs = this.text[this.at] === '-'
      if (tabs) this.at++
      while (space(this.text[this.at])) this.at++
      const doc = { tag: this.word([]), tabs, body: '' }
      cmd.docs.push(doc)
      pending.push(doc)
      if (fd === 0) cmd.stdin = doc
      return
    }
    while ('<>&|'.includes(this.text[this.at] ?? '\0')) this.at++
    while (space(this.text[this.at])) this.at++
    if (this.at < this.text.length && !boundary(this.text[this.at])) this.word(cmd.substitutions)
  }

  private heredoc(doc: Heredoc) {
    const start = this.at
    while (this.at < this.text.length) {
      const end = this.text.indexOf('\n', this.at)
      const until = end < 0 ? this.text.length : end
      const line = this.text.slice(this.at, until)
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.tag.value) {
        doc.body = this.text.slice(start, this.at)
        if (doc.tabs) doc.body = doc.body.replace(/^\t+/gm, '')
        this.at = end < 0 ? until : end + 1
        return
      }
      this.at = end < 0 ? until : end + 1
    }
    doc.body = this.text.slice(start)
  }

  private substitution(out: Node[][]): boolean {
    const c = this.text[this.at]
    if (c === '$' && this.text[this.at + 1] === '(') {
      this.at += 2
      out.push(this.read(')'))
      return true
    }
    if (c === '`') {
      this.at++
      let body = ''
      while (this.at < this.text.length && this.text[this.at] !== '`') {
        // Legacy substitution removes one escape level before its inner shell reads the command.
        // This makes escaped backticks into a nested substitution, including inside double quotes.
        if (this.text[this.at] === '\\' && '$`\\'.includes(this.text[this.at + 1] ?? '\0')) this.at++
        body += this.text[this.at++]
      }
      if (this.text[this.at] === '`') this.at++
      out.push(new Reader(body).read())
      return true
    }
    return false
  }

  // Heredoc expansion differs from double quoting: quotes in its body are literal, while backslash
  // can escape $, ` and itself. Only an unquoted delimiter enables these substitutions.
  expandHeredoc(): { text: string; substitutions: Node[][] } {
    const substitutions: Node[][] = []
    let text = ''
    while (this.at < this.text.length) {
      if (this.text[this.at] === '\\' && '$`\\\n'.includes(this.text[this.at + 1] ?? '\0')) {
        this.at++
        if (this.text[this.at] !== '\n') text += this.text[this.at]
        this.at++
      } else if (this.substitution(substitutions)) text += '$?'
      else text += this.text[this.at++]
    }
    return { text, substitutions }
  }

  private parameter(substitutions: Node[][], inDouble: boolean) {
    this.at += 2 // ${
    while (this.at < this.text.length && this.text[this.at] !== '}') {
      const c = this.text[this.at]
      if (c === '\\') this.at += 2
      else if (!inDouble && (c === "'" || (c === '$' && this.text[this.at + 1] === "'"))) {
        const ansi = c === '$'
        this.at += ansi ? 2 : 1
        while (this.at < this.text.length && this.text[this.at] !== "'") {
          if (ansi && this.text[this.at] === '\\') this.at++
          this.at++
        }
        if (this.text[this.at] === "'") this.at++
      } else if (c === '"') this.doubleQuoted(substitutions)
      else if (c === '$' && this.text[this.at + 1] === '{') this.parameter(substitutions, inDouble)
      else if (!this.substitution(substitutions)) this.at++
    }
    if (this.text[this.at] === '}') this.at++
  }

  private doubleQuoted(substitutions: Node[][]): string {
    this.at++
    let value = ''
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      if (this.text[this.at] === '\\' && '$`"\\\n'.includes(this.text[this.at + 1] ?? '\0')) {
        this.at++
        if (this.text[this.at] !== '\n') value += this.text[this.at]
        this.at++
      } else if (this.text[this.at] === '$' && this.text[this.at + 1] === '{') {
        this.parameter(substitutions, true)
        value += '$?'
      } else if (this.substitution(substitutions)) value += '$?'
      else value += this.text[this.at++]
    }
    if (this.text[this.at] === '"') this.at++
    return value
  }

  private word(substitutions: Node[][]): Word {
    let value = ''
    let quoted = false
    let tilde = false
    let assignmentKey: string | undefined
    while (this.at < this.text.length) {
      const c = this.text[this.at]
      if (space(c) || boundary(c)) break
      if (c === '\\') {
        quoted = true
        this.at++
        if (this.text[this.at] !== '\n') value += this.text[this.at] ?? ''
        this.at++
      } else if (c === "'" || (c === '$' && this.text[this.at + 1] === "'")) {
        quoted = true
        const ansi = c === '$'
        this.at += ansi ? 2 : 1
        let inner = ''
        while (this.at < this.text.length && this.text[this.at] !== "'") {
          if (ansi && this.text[this.at] === '\\') inner += this.text[this.at++]
          inner += this.text[this.at++] ?? ''
        }
        if (this.text[this.at] === "'") this.at++
        value += ansi ? inner.replace(/\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|[0-7]{1,3}|.)/g, (_m, esc: string) => {
          const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' }
          if (named[esc] !== undefined) return named[esc]
          if (esc[0] === 'x' || esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16))
          return /^[0-7]/.test(esc) ? String.fromCharCode(parseInt(esc, 8)) : `\\${esc}`
        }) : inner
      } else if (c === '"') {
        quoted = true
        value += this.doubleQuoted(substitutions)
      } else if (this.substitution(substitutions)) {
        value += '$?' // its value is unknown; its executable body is already a separate tree
      } else if (c === '$' && this.text[this.at + 1] === '{') {
        this.parameter(substitutions, false)
        value += '$?'
      } else {
        if (c === '=' && !quoted && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) assignmentKey = value
        if (c === '~' && (!value || (value.endsWith('=') && /^[A-Za-z_][A-Za-z_0-9]*=$/.test(value)))) {
          // A quoted or escaped tilde is a literal directory name, including in assignments.
          let end = this.at + 1
          tilde = true
          while (end < this.text.length && this.text[end] !== '/' && !space(this.text[end]) && !boundary(this.text[end])) {
            if ('\'"\\'.includes(this.text[end++])) tilde = false
          }
        }
        value += c
        this.at++
      }
    }
    return { value, quoted, tilde, assignment: assignmentKey }
  }
}

// Lexical POSIX paths suffice here: no filesystem access, variable expansion or globbing. An absolute
// target can restore a known cwd after a dynamic cd; relative targets keep that uncertainty.
function resolveDir(cwd: Dir, word: Word | string, home: string): Dir {
  let target = typeof word === 'string' ? word : word.value
  if (dynamic.test(target)) return null
  if (target.startsWith('~') && (typeof word === 'string' || word.tilde)) {
    if (!/^~(?:\/|$)/.test(target) || !home) return null
    target = home + target.slice(1)
  }
  if (!target.startsWith('/')) {
    if (cwd === null) return null
    target = `${cwd}/${target}`
  }
  const parts: string[] = []
  for (const part of target.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

const envKey = (key: string) => key === 'GIT_DIR' || key === 'GIT_WORK_TREE'
const wrappers = new Set(['env', 'sudo', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'xargs', 'time'])
const wrapperValues: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-a', '--unset', '--chdir', '--argv0']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-R', '-D', '-r', '-t', '--user', '--group', '--host', '--prompt', '--close-from', '--command-timeout', '--chroot', '--chdir', '--role', '--type', '--other-user']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  time: new Set(['-o', '-f', '--output', '--format']),
  exec: new Set(['-a']),
}

// Consume wrapper options once, including their values, before looking for the actual executable.
function executable(words: Word[], ctx: Context, home: string): number {
  let i = 0
  let leading = true
  let envAssignments = false
  while (i < words.length) {
    const arg = words[i].value
    const assigned = ((leading && words[i].assignment) || envAssignments) ? assignment.exec(arg) : null
    if (assigned) {
      if (envKey(assigned[1])) ctx.env[assigned[1]] = { ...words[i], value: assigned[2] }
      i++
      continue
    }
    if (!words[i].quoted && reserved.has(arg)) {
      i++
      continue
    }
    const name = program(arg)
    if (!wrappers.has(name)) return i
    if (name !== 'time') leading = false
    envAssignments = name === 'env' || name === 'sudo'
    i++
    while (i < words.length && words[i].value.startsWith('-') && (words[i].value !== '-' || name === 'env')) {
      const optionWord = words[i++]
      const option = optionWord.value
      if (option === '--') break
      let key = option
      let value: Word | undefined
      const values = wrapperValues[name]
      if (option.startsWith('--')) {
        const equal = option.indexOf('=')
        key = equal < 0 ? option : option.slice(0, equal)
        if (values?.has(key)) value = equal < 0 ? words[i++] : { ...optionWord, value: option.slice(equal + 1) }
      } else {
        // Short flags may be clustered; an option taking a value consumes the rest of the cluster
        // or the next word. Thus -nu bob, -ubob, -n 10 and -n10 all reach the right executable.
        for (let j = 1; j < option.length; j++) {
          key = `-${option[j]}`
          if (name === 'command' && (key === '-v' || key === '-V')) return words.length
          if (name === 'env' && key === '-i') ctx.env = {}
          if (values?.has(key)) {
            value = j + 1 < option.length ? { ...optionWord, value: option.slice(j + 1) } : words[i++]
            break
          }
        }
      }
      if (name === 'env' && (option === '-' || key === '--ignore-environment')) ctx.env = {}
      if (name === 'env' && (key === '-u' || key === '--unset') && value) delete ctx.env[value.value]
      if ((name === 'env' && (key === '-C' || key === '--chdir')) || (name === 'sudo' && (key === '-D' || key === '--chdir'))) {
        ctx.cwd = value === undefined ? null : resolveDir(ctx.cwd, value, home)
      }
    }
    if (name === 'timeout' && i < words.length) i++ // duration
  }
  return i
}

function gitWrite(words: Word[], at: number, ctx: Context, home: string): GitWrite | null {
  let cwd = ctx.cwd
  let gitDir = ctx.env.GIT_DIR
  let workTree = ctx.env.GIT_WORK_TREE
  let i = at
  while (i < words.length) {
    const word = words[i++]
    const arg = word.value
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') {
      i--
      break
    }
    const equal = arg.indexOf('=')
    const key = equal < 0 ? arg : arg.slice(0, equal)
    if (arg === '-C' || (arg.startsWith('-C') && arg.length > 2)) {
      const dir = arg === '-C' ? words[i++] : { ...word, value: arg.slice(2) }
      cwd = dir === undefined ? null : resolveDir(cwd, dir, home)
    } else if (key === '--work-tree' || key === '--git-dir') {
      const dir = equal < 0 ? words[i++] : { ...word, value: arg.slice(equal + 1) }
      if (key === '--work-tree') workTree = dir
      else gitDir = dir
    } else if (arg === '-c' || key === '--namespace' || key === '--config-env' || key === '--super-prefix') {
      if (equal < 0) i++
    }
    // All remaining global flags have no separate value, including --exec-path[=path].
  }
  const action = words[i]?.value
  if (action !== 'commit' && action !== 'push' && action !== 'stash') return null
  if (action === 'stash' && ['list', 'show'].includes(words[i + 1]?.value)) return null
  let repoDir = gitDir === undefined ? undefined : resolveDir(cwd, gitDir, home)
  if (repoDir?.endsWith('.git')) repoDir = repoDir.slice(0, repoDir.lastIndexOf('/')) || '/'
  if (workTree !== undefined) cwd = resolveDir(cwd, workTree, home)
  else if (repoDir !== undefined) cwd = repoDir
  return { action, cwd, dirs: repoDir !== undefined && repoDir !== cwd ? [cwd, repoDir] : [cwd] }
}

function inspect(nodes: Node[], ctx: Context, home: string, writes: GitWrite[], input?: string): string | undefined {
  let piped = false
  let pipeInput: string | undefined
  let output: string | undefined
  let alternative: Context | null = null
  for (const node of nodes) {
    // Each pipeline element and background job has its own directory. Braces share the parent shell;
    // parentheses, substitutions and shell -c do not, even if they contain cd or pushd.
    const local = piped || node.end === '|' || node.end === '&' ? fork(ctx) : ctx
    const before = node.end === '||' ? fork(local) : null
    const incoming = piped ? pipeInput : input
    piped = node.end === '|'
    for (const sub of node.substitutions) inspect(sub, fork(local), home, writes)
    let stdinScript = node.stdin === undefined ? incoming : node.stdin?.body
    for (const doc of node.docs) {
      if (!doc.tag.quoted) {
        const expanded = new Reader(doc.body).expandHeredoc()
        for (const sub of expanded.substitutions) inspect(sub, fork(local), home, writes)
        if (doc === node.stdin) stdinScript = expanded.text
      }
    }
    output = node.kind === 'group'
      ? inspect(node.body, node.isolated ? fork(local) : local, home, writes, stdinScript)
      : inspectSimple(node, local, home, writes, stdinScript)
    if (node.stdout) output = undefined
    pipeInput = output
    if (before) {
      // The right side of cd X || ... runs after a failed cd, in the old directory. After the
      // alternatives rejoin, differing directories/environment values are statically unknown.
      alternative = join(alternative, local)
      Object.assign(local, before)
    }
    if (alternative && node.end !== '||' && node.end !== '&&') {
      Object.assign(ctx, join(alternative, ctx))
      alternative = null
    }
  }
  // Only forward known, unchanged heredoc data (cat, including a single-command group). Arbitrary
  // program output remains runtime-built code, outside the guard's static-command contract.
  return nodes.length === 1 ? output : undefined
}

function inspectSimple(node: Simple, local: Context, home: string, writes: GitWrite[], stdinScript?: string): string | undefined {
  const invocation = fork(local)
  const at = executable(node.words, invocation, home)
  if (at >= node.words.length) {
    // Assignment-only commands persist; assignments in env/sudo invocations do not.
    if (node.words.every((w) => w.assignment)) local.env = invocation.env
    return
  }
  const name = program(node.words[at].value)
  const args = node.words.slice(at + 1)
  if (name === 'git') {
    const write = gitWrite(node.words, at + 1, invocation, home)
    if (write) writes.push(write)
  } else if (name === 'cd' || name === 'pushd') {
    const afterOptions = args.findIndex((w) => w.value === '--')
    const given = afterOptions < 0 ? args.find((w) => w.value === '-' || !w.value.startsWith('-')) : args[afterOptions + 1]
    if (name === 'pushd' && !given) {
      const dir = local.stack?.cwd ?? null
      if (local.stack) local.stack = { cwd: local.cwd, next: local.stack.next }
      local.previous = local.cwd
      local.cwd = dir
      return
    }
    const target = given ?? home
    const dir = typeof target !== 'string' && target.value === '-' ? local.previous : resolveDir(local.cwd, target, home)
    if (name === 'pushd') {
      const noCd = args.some((w) => w.value === '-n')
      local.stack = { cwd: noCd ? dir : local.cwd, next: local.stack }
      if (noCd) return
    }
    local.previous = local.cwd
    local.cwd = dir
  } else if (name === 'popd') {
    if (!args.some((w) => w.value === '-n')) {
      local.previous = local.cwd
      local.cwd = local.stack?.cwd ?? null
    }
    local.stack = local.stack?.next ?? null
  } else if (name === 'eval') {
    const evaluated = fork(invocation)
    const output = inspect(new Reader(args.map((w) => w.value).join(' ')).read(), evaluated, home, writes, stdinScript)
    // Prefix assignments apply while eval runs; directory changes and assignments made by the
    // evaluated code stay in this shell. Restore any temporarily shadowed environment values.
    for (let i = 0; i < at; i++) {
      const key = node.words[i].assignment
      if (key && envKey(key)) {
        if (local.env[key] === undefined) delete evaluated.env[key]
        else evaluated.env[key] = local.env[key]
      }
    }
    Object.assign(local, evaluated)
    return output
  } else if (shells.has(name)) {
    let i = 0
    let inline = false
    let readsStdin = false
    while (i < args.length && args[i].value.startsWith('-')) {
      const option = args[i++].value
      if (option === '--') break
      if (/^-[^-]*c/.test(option)) {
        inline = true
        break
      }
      if (/^-[^-]*s/.test(option)) readsStdin = true
      if (['-o', '-O', '--rcfile', '--init-file'].includes(option)) i++
    }
    if (inline && args[i]) return inspect(new Reader(args[i].value).read(), fork(invocation), home, writes, stdinScript)
    if (!inline && (readsStdin || i === args.length || args[i].value === '-') && stdinScript !== undefined) {
      return inspect(new Reader(stdinScript).read(), fork(invocation), home, writes)
    }
  } else if (name === 'cat' && args.every((w) => ['-', '--', '-u'].includes(w.value))) {
    return stdinScript
  }
}

// A null directory means a recognized write whose location depends on runtime expansion. The hook fails
// closed for that write whenever any session is guarded, without changing which sessions are active.
export function gitWrites(command: string, cwd: string, home: string): GitWrite[] {
  const writes: GitWrite[] = []
  inspect(new Reader(command).read(), { cwd: resolveDir('/', cwd, home), previous: null, stack: null, env: {} }, home, writes)
  return writes
}

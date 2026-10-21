// The pane through the engine's own kit (claude plugin test <plugin folder>): each surface's element table
// validates the tree, which the stand-in engine of tests/mod.mjs cannot. The review is the one the wrapping was
// made for: a file review that another Claude session drives, its titles too long for a docked pane.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/state/codex-duet'
const ID = '20261018-171430-8f3a'
const STATE = JSON.stringify({
  "id": "20261018-171430-8f3a",
  "kind": "file",
  "cwd": "/work/csv-import",
  "owner": "someone-else",
  "subject": {
    "paths": [
      "importer/parse_rows.py",
      "importer/dedupe.py",
      "tests/test_importer_parse_rows.py"
    ]
  },
  "round": 1,
  "maxRounds": 10,
  "phase": "awaiting-author",
  "updatedAt": "2026-10-18T17:24:00.000Z",
  "codex": {
    "model": null,
    "effort": null
  },
  "rounds": [
    {
      "n": 1,
      "verdict": "revise",
      "startedAt": "2026-10-18T17:14:30.000Z",
      "finishedAt": "2026-10-18T17:24:21.000Z",
      "open": 5,
      "usage": {
        "input_tokens": 1080000,
        "output_tokens": 20000
      },
      "codexModel": {
        "model": "gpt-6.1-sol",
        "effort": "max",
        "fromConfig": [
          "model",
          "effort",
          "tier"
        ],
        "tier": "priority"
      }
    }
  ],
  "issues": {
    "C1": {
      "id": "C1",
      "severity": "high",
      "status": "open",
      "title": "Строка с теми же полями в другом порядке проходит проверку, хотя схема требует порядок колонок, и парсер засчитывает её как совпадение",
      "body": "The parser compares column sets, not the order the schema fixes; a reordered row passes.",
      "disputes": 0
    },
    "C2": {
      "id": "C2",
      "severity": "high",
      "status": "open",
      "title": "Непроверенная строка попадает в итоговый файл без повторного прогона validate",
      "body": "The output accepts a parsed row before validate ran over it.",
      "disputes": 1,
      "author": {
        "action": "disputed",
        "note": "validate runs in CI before merge; the importer never writes the output directly"
      }
    },
    "C3": {
      "id": "C3",
      "severity": "high",
      "status": "open",
      "title": "Новая схема проверяется со старой версией словаря колонок",
      "body": "The column dictionary is read once per run.",
      "disputes": 0
    },
    "C4": {
      "id": "C4",
      "severity": "high",
      "status": "open",
      "title": "Средняя доля ошибок по файлам скрывает регрессию отдельных файлов",
      "body": "Use per-file thresholds.",
      "disputes": 0
    },
    "C5": {
      "id": "C5",
      "severity": "medium",
      "status": "open",
      "title": "Фильтр пропускает ID колонок с пробелами по краям",
      "body": "Trim before matching.",
      "disputes": 0
    },
    "C6": {
      "id": "C6",
      "severity": "low",
      "status": "resolved",
      "title": "Опечатка в сообщении об ошибке",
      "body": "typo",
      "disputes": 0,
      "author": {
        "action": "fixed",
        "note": "fixed"
      }
    }
  }
})
const PANE = {
  title: 'Codex Duet', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {},
} as const

const NOW = Date.parse('2026-10-18T17:30:00Z')
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

// Boots the mod over a session folder held in memory, as the runner leaves it on disk (a call on $ is answered
// { value } or { deny }), and draws the pane docked at a narrow width.
async function paneOver($: Engine, on: On, surface: typeof SURFACES[number], files: Record<string, string>) {
  mock.env(on, { CODEX_DUET_HOME: HOME, HOME: '/nonexistent' })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const at = (path: string) => files[path.slice(HOME.length + 1)]
  on('fs.list', ($, e) => ({ value: e.path === HOME ? [{ name: ID, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.stat', ($, e) => (at(e.path) === undefined ? { deny: 'ENOENT' }
    : { value: { kind: 'file' as const, size: at(e.path).length, mtimeMs: NOW - 5000, isLink: false } }))
  on('fs.read', ($, e) => (at(e.path) === undefined ? { deny: 'ENOENT' } : { value: at(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'claude-me' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/csv-import', surface, isInteractive: true })
  await clock.advance(2000)
  return $.ui.mount({
    plugin: 'codex-duet', surface, component: 'Pane', requestId: 'codex-duet', props: PANE,
    viewport: { columns: 44, rows: 60, isFullscreen: true },
  })
}

const LANGUAGES = ['ru', 'en', 'zh'] as const
const TEXT = {
  ru: {
    title: JSON.parse(STATE).issues.C1.title as string,
    foreign: /ведёт другая сессия Claude: строка, тосты и звуки — там, решения отправляй оттуда\.$/,
    disputed: /^Claude \(возразил\): validate runs in CI/,
    runsTests: '  · запускает тесты tests.test_importer_parse_rows',
  },
  en: {
    title: 'A row with the same fields in a different order passes validation even though the schema fixes the column order, and the parser counts it as a match',
    foreign: /^Another Claude session drives this review:/,
    disputed: /^Claude \(disputed\): validate runs in CI/,
    runsTests: '  · runs tests tests.test_importer_parse_rows',
  },
  zh: {
    title: '字段相同但顺序不同的数据行仍然通过验证，尽管架构要求固定的列顺序，解析器却将它视为匹配项，导致不符合规范的数据被接受',
    foreign: /^此审查由另一个 Claude 会话推进/,
    disputed: /^Claude \(有争议\): validate runs in CI/,
    runsTests: '  · 运行测试 tests.test_importer_parse_rows',
  },
}

// GUI sessions may omit every POSIX locale variable; the default option then reads macOS preferences.
for (const [language, appleLanguages] of [
  ['ru', '(\n    "ru-RU",\n    "en-US"\n)\n'],
  ['zh', '(\n    zh-Hans-CN,\n    en-US\n)\n'],
] as const) {
  test(`the default pane uses ${language} from AppleLanguages when locale variables are absent`, async ($, on) => {
    const commands: string[][] = []
    on('process.run', ($, e) => {
      commands.push([...e.argv])
      return { value: { exitCode: 0, stdout: appleLanguages, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await paneOver($, on, 'desktop', { [`${ID}/state.json`]: STATE })
    expect(commands).toEqual([['defaults', 'read', '-g', 'AppleLanguages']])
    expect(await ui.find({ type: 'Text', text: TEXT[language].foreign })).toBeDefined()
    await ui.unmount()
  })
}

for (const language of LANGUAGES) {
  for (const surface of SURFACES) {
    test(`the ${language} pane on ${surface}: long titles drawn whole, an issue unfolds to both sides`, { options: { language } }, async ($, on) => {
      const state = JSON.parse(STATE)
      state.issues.C1.title = TEXT[language].title
      const ui = await paneOver($, on, surface, { [`${ID}/state.json`]: JSON.stringify(state) })
      const title = await ui.find({ type: 'Text', text: TEXT[language].title })
      expect(title).toBeDefined()
      expect(title?.props.wrap).toBe('wrap')
      expect(title?.text.endsWith(TEXT[language].title)).toBe(true)
      if (language === 'ru') expect(await ui.find({ type: 'Text', text: /парсер засчитывает её как совпадение$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: TEXT[language].foreign })).toBeDefined()
      expect(await ui.find({ key: 'fold-closed' })).toBeDefined()
      await ui.press({ key: `fold-${ID}:C2` })
      expect(await ui.find({ type: 'Text', text: TEXT[language].disputed })).toBeDefined()
      await ui.press({ key: 'settings' })
      expect(await ui.find({ key: 'pref-sound' })).toBeDefined()
      await ui.unmount()
    })
  }
}

// A turn that runs: Codex's words as markdown, its plan and commands, on every surface.
const RUNNING = JSON.stringify({ ...JSON.parse(STATE), phase: 'awaiting-codex', updatedAt: '2026-10-18T17:29:00.000Z',
  pending: { round: 2, startedAt: '2026-10-18T17:21:17.000Z' } })
const EVENTS = [
  { type: 'item.completed', item: { id: 'p', type: 'todo_list', items: [{ text: 'Проверить, что парсер не засчитывает пустой файл, когда словарь колонок ещё не прошёл validate', completed: true }, { text: 'dedupe', completed: false }] } },
  { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "/bin/zsh -lc 'python3 -m unittest tests.test_importer_parse_rows'" } },
  { type: 'item.completed', item: { id: 'c1', type: 'command_execution', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '32 теста проходят.\n\nВ новых путях остались вопросы:\n- `dedupe` не учитывает регистр ключей\n- `parse_rows` может завершиться успешно с нулём строк' } },
].map((e) => JSON.stringify(e)).join('\n')

for (const language of LANGUAGES) {
  for (const surface of SURFACES) {
    test(`a running ${language} turn on ${surface}: Codex's words as markdown, the plan wraps, commands named`, { options: { language } }, async ($, on) => {
      const ui = await paneOver($, on, surface, { [`${ID}/state.json`]: RUNNING, [`${ID}/round-2.events.jsonl`]: EVENTS })
      expect(await ui.find({ type: 'Markdown', text: /^Codex: 32 теста проходят\.\n\nВ новых путях остались вопросы:\n- `dedupe`/ })).toBeDefined()
      const plan = await ui.find({ type: 'Text', text: /словарь колонок ещё не прошёл validate$/ })
      expect(plan).toBeDefined()
      expect(plan?.props.wrap).toBe('wrap')
      expect(await ui.find({ type: 'Text', text: TEXT[language].runsTests })).toBeDefined()
      await ui.unmount()
    })
  }
}

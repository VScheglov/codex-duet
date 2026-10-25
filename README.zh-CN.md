[English](README.md) | [Русский](README.ru.md)

# codex-duet

让 Claude 和 Codex 自己协商完成代码审查。Codex 提出问题，Claude 逐项修复、用证据提出异议，或留给你裁决。循环会一直持续，直到双方达成一致、陷入僵局，或用完轮次。不用再在聊天窗口之间复制内容。

也可以反过来：在 **build** 模式下，Codex 编写代码，Claude 担任架构师和审查者。这样主要消耗 Codex 的额度。

为了按你的原话核对工作，审查可使用 `start --brief <file|->` 传入 Markdown，包含 `## Owner's request`（原话，必填）、`## Accepted amendments`（仅限你已接受的修改，并注明来源）和 `## Claimed result`（作者声称达到的结果）。build 的规格本身必须包含第一个章节，可包含已接受的修改；不使用单独的 `--brief`，audit 也不接受 brief。Codex 和批准 build 前的 Claude 分别填写 `request_check`；审查报告需求被缩减，或 build 中双方判断不一致时，会交给你裁决。轮次摘要、`status` 和报告都会显示检查结果。

批准与已审查的 Git 树绑定。build 中的 `finish` 会核对 worktree 和钩子运行后的提交；内容有变时会作为新一轮审查返回，分支上不保留该提交。只有你明确要求时才能使用 `finish --unreviewed` 跳过检查，提交信息和报告会记录这一选择。code 审查后手动提交前，先运行 `verify`；内容有变时，使用输出中的 `reply` 命令交回 Codex 复审。路径标记为 `covered`、`edited-after-review` 或 `never-reviewed`。

## 安装

需要：

- Claude Code 2.1.275 或更新版本；
- 已登录的 [Codex CLI](https://github.com/openai/codex)：`codex` 必须在 `PATH` 中（可以用 `CODEX_DUET_CODEX_BIN` 指定其他可执行文件）；
- Node.js 22 或更新版本：运行器通过 `node scripts/duet.mjs` 启动；
- code 和 build 模式需要 git。

在 Claude Code 终端会话中运行：

```
/plugin install codex-duet --marketplace VScheglov/codex-duet
```

遇到 `Add marketplace?` 时回答 `y`，然后选择作用范围：选择 user 后，插件可用于所有项目。也可以在 shell 中运行：

```bash
claude plugin install codex-duet --marketplace VScheglov/codex-duet
```

在不支持 `/plugin` 的 Claude 应用中，点击输入框旁的 +，依次选择 Plugins、Add marketplace，输入 `VScheglov/codex-duet`，再选择 Add plugin。

如果安装后看不到 `/codex-duet` 和 `/duet`，请新建会话或执行 `/reload-plugins`。技能命令的完整名称是 `/codex-duet:codex-duet`；只要没有其他命令占用同名，简写 `/codex-duet` 就能使用。

**建议：将后台命令的时限设为 12 小时。** Codex 的一轮工作可能很久，因此 Claude 会在后台启动它，并设置 `timeout: 43200000`。如果不调整配置，Claude Code 会将时限截为 2 小时，较长的一轮就会中断（可以通过 `retry` 继续）。为避免这种情况，在 `~/.claude/settings.json` 中加入：

```json
{ "env": { "BASH_MAX_TIMEOUT_MS": "43200000" } }
```

此设置对修改后新开的会话生效。

## 语言

插件的 `language` 设置支持 `auto`、`en`（英语）、`ru`（俄语）和 `zh`（简体中文），默认值为 `auto`。

在 `auto` 模式下，插件依次读取 `LC_ALL`、`LC_MESSAGES`、`LANG`，使用第一个已设置且非空的值。以 `ru` 开头时使用俄语，以 `zh` 开头时使用简体中文，其他值使用英语。

只有当这三个变量均未设置或为空时，macOS 才会读取 `AppleLanguages` 中的第一个首选语言，并按相同的 `ru` / `zh` 规则选择语言。非空的 locale 变量始终优先。其他平台、首选语言列表为空或读取失败时，均使用英语。

要从 shell 将语言设为俄语，请运行：

```bash
echo '{"language":"ru"}' | claude plugin configure codex-duet --values-stdin
```

可以将 `ru` 替换为 `en`、`zh` 或 `auto`。`--values-stdin` 读取一个值为单行字符串的 JSON 对象；对象中未提供的选项保留当前值。不加 `--values-stdin` 时，`claude plugin configure codex-duet` 只显示配置。也可以在 `/plugin` 菜单的插件所在行更改语言。

更改后引擎会自动重新加载模块。此设置控制界面以及模块发送给 Claude 的消息；运行器的输出和策略原因使用英语。

## 平台支持

| 平台 | 支持情况 |
|---|---|
| macOS | 全部功能 |
| Linux | 除声音外的全部功能：Linux 上的 Claude Code 没有音频播放器，但通知和状态条仍可用。如果运行器被 `kill -9` 终止，或随机器一起崩溃，遗留的会话锁需要手动删除；`stale lock` 错误会指出文件位置。在 macOS 上，内核会自动释放这类锁（`O_EXLOCK`） |
| Windows | 不支持：运行器和模块会调用 `kill`、`tail`、`head`、`grep` 和 `diff`。WSL 应当与 Linux 表现相同，但尚未测试 |

如果 Claude Code 由组织管理（managed settings），用户自行安装的插件不会运行 `Stop` 钩子。因此，当 Claude 结束一轮时，模块无法将它带回循环（见“循环不会自行停下”）。其他功能仍可用。

## 使用

```
/codex-duet plan                       plan mode 中的计划或当前对话中的计划
/codex-duet code                       未提交的改动（包括 untracked 文件）
/codex-duet code --base main           从与 main 的 merge-base 开始审查整个分支
/codex-duet file docs/spec.md          任意文件：测试用例、SQL、规格、配置
/codex-duet code -- 检查迁移           `--` 后面是审查重点
/codex-duet status                     当前进度（压缩上下文后也很有用）
```

也可以直接说：“让 Codex 审查代码”“和 Codex 讨论这个计划”。

选项：`--max-rounds N`（默认 10）、`--model`、`--effort`（默认取自 `~/.codex/config.toml`；也可以用自然语言指定模型，例如“交给 Codex，用 astra 模型，max 推理级别”）、`--timeout-min`（Codex 每轮时限；默认不限制）、`--sandbox`（默认 `inherit`，沿用你的 Codex 设置；也可选择 `read-only`）。

运行器会根据你的 Codex 模型缓存（`~/.codex/models_cache.json`）检查模型和推理级别。以下情况会在启动前报错，并列出可用选项：

- 模型不存在（可以填写 ID `gpt-6-astra` 或名称 `GPT-6-Astra`）；
- 推理级别不存在；
- 模型不支持该推理级别，包括 `config.toml` 中设置的默认级别。

没有缓存时会跳过检查。在会话中途也可以更换模型或推理级别：给 `reply`、`review` 或 `retry` 加上 `--model` / `--effort`。轮次摘要中的 `Model:` 行会显示当前使用的配置。

**⚡ Fast。** 没有单独的开关：Codex 从 `config.toml` 读取速度模式（`service_tier = "priority"`，这是模型目录中 Fast 的名称）。只有确定当前一轮使用 Fast 时，输入框上方状态条、任务列表和面板才会出现 ⚡ 标记。标记旁的“来自配置”表示配置启用了 Fast，且模型目录确认该模型支持它。等 Codex 将本轮模式写入线程日志（`~/.codex/sessions/…/rollout-…-<线程>.jsonl` 中的 `thread_settings_applied` 记录）后，这个附注就会消失。如果日志显示普通模式，⚡ 标记也会移除。Codex 0.160 会在每次继续线程的一轮开始时写入该记录，但新线程的第一轮可能没有。

**时间。** Codex 每轮可能花很久，build 尤其如此，因此 Claude 会在后台运行 `start`、`reply`、`review` 和 `retry`，并设置 `timeout: 43200000`（12 小时）。Claude Code 后台命令的时限上限默认是 2 小时，实际为 `max(2 小时, BASH_MAX_TIMEOUT_MS)`。“安装”一节说明了如何提升至 12 小时；该设置也会将前台命令允许设置的超时上限提升至 12 小时。超过 Claude Code 上限的超时值会被静默截断。未明确设置 `timeout` 时，前台命令可运行 2 分钟，后台命令可运行 30 分钟。运行器自身默认不限制每轮时间，可以通过 `--timeout-min N` 设置。0.6.0 之前创建的会话保留了旧的 60 分钟限制；使用 `retry --timeout-min 0` 可以取消限制（`reply` / `review` 也支持）。

**中断的一轮。** 如果 Codex 开始工作后被中断（后台命令超时、点击“停止”或 Codex 崩溃），`retry` 会用简短的“从中断处继续”提示恢复同一个 Codex 线程，第一轮也一样。已完成的工作和已读取的内容仍在 Codex 的上下文中。只要 `~/.codex/sessions` 中的线程日志完整，就能继续；没有日志时会重新开始。`retry --fresh` 则始终重新开始。

**同时处理多个任务。** 可以同时委派多个任务：每个 build 都有独立的 worktree 和分支。同一台机器最多同时运行十轮 Codex（由 `CODEX_DUET_MAX_PARALLEL` 控制），其余任务按入队顺序等待（阶段为 `queued`），空出位置后自动启动。每轮 Codex 都会启动配置中的所有 MCP 服务器，并占用一个配额，因此不限制并发时，十个任务就可能产生数百个进程。只有 Codex 运行时才占用并发名额；Claude 审查期间名额会释放。排队时间计入后台命令的两小时时限，所以最好一次安排几个任务，而不是几十个。

## build 模式：Codex 编写，Claude 审查

```
/codex-duet build                     “交给 Codex……” “让 Codex 实现……”
```

1. Claude 编写规格：目标、范围、约束、验收标准和验证方法。
2. 运行器从 HEAD 创建独立 worktree 和分支 `codex-duet/<id>`。你的工作区不会被改动，Codex 看不到未提交的内容。
3. Codex 实现功能、运行测试，并报告完成了什么、验证了什么、还有哪些疑问。
4. Claude 查看本轮 diff，亲自在 worktree 中运行测试，并提出 C1…Cn 等问题。Codex 修复或提出异议。停止策略与审查模式相同，僵局会交给你裁决（也会显示在 `/duet` 面板中）。
5. 达成一致后，经你同意，`finish` 会将改动提交到分支并删除 worktree；分支由你自己合并。`discard` 会同时删除 worktree 和分支。

给 Claude 的详细说明在 `references/build.md` 中。

在 review 和 build 中，DONE 旁会显示验证标签：`executed`（所有检查均已确认，无跳过项或覆盖缺口）、`partial`（部分已确认，覆盖不完整）、`static-analysis-only`（无已确认检查）或 `unknown`（旧回复）。验证记录将声明的命令与保存的事件对照，在摘要、`report.md` 和 `/duet` 中显示结果、跳过原因、未确认或与事件矛盾的声明及覆盖缺口。已确认的失败也可标为 `executed`；标签不改变停止决定，也不包含 Claude 在 build 审查中自行运行的检查。

## audit 模式：Codex 只检查，不修改

```
/codex-duet audit                     “用 Codex 做审计……” “让 Codex 检查……并给出报告”
```

这是一次性报告，不进行协商，适合审计代码、数据、基准或策略。因此 Claude 不必消耗 token 逐条回复。如果没有你的 `APPROVED` 就不能修改基准，审查模式并不合适：几乎所有问题都会交给你。build 也不合适，因为审计不应修改任何内容。

1. Claude 编写任务：检查什么、回答什么问题、范围、哪些内容算发现，以及哪些内容应放入备注（评分、表格）。
2. Codex 直接在项目目录中工作，始终使用 read-only 沙箱；运行器会拒绝其他 `--sandbox` 值。提示词也禁止通过 MCP 工具写入，但这是指令层面的保护，不是沙箱限制（见“安全”）。
3. 只执行一轮。输出包括结论、A1…An 等发现（严重程度、位置、证据、建议、置信度），以及检查过和未检查的内容。摘要中每个发现占一行，其余内容保存在会话的 `report.md` 中。
4. 无需逐项回复：audit 模式不接受 `reply` 和 `review`。如果需要换个角度，请用更明确的任务新建审计。发现仍然只是 Codex 的判断；Claude 在采用前应验证相关发现，或说明它们尚未验证。

排队、面板（`/duet` 显示结论和发现）、⚡ Fast、每轮 12 小时时限，以及通过 `retry` 继续中断线程的行为，都与其他模式相同。

## 协商过程

```
start ─► Codex：问题 C1…Cn（符合 schema 的 JSON）
          │
          ▼
   Claude 逐项回复：fixed · disputed · needs-user
          │
reply ─► Codex（同一会话，resume）：resolved · withdrawn · open + 反驳 · 新问题
          │
          ▼
   scripts/policy.mjs → continue · done · escalate（僵局 → 你来裁决）
```

- 每个问题都有固定 ID。Codex 能看到 Claude 的回复和轮次之间的 diff。
- 如果你裁定保留当前版本（`owner-decided`），该问题就会关闭，即使 Codex 不同意。
- 用完轮次时，无论策略如何判断，都会升级交给你处理。
- Claude 不会提交任何改动。

## 停止策略（`scripts/policy.mjs`）

规则按从上到下的顺序检查，采用第一个匹配项：

1. Claude 将严重程度为 critical/high 的问题留给用户（`needs-user`）→ 立即 **escalate**。
2. Codex 给出 `approve`，且没有未关闭的 critical/high 问题 → **done**。Medium/low 问题写入报告，其余待用户决策的问题交给你。
3. Codex 对同一问题两次拒绝异议 → **escalate**（僵局）。
4. 连续两轮未关闭的问题数量没有减少 → **escalate**（停滞）。
5. 其他情况 → **continue**。

阈值由 `MAX_DISPUTES` 和 `STALL_ROUNDS` 常量定义。修改规则时，也请更新 `tests/run.mjs` 中的 `policy …` 测试。

## `/duet` 面板与保护措施

插件包含一个 Claude Code 模块（`hooks/register.tsx`）。它每 2 秒读取一次会话文件，显示由**当前** Claude 会话负责的审查：运行器会将调用它的 Claude 会话 ID（`CLAUDE_CODE_SESSION_ID`）写入状态，并在每轮更新。从另一个会话继续审查时，第一次 `reply` 或 `retry` 就会转移归属。其他会话的审查只在 `/duet` 面板中显示，带有标记且没有决策按钮；不会显示其状态条、页脚、通知或播放声音。0.6.0 之前创建、没有归属标记的审查，仍像以前一样在所有会话中显示。

| 位置 | 内容 |
|---|---|
| **面板** `/duet` | 有多个任务时，顶部显示任务列表（⏳ 运行中、⏸ 排队中及队列位置、🙋 等待你、✅ 已完成，以及计时器和模型），点击一行可打开任务详情；接着显示本轮阶段和计时器，模型与推理级别，以及本轮使用 Fast 时的 ⚡ Fast；当前 Codex 命令，或事件流沉默超过两分钟时显示“思考了 N 分钟”，以及“Codex 日志在 N 秒前更新”：即使 Codex 没有发出消息，线程日志仍可能增长；完整显示 Codex 的最近消息，包括段落、列表和 `代码`（按 markdown 渲染），超过两分钟时显示消息时间，同时显示动作（例如“正在运行测试……”或“正在运行 Python 脚本”）；Codex 的计划；问题看板（● 未关闭、⏸ 待决策、✓ 已修复、↩ 已撤回、⚔×N 次争议），附带“已关闭 N / M”进度条：标题会换行并对齐，不会截断，点击问题前的 ▸ 可展开双方意见，有未关闭问题时，已关闭的问题默认折叠；计分板和轮次历史；“停止”按钮（也能停止排队中的一轮）；底部折叠的“设置”。面板文字会根据宽度换行，只有任务列表行和 Codex 命令会被截断 |
| ↳ 升级处理时 | 显示 Codex 和 Claude 的立场，以及 [Codex 正确] / [Claude 正确] 按钮，再通过“将决定发送给 Claude”提交 |
| **输入框上方状态条**与状态行 | 阶段、计时器和 Codex 当前动作；其他模块的状态条保留在其下方 |
| **页脚** | 类似“Duet r3 ⏳ 4:12”的标签，点击可打开面板；即使关闭输入框上方状态条也会显示 |
| **通知** | 一轮开始和结束、升级处理、失败；每轮结束后提供“继续 codex-duet”提示（Tab） |
| **声音** | 升级处理（需要你裁决）、审查结束、某轮失败或 Codex 进程消失时播放；Claude 工作期间不播放声音。使用 Claude 应用内置的 `tool_approval_needed`、`enter_voice_mode`、`disconnected` 提示音，直接从应用播放，不复制到插件中。没有应用时使用 `sounds/` 中的备用声音 |

**循环不会自行停下。** 如果会话正在等待 Claude 工作（回复问题，或在 build 模式下检查 Codex 本轮结果），而 Claude 结束了当前回合，模块会通过 `Stop` 钩子将它带回循环一次。以下情况不会触发：

- Claude 向你提了问题；
- 你发送了一条消息，Claude 只回复了该消息，没有推进循环；
- 有后台任务正在运行，或会话已安排唤醒；
- 会话正在等待你的裁决（升级处理）；
- Claude 刚刚已被带回循环。

自动继续和摘要只在负责该审查的 Claude 会话中生效。

code 审查或 build 进行期间（最后一轮之后的 12 小时内视为活跃），任何 Claude 会话都不能在该仓库中执行 `git commit`、`push` 或 `stash`（build 模式下限制作用于其 worktree）。在审查项目中，你的消息会附带会话摘要，以便 Claude 在压缩上下文后仍能继续循环。后台任务通知不会附带摘要，因为运行器输出已经包含所需内容。

命令：`/duet` 打开面板；`/duet stop` 停止当前一轮（之后可以通过 `retry` 继续）；`/duet band|toasts|score|sound on|off` 开启或关闭界面的对应部分（面板底部折叠“设置”中的按钮作用相同）；`/duet sound test` 或“▶ 声音”按钮依次播放三种提示音。模块不会写入会话文件，只会留下一个用于调试的单行 `.ui-trace.json` 文件。

## 安全

- Codex 使用**完整的运行环境**：你的配置、模型、effort、所有 MCP 服务器、apps 和技能。
- 默认**继承**沙箱设置（`--sandbox inherit`）：Codex 拥有与你平时使用 Codex 时相同的能力，例如运行测试。明确指定的模式（`read-only`、`workspace-write`、`danger-full-access`）会应用于每一轮：启动时使用 `-s`，`resume` 时使用 `-c sandbox_mode=…`，因为 `resume` 没有 `--sandbox` 参数。
- 禁止在审查中修改文件、提交或更改外部系统，是**提示词中的指令，而不是沙箱限制**。如果使用 `inherit`，而你的配置为 `danger-full-access`，无人值守的代理就有完整访问权限。因此审查外部代码（第三方 PR、下载的文件）时，请使用 `--sandbox read-only`。
- **沙箱不限制 MCP 工具。** 审查者可以使用与你的 Codex 相同的 MCP，包括能写入外部系统（例如生产数据库）的工具。提示词明确禁止通过任何工具修改内容，但这只是指令层面的保护，不是沙箱限制。
- **钥匙串与替换 `HOME`（macOS）。** 如果把 `HOME` 指向临时目录后启动程序（`claude`、`gh`、git 凭证助手、`security`），程序会找不到 macOS 钥匙串，每次尝试登录都会弹出“找不到钥匙串”的系统对话框。这些窗口会一直保留，直到被关闭。遇到这类窗口请点击“取消”：“重设为默认设置”会创建新的空钥匙串来替代你的钥匙串。链接到 `~/Library/Keychains` 虽然能消除弹窗，却会把整个钥匙串交给程序，其内容可通过 securityd 修改。因此，Codex 的 build 和审查提示词，以及 SKILL.md 中给 Claude 的规则，都要求通过环境变量提供凭证：`CLAUDE_CODE_OAUTH_TOKEN`（由 `claude setup-token` 创建）或 `GH_TOKEN`。没有凭证时必须询问用户。例如，曾在负责 build 的 Claude 会话中进行 `claude -p` 冒烟测试时触发此类弹窗；Codex 本身并未运行 `claude` 或 `security`。

## 文件布局

| 路径 | 内容 |
|---|---|
| `.claude-plugin/` | `plugin.json` 是插件清单；`marketplace.json` 是仅包含本插件的市场清单，用于安装 |
| `SKILL.md`、`references/protocol.md`、`references/build.md` | 给 Claude 的指令 |
| `scripts/duet.mjs` | 运行器：调用 Codex、问题记录、快照和输出 |
| `scripts/policy.mjs` | **你的**停止策略 `decideNextStep` |
| `prompts/`、`schemas/` | 审查者提示词和回复的 JSON schema |
| `hooks/register.tsx`、`types/index.d.ts` | 模块：面板、状态条、页脚、通知、声音、自动继续循环、提交保护和上下文摘要 |
| `hooks/locales/en.ts`、`hooks/locales/ru.ts`、`hooks/locales/zh.ts` | 英语、俄语和简体中文文本；英语表定义键的契约 |
| `README.md`、`README.ru.md`、`README.zh-CN.md` | 英语、俄语和简体中文说明 |
| `sounds/` | 没有 Claude 应用时使用的备用声音；运行 `node sounds/make.mjs` 可重新合成 |
| `tests/` | `run.mjs`：运行器和策略；`mod.mjs`：使用模拟引擎测试模块；`pane.test.tsx`：使用真实引擎测试面板 |
| `~/.local/state/codex-duet/<id>/` | 会话：`state.json`、各轮提示词和回复、`report.md` |

可以在 Codex 中通过 `codex resume <thread id>` 打开审查者的完整推理过程，线程 ID 见报告。

## 环境变量

| 变量 | 用途 |
|---|---|
| `CODEX_DUET_MODEL`、`CODEX_DUET_EFFORT` | 默认模型和 effort |
| `CODEX_DUET_TIMEOUT_MIN` | Codex 每轮时限，单位为分钟（默认 0，即不限制） |
| `CODEX_DUET_MAX_PARALLEL` | 同一台机器上同时运行的 Codex 轮次数（默认 10），其余排队 |
| `CODEX_DUET_SANDBOX` | 默认沙箱模式（`inherit`） |
| `CODEX_DUET_HOME` | 会话存储位置 |
| `CODEX_DUET_POLICY` | 替代的策略文件（测试使用此方式） |
| `CODEX_DUET_CODEX_BIN` | 替代的 codex 可执行文件（测试使用此方式） |

## 测试

```bash
node tests/run.mjs
node tests/mod.mjs
claude plugin test .
claude plugin validate .
```

在插件目录中运行。GitHub Actions（`.github/workflows/tests.yml`）也会在 macOS 和 Linux 上执行 `run.mjs` 和 `mod.mjs`。

`run.mjs` 使用模拟 Codex（`tests/fake-codex.mjs`）验证运行器：问题记录、争议、升级处理、`retry`、`resume` 时的 read-only、轮次之间的 diff，以及策略的英语原因消息。

`mod.mjs` 转译真实的 `hooks/register.tsx` 及其静态导入的本地文件，在模拟引擎（`tests/mod-engine.mjs`）中运行其钩子。测试会话由 `duet.mjs` 使用同一个模拟 Codex 创建。测试覆盖面板、状态条、页脚、通知、声音、自动继续循环、提交保护和摘要，也验证默认英语、显式语言设置、自动识别 locale 及其优先级、macOS 首选语言回退和读取失败时使用英语、上下文摘要、Stop 提醒、提交保护的拒绝消息、决策消息和三种语言表的键一致性。转译需要 esbuild（全局 `tsx` 内附的版本也可以）或 `typescript`；可通过 `ESBUILD` 或 `TYPESCRIPT` 指定路径。模拟引擎能捕获逻辑错误，却不能发现对 API 的误解：新增引擎调用时，请核对 `claude-code.d.ts` 并运行 `claude plugin validate`。这一思路来自 plan-progress（[zycck/claude-mods](https://github.com/zycck/claude-mods)）。

`tests/pane.test.tsx` 通过引擎自带的测试套件（`claude plugin test`），在 terminal、desktop 和 mobile 三种界面中以英语、俄语和简体中文绘制面板。每种界面的元素表都会验证渲染树，这是模拟引擎做不到的。审查会话保存在测试内存中；测试检查长标题和其他会话的标记是否完整可见、问题能否展开，以及 Codex 的消息是否按 markdown 渲染。面板宽度为 44 列，也用于检查双列宽的中文字符能否正确换行。

## Codex CLI 的注意事项（0.159）

- 当 stdin 不是终端时，`codex exec` 会等待 stdin 的 EOF，期间看起来像是无声挂起。运行器会通过 stdin 传入提示词，然后关闭它。
- `codex exec resume` 不接受 `--sandbox`、`--cd` 或 `--color`。
- `-c 'mcp_servers={}'` 不能关闭 MCP：配置值会合并，而不是替换。
- `codex mcp list --json` 会**不加掩码**地输出服务器的环境变量，包括 token。

## 开发

Claude Code 会自动将 `~/.claude/skills/codex-duet` 中的克隆加载为 `codex-duet@skills-dir`，无需安装。修改会在新会话中生效。此时不要再从市场安装同一个插件：已安装的插件会覆盖 skills-dir 中的同名插件，克隆会显示为“Not loaded”。

## 禁用或卸载

```bash
claude plugin disable codex-duet@codex-duet
claude plugin uninstall codex-duet@codex-duet
```

`~/.claude/skills` 中的克隆也可以用相同方式禁用，名称改为 `codex-duet@skills-dir`；删除时直接移除文件夹即可。

## 许可证

MIT，见 [LICENSE](LICENSE)。

# superun-ai-cli

[English](README.en.md) | [中文](README.md)

通过需求梳理、架构设计与开发协作，将网站和应用的想法转化为可持续迭代、可部署运维的生产级系统。

人和自动化程序使用同一组命令；业务结果以 JSON 输出。

## 安装

需要 Node.js 22 或更新版本，以及 npm。

> 已发布到 [npm](https://www.npmjs.com/package/superun-ai-cli)，默认通过 npm 安装，无需克隆源码或自行编译。

### 🤖 通过 AI Agent 安装配置（推荐）

把下面这段话发给 Claude Code、Codex 或其他 AI 编码 Agent，它会根据[安装指南](INSTALL.md)检查环境、安装 CLI，并引导你完成登录与验证：

```text
请阅读 https://raw.githubusercontent.com/AiGuangInc/superun-ai-cli/refs/heads/main/INSTALL.md，帮我安装并配置 superun-ai-cli。请通过 npm 安装，登录 Superun 时让我在浏览器完成操作，不要索取或展示 PAT 明文。
```

如果 Agent 已经打开本仓库，也可以直接让它阅读根目录的 `INSTALL.md`。

### 手动安装

```bash
npm install -g superun-ai-cli --registry=https://registry.npmjs.org
```

`-g` 表示全局安装。全局命令目录在 `PATH` 中时，可以在任意目录使用 `superun-ai`。安装公开包不需要 npm 发布账号；安装后登录的是 Superun 账号。

安装包名为 `superun-ai-cli`，使用时的命令名为 `superun-ai`。

### 可选：从源码安装

需要修改 CLI 源码时，可以使用 Git 克隆仓库并构建：

```bash
git clone https://github.com/AiGuangInc/superun-ai-cli.git
cd superun-ai-cli
npm ci
npm run build
npm install -g .
```

如果本地已有仓库，请使用已有目录，不要覆盖未提交的改动。构建会先清理 `dist` 再生成产物；全局命令若链接到源码目录，应保留该目录。

## 一键发布 npm

先提交当前改动，在 `main` 分支执行：

```bash
npm run release
```

脚本先显示上一版本，通过 `npm whoami` 验证 npm 登录状态；认证未通过时自动进入 `npm login`，登录后再次验证，失败则在递增版本前停止。认证通过后执行 `npm version patch`、显示本次版本、发布到 npm 的 `latest` 标签，最后执行 `git push origin main --follow-tags`。`npm version patch` 会自动更新版本文件并创建 Git 提交及标签；`npm publish` 沿用已有 `prepack`，自动进行类型检查和构建。登录有效不等于拥有包发布权限，请使用有发布权限的账号；若账号启用双重验证，npm 可能要求输入验证码。

任何一步失败都会停止。npm 未确认成功时，先查询该版本的远端状态；若已经发布成功但 Git 推送失败，只补执行 `git push origin main --follow-tags`，不要重新运行脚本。发布到 `latest` 后，现有 CLI 用户会按内置更新逻辑升级。

## 查看帮助

安装完成后，单独执行以下命令查看帮助；这些命令不会发起登录或创作：

```bash
superun-ai --help
superun-ai chat --help
superun-ai chat style generate --help
```

## 命令树

下面列出完整命令层级、位置参数和用途。`<...>` 表示需要替换的必填位置参数；选项参数及其要求可通过各命令的 `--help` 查看。

```text
superun-ai
├── auth                                         # 管理 PAT 登录
│   ├── login                                    # 登录 Superun 并保存 PAT
│   ├── status                                   # 查看本地 PAT 配置状态
│   └── logout                                   # 清除本地 PAT
├── session                                      # 查询项目
│   ├── list                                     # 查询项目列表
│   └── get <sessionId>                          # 查询项目详情
├── chat                                         # 对话创作
│   ├── create                                   # 新建项目并发送需求
│   ├── send <sessionId>                         # 继续项目创作
│   ├── test <sessionId>                         # 自动测试已有功能并修复确认的问题
│   ├── review <sessionId>                       # 审查已有代码并修复确认的问题
│   ├── state <sessionId>                        # 查询当前任务和交互
│   ├── wait <sessionId>                         # 等待当前交互或任务结果
│   ├── stop <sessionId>                         # 停止远端任务
│   ├── style                                    # 管理创作风格
│   │   ├── generate <sessionId>                 # 生成风格候选
│   │   ├── list <sessionId>                     # 查询全部风格批次
│   │   └── select <sessionId> <choiceId>        # 选择风格并自动生成研发规划
│   ├── demo <sessionId>                         # 查看演示快照并记录已查看状态
│   ├── develop <sessionId>                      # 保留演示，进入研发并生成规划
│   ├── interaction                              # 回答或跳过交互
│   │   ├── reply <sessionId> <interactionId>    # 提交回答
│   │   └── skip <sessionId> <interactionId>     # 跳过当前交互
│   ├── plugin                                   # 查询、启用和禁用插件
│   │   ├── list <sessionId>                     # 查询可用插件
│   │   ├── status <sessionId> <pluginId>        # 查询插件状态
│   │   ├── enable <sessionId> <pluginId>        # 启用插件
│   │   └── disable <sessionId> <pluginId>       # 禁用插件
│   └── publish                                  # 发布应用和管理站点状态
│       ├── status <sessionId>                   # 查询发布版本与部署进度
│       ├── start <sessionId> <encryptedId>      # 发布指定版本
│       └── visibility <sessionId> <visibility>  # 设置站点上线或下线状态
├── update                                       # 检查并安装指定版本
└── version                                      # 显示本地版本与输出协议版本
```

## PAT 登录

```bash
superun-ai auth login
superun-ai auth status
superun-ai auth logout
```

已有 PAT 时，`auth login` 直接复用；没有时自动打开 Superun 网页，完成登录后领取 PAT 并保存到本地，无需手动复制。首次在交互终端执行业务命令时，如果没有 PAT，也会自动进入同一登录流程，完成后继续执行原命令。

网页登录最多等待 5 分钟，按 Ctrl+C 可取消。浏览器未自动打开时，可以手动打开终端提示的地址。网页登录 Token 只用于申请 PAT，不会保存到本地。

如果已经有 PAT，也可以手动导入：

```bash
superun-ai auth login --pat
```

`--pat` 会在终端隐藏读取输入，即使已设置 `SUPERUN_PAT` 也会要求重新输入。它是输入方式开关，后面不能直接跟 PAT 明文，并且不能与 `--stdin` 同时使用。

自动化脚本中缺少 PAT 时会报错，不会自动打开浏览器。可以设置 `SUPERUN_PAT`，也可以通过标准输入登录：

```bash
printf '%s\n' "$SUPERUN_PAT" | superun-ai auth login --stdin
```

凭据优先级为 `SUPERUN_PAT` 环境变量，其次是 `~/.config/superun-ai-cli/credentials.json`。文件权限为 `0600`；退出登录只清除本地保存的凭据，不撤销服务端 PAT。请勿将 PAT 写进命令行参数、仓库或日志。

`auth status` 只查看本地凭据配置，不会打开浏览器或申请 PAT。返回 `CONFIGURED` 表示本地已配置凭据；已有 PAT 是否有效、是否有权访问项目，会在实际业务请求时校验。PAT 过期、禁用或本地文件损坏时会报错，不会自动重新登录或覆盖凭据。

`auth logout` 会删除本地保存的 PAT，下次使用时重新登录。若设置了 `SUPERUN_PAT`，环境变量仍然有效，需要在终端手动清除：

```bash
unset SUPERUN_PAT
```

帮助、`version`、`update` 和清除本地凭据的 `auth logout` 不要求已有 PAT。提供 `SUPERUN_PAT` 即可直接调用业务命令，无需重复执行登录命令。

## 常用命令

```bash
superun-ai session list --limit 20
superun-ai session get <sessionId>
superun-ai chat create --message "为咖啡店制作一个活动网站"
superun-ai chat send <sessionId> --message "增加会员权益介绍"
superun-ai chat state <sessionId>
superun-ai chat wait <sessionId> --timeout 120
superun-ai chat stop <sessionId>
```

写命令支持 `--no-wait`：请求被接受后立即返回。`chat wait` 等待到需要输入、需要选择或任务结束；达到本地等待时限后返回当前状态和 `waitTimedOut: true`，可以继续查询。按 Ctrl+C 只结束本地等待；远端停止需要显式执行 `chat stop`。

聊天任务的响应还包含 `taskProgress`。当前用户已确认规划的研发阶段，`tasks` 优先展示功能和内部步骤：从 Glow 同源的 `internal/features.json`、`internal/todos.json` 独立读取，按真实 `featureId` 关联；`steps` 保留步骤原文、顺序和 `pending / in_progress / completed` 状态，`stepProgress` 返回实际完成数和总数。与 Glow 的开发中列表一致，只展示 `checked=true` 且未完成的功能，执行中优先、同状态保持服务端顺序。历史已完成项及其步骤不进入当前进度；已选但等待中的功能只显示标题和状态，不展开旧 Todo。未关联功能的旧版 Todo 不混入其他功能；执行中尚无步骤时明确提示，不显示虚构的 0/0。不再展示“执行详情”和重复的主任务、子任务表格，过程卡也不展示工具次数。整轮状态为 `COMPLETED` 后，保持原来的完成回复：原样展示 `messages` 中的完成说明，保留预览链接、“继续创作 / 上线运营”等原有引导，不用步骤表或结束卡片替代。只在完成说明后补充 `toolUsage.markdown`（如“已生成：10 次工具调用”），次数与 Glow 完成气泡同源，读取当前轮 `activity.summary.toolCount`，不累加子任务次数，也不拆分读取、修改或部署次数；统计缺失时明确提示不可用。

其他阶段的 `tasks` 保留主任务、咨询、后台任务和风格方案。研发阶段查询成功但没有开发中功能时返回空列表，不回填上一轮已完成任务。后台任务按身份去重，其他成员或归属未知的后台任务仅展示状态。`markdown` 是可直接展示的进度卡，`revision` 标识可见步骤和状态的变化（工具次数变化不影响进度卡版本），父消息未变化时仍独立刷新功能进度。读取失败或数据损坏时使用执行状态兜底，并通过 `complete: false` 和 `warnings` 明示；不把缺失步骤当作完成，也不估算百分比。

`chat wait` 及写命令的默认等待期间，每轮查询的进度都通过 stderr 逐行输出 JSON 事件：`event: "task_progress"`，卡片位于 `data.taskProgress.markdown`。接入 Agent 应持续读取运行中命令的输出并展示全部任务；支持原位更新时按 `taskProgress.id` 更新同一张卡，否则每次展示当前快照，即使 `changed: false` 也不省略。进度事件不是最终结果，应继续等待当前进程，不中断或重新提交任务。stdout 仍只输出一次命令结果。

顶层在认证完成、进入等待型业务命令后启动独立的通用定时器，每隔 5 分钟通过 stderr 输出 `task_reminder`，固定文案为“任务还在进行中，可以去 superun.ai 查看详情。”。接入 Agent 应立即原样展示 `data.message`，将 `superun.ai` 链接到 `data.url`；同一 `data.id` 去重，不同 ID 即使文案相同也要再次展示。进度更新不重置计时；命令返回结果（包括需要用户回答、本地等待超时）、报错或中断时统一清理定时器。计时范围为当前 CLI 持续等待的进程，重新启动进程会重新计时。定时器只输出提醒，不参与业务查询、状态判断、超时或重试；`--no-wait` 和只读查询不会启动定时器，业务命令无需额外参数。

需要用户回答或选择时停止计时，用户处理问题的时间不计入下一轮等待。使用 `--input -` 等待输入需求或回答期间也不启动定时器；输入完成并继续执行后重新从 0 计时。

整体结束判断沿用原有会话、消息、交互和后台工作状态逻辑，`taskProgress` 仅用于展示；单项完成或进度卡更新不会结束等待，也不以进度条目数量推断整轮完成。原有单个风格方案就绪提示、本地等待超时及用户问答行为保持不变。`--progress-revision` 可传入上次版本用于计算 `changed`，但不抑制每次查询的进度输出；`chat state` 与 `chat style list` 同样支持该参数。

默认连接 Superun 服务。全局参数 `--endpoint <URL>` 可指定 API 地址，`--locale <language>` 可指定响应语言。

## 回答交互

当返回 `NEEDS_INPUT` 时，读取 `interactions` 中的问题、允许的 `actions` 和 `answerSchema`。每次回复都使用该结果中的 `interactionId`。

```json
{
  "action": "SUBMIT",
  "answers": [
    { "questionId": "q0", "selectedIndices": [0], "otherValue": "" }
  ]
}
```

```bash
superun-ai chat interaction reply <sessionId> <interactionId> --input ./answer.json
superun-ai chat interaction skip <sessionId> <interactionId>
```

选择下标从 `0` 开始。只有交互声明支持 `SKIP` 时才可跳过。需求问卷答齐后直接生成风格，`action` 可省略或填写 `GENERATE_STYLES`；上面的 `SUBMIT` 示例适用于普通问答。阶段交接、数据库变更确认等交互应使用各自返回的动作。

密钥输入使用 `{"values":{"请求的键名":"密钥值"}}`，只提交当前交互要求的键；内容不会回显。过期或存在歧义的交互会被拒绝，请重新查询状态。

`chat interaction reply --no-wait` 控制回答处理完成后的创作等待。部分插件配置需要在前台等待配置结束并提交交互结果，这一步不会因该选项被省略；中断后应先查询插件与会话状态。

## 自动测试

自动测试验证指定 Superun 项目中的已有功能。发现确认的产品问题后，先在对话中告知，再自动修复并汇报。每次聚焦一个具体流程；测试环境异常、疑似问题和未覆盖范围会如实说明。

```bash
superun-ai chat test <sessionId>
superun-ai chat test <sessionId> --message "验证登录和退出流程"
superun-ai chat test <sessionId> --input ./test-scope.json --no-wait
superun-ai chat wait <sessionId> --timeout 120
superun-ai chat state <sessionId>
```

不传内容时发送“帮我测一下刚才完成的功能。”；`--message` 与 `--input` 只能选一个，JSON 形状与 `chat send` 相同，支持附件。指定内容原样发送，空白内容会被拒绝。测试使用 `business_type=auto_test`，默认等待测试、结果回传及必要的修复结束；运行中不得重复发起。探索阶段和待回答交互先按当前流程处理。

每次研发完成后，引导用户选择“代码审查 / 自动测试 / 继续创作 / 上线运营”。用户明确要求“自动测试”“测一下刚才的功能”后直接调用；指定范围时将原文作为内容提交。讨论是否需要测试不等于要求执行。普通主动调用不承诺免费。

结果中的 `autoTest.phase` 区分 `test` 与后续 `repair`，`autoTest.reportMessages` 保留本次最新报告，`messages` 保留对话内容。`autoTest.sourceMessageId` 用于后续回复来源校验；`previousReportMessages` 如有返回，仅用于追溯上一份报告的编号和问题，不能替代本次结果。会话 `COMPLETED` 只表示操作结束，不表示测试通过。CLI 不从正文关键词推断结构化通过数或修复状态，由接入 Agent 依据实际报告按以下规则展示。

有问题时统一使用模板，数字与详情必须有实际依据，缺失时如实说明，不补零：

> 本次自动测试发现 **2 个问题，已修复 1 个，未修复 1 个**。
>
> 1. **退出后仍可访问个人页面**：已修复，退出后访问个人页面会跳转登录页。
> 2. **登录失败时没有错误提示**：未修复，原因：……。

`nextActions.when` 是候选动作的展示及执行条件。接入 Agent 必须根据当前报告筛选，只向用户展示符合条件的引导，不能将所有候选命令直接列成菜单：

| 实际结果 | 后置引导 |
| --- | --- |
| 测试有效完成，没有问题；或全部修复且复测通过 | 说明实际范围和验证结果，再说“接下来，你可以继续完善项目，或上线运营。”，展示“继续创作 / 上线运营” |
| 全部修复，尚未复测 | 逐项列出修复的功能，再说“以上问题已全部修复，尚未复测。接下来，你可以验证修复结果、继续完善项目，或上线运营。”，展示“自动测试 / 继续创作 / 上线运营” |
| 仍有未修复问题，包括一个都没修复 | 列出修复详情和未修复原因，只引导“修复剩余问题”“修复第 X 项”或用户的具体修改要求 |
| 需要确认业务规则或补充信息 | 只提出具体问题，等待回答；有结构化交互时使用 `chat interaction reply` |
| 测试异常，没有有效结论 | 说明原因，只引导解决阻碍，或者在可重试时回复“重试自动测试”；不提示通过 |
| 本次承诺范围只完成一部分 | 列出已测和未测流程，只引导指定剩余流程继续验证；范围之外的功能不当作本次未完成 |

存在未修复问题、待确认事项、测试阻碍或结论不明时，不展示“继续创作 / 上线运营”。没有复测证据就不能说复测通过。正常完成时固定出口为：

> - **继续创作**：直接告诉我想新增或调整的内容。
> - **上线运营**：回复“上线运营”。

用户回复“修复第 2 项”“修复剩余问题”或补充处理要求时，按返回的 `AUTO_TEST_FOLLOW_UP` 命令原样提交内容，保留源报告编号；后续修复走普通对话，不重新发起自动测试：

```bash
superun-ai chat send <sessionId> --test-followup <sourceMessageId> --message "修复第 2 项"
```

报告已经被后续对话替换时会拒绝旧来源，需重新查询。修复后继续使用上述结果模板和条件引导；用户要求新增或调整功能时，使用普通 `chat send`，不携带 `--test-followup`。用户选择“上线运营”时，沿用 `chat publish status --for-launch` 的发布流程。

自动测试与修复的等待期间，除了 `task_progress`，stderr 还会输出 `conversation_message` 事件，`data.messages` 是新出现或正文变化的实际消息。接入 Agent 应及时展示发现的问题及修复前告知，同一消息 ID 更新正文，避免重复追加；事件不表示整体完成，不中断等待、不展示后置菜单。stdout 仍只输出一次最终 JSON。

自动测试可能使用独立后台任务，主消息结束、子会话列表为空都不代表测试完成。CLI 通过服务端已解析的消息快照识别实际启动的 E2E 任务，等待其结果回传及主会话处理结束；回执按任务与父轮的真实关联恢复测试上下文。报告中附带的网页操作入口由 CLI 当前后置引导替换。

## 代码审查

代码审查检查指定 Superun 项目的已有代码。未指定范围时检查刚才的改动；指定范围时原样传递用户要求。发现确认的问题后先告知用户，再自动修复并汇报；与用户明确意图冲突的修复先确认业务规则。代码审查与功能的实际运行验证分别表达，不把审查完成或修复完成说成测试、复审通过。

```bash
superun-ai chat review <sessionId>
superun-ai chat review <sessionId> --message "检查报名名额扣减和取消后的回补逻辑"
superun-ai chat review <sessionId> --input ./review-scope.json --no-wait
superun-ai chat wait <sessionId> --timeout 120
superun-ai chat state <sessionId>
```

`--message`、`--input`、附件与等待选项和 `chat test` 一致。业务入口使用 `issue_review`；不传内容时发送“请审查刚才改动的代码，排查潜在缺陷与隐患，并修复发现的问题”。用户明确说“代码审查”或指定审查范围后直接执行，无需二次确认；只有讨论不触发。运行中或存在待回答交互时先处理当前任务，不重复提交。探索阶段先完成研发。普通主动调用不承诺免费。

研发完成后的前置引导为：

> 接下来，你可以检查代码、实际验证功能、继续完善项目，或上线运营。
>
> - **代码审查**：回复“代码审查”，检查刚才改动的代码，发现问题后先告知你，再自动修复。
> - **自动测试**：回复“自动测试”，实际验证刚才完成的功能，发现确认的问题后先告知你，再自动修复。
> - **继续创作**：直接告诉我想新增或调整的内容。
> - **上线运营**：回复“上线运营”。

审查开始时展示实际范围与关注点；发现问题时逐项告知，再展示正在修复的说明。通过 `conversation_message` 及时展示这些实际消息，用户不需要再次回复修复。CLI 等待后台审查、结果回传及主会话的修复和汇报全部结束；子审查终态但回执尚未处理时，继续等待并显示进度。

回执按持久化的任务与父消息关联逐层回溯；即使来源消息已被隐藏或并入其他展示轮，也只返回本次最新报告。来源缺失、冲突或循环时明确报错，不用最近的历史审查结果代替。

遇到修复方式等确认卡时，先展示对应的问题说明，再展示全部问题和选项。如果展示管线省略了提问前的正文，CLI 从同一条消息的服务端解析快照恢复该提问对应的可见说明；不读取模型推理，不用旧报告替代当前确认依据。

结果使用 `codeReview.phase=review|repair` 区分审查与后续修复，`reportMessages` 是本次最新结果，`previousReportMessages` 如有返回仅用于追溯问题编号。`sourceMessageId` 校验后续回复来源。`nextActions.when` 是候选动作的展示和执行条件，接入 Agent 应按实际报告筛选，不能直接展示所有候选。无有效报告时不猜问题数或通过状态。

发现问题后，全部修复、部分修复、没有修复都使用同一模板，按服务端原始报告顺序保留编号：

> 本次代码审查发现 **2 个问题，已修复 2 个，未修复 0 个**。
>
> 1. **重复报名可能重复扣减名额**：已修复，重复提交只处理一次。
> 2. **重复取消可能多次回补名额**：已修复，同一条报名只回补一次。
>
> 以上问题已全部修复。接下来，你可以验证修复效果、继续完善项目，或上线运营。
>
> - **自动测试**：回复“自动测试”，验证刚才修复的功能。
> - **继续创作**：直接告诉我想新增或调整的内容。
> - **上线运营**：回复“上线运营”。

| 当前实际结果 | 后置展示与引导 |
| --- | --- |
| 审查有效完成，没有发现问题 | 说明实际范围和结论，再说“接下来，你可以实际验证相关功能、继续完善项目，或上线运营。”；直接给三个选项，自动测试说明为“验证本次审查涉及的功能” |
| 问题全部修复 | 展示汇总、逐项修复详情和过渡句，直接给上述三个选项；验证状态按实际证据说明，不固定写尚未测试，不声称复审通过 |
| 部分修复或一个都没修复 | 同一模板列出数量、每项修复内容或未修复原因；只引导“修复剩余问题”“修复第 X 项”或具体修改要求，不显示三个完成选项 |
| 需要确认业务规则或补充资料 | 说明待确认项与未处理原因，只提出具体问题；有结构化交互时用 `chat interaction reply`，等待用户回答 |
| 审查异常、暂停、中断或没有有效结论 | 说明真实原因，只引导解决阻碍；可以重试时提示“重试代码审查”，不显示正常完成菜单 |
| 本次确定的范围只完成一部分 | 列出已审、未审范围及原因，只引导“继续审查……”指定剩余目标；范围之外的功能只说明未覆盖 |

用户回复修复要求时，使用当前结果的 `CODE_REVIEW_FOLLOW_UP` 命令，`content` 原样传递，不重新发起代码审查：

```bash
superun-ai chat send <sessionId> --review-followup <sourceMessageId> --message "修复第 2 项"
```

旧报告已被后续对话替换时拒绝提交，需重新查询。修复结束更新同一份问题清单：全部处理完直接给三个选项，仍有问题继续修复，需要决定就提问。新功能需求用普通 `chat send`，不带任何 followup 参数；`--review-followup` 与 `--test-followup` 不能同时传。

不增加“暂不需要”步骤。用户明确要求“审查完再自动测试”时，在审查及修复有效完成且无遗留问题后沿用已有授权衔接，否则等待用户选择。选择自动测试后沿用自动测试的结果规则；选择上线运营后沿用现有发布流程。当前审查流程不会在修复后自动重复审查同一范围。

## 风格、插件和发布

交互、风格、插件和发布均归属对话创作，统一使用 `chat interaction`、`chat style`、`chat plugin` 和 `chat publish`，不提供对应顶层入口。

```bash
superun-ai chat style generate <sessionId> --content "生成简洁的品牌风格" --count 2
superun-ai chat style list <sessionId>
superun-ai chat style select <sessionId> <choiceId>

superun-ai chat plugin list <sessionId>
superun-ai chat plugin status <sessionId> <pluginId>
superun-ai chat plugin enable <sessionId> <pluginId>
superun-ai chat plugin disable <sessionId> <pluginId>

superun-ai chat publish status <sessionId>
superun-ai chat publish start <sessionId> <encryptedId>
superun-ai chat publish visibility <sessionId> public
superun-ai chat publish visibility <sessionId> private
```

风格默认生成 2 个，支持 1～4 个；使用查询结果中的 `choiceId`。发布使用查询结果中的 `encryptedId`，按目标版本跟踪部署状态。插件 ID 以 `chat plugin list` 返回值为准。

风格等待会在单个方案成功且预览页面就绪时提前返回进度，整批状态仍为 `RUNNING`。候选通过 `previewUrl` 返回与 Glow 分支预览相同的可交互页面，不返回截图链接，也不等待截图生成。调用方应立即提示该方案及页面链接，再按 `QUERY_STYLES` 继续查询剩余方案，例如“方案 B 已生成，继续等待方案 A”。方案 A/B/C/D 固定对应原始 `index` 0/1/2/3，同一 `choiceId` 只提示一次；全部结束后再等待用户选择。

研发完成后的“查看预览”使用 `development.previewUrl`，返回与 Glow 研发主线一致的稳定地址 `https://id--<sessionId>.<托管域名>`，随主线构建结果更新。研发主线不再查找或等待快照；风格候选和独立演示版本继续使用各自的快照页面。上线运营返回正式发布域名。

用户选择风格后，`chat style select` 默认内部完成演示就绪等待、状态衔接和版本保留，再静默生成并确认研发规划，直接返回开发功能清单。调用方只提示“已采用方案 B，正在整理开发功能清单”，中间不展示演示、研发规划或“确认规划 / 调整功能”入口。清单返回后按原始对话和功能编号展示，提示“请回复要开发的功能编号或具体需求”，等待用户选择后再开发。缺少必要信息、密钥或需要确认数据库变更时仍展示实际问题，等待回答；不自动回答业务问题或选择功能。

自动规划确认仅适用于本次风格选择衔接，并在提交前重新核对当前交互；后续独立的规划调整保留原有确认流程。`--no-wait` 或等待超时返回时，按 `CONTINUE_STYLE_PLANNING` 继续执行 `chat wait`；`chat state` 只读并返回续等指引，不发起确认写请求。旧项目仍可使用 `chat demo` 和 `chat develop`。

查看演示、保留演示版本、进入研发及规划确认都由 CLI 静默完成，调用参数与 Glow 对齐；用户只看到最终研发功能清单及必要的业务问题。`cliPlanAfterStyle` 是 CLI 写入的本次风格选择标记，不是服务端特性开关。网页先推进演示或研发时，后续消息可能不带此标记，CLI 会沿真实 `preMessageId` 追溯本次选择并接续剩余步骤，不重复查看演示、保留版本或进入研发；已确认规划及后续独立流程构成追溯边界。

用户明确回复“上线运营”后，使用 `chat publish status <sessionId> --for-launch` 获取 Glow 发布面板的最新待发布版本，原样展示该版本的 `changeLog`，再按返回的命令直接发布，无需二次确认。发布中的版本只跟踪进度；部署后尚未公开的站点继续执行上线动作，完成后返回正式链接。`status` 始终只读，普通状态查询不会自动获得发布授权。

`chat publish start --indexing allow|deny` 控制搜索引擎索引，不限制用户访问；站点上下线使用 `chat publish visibility`。若服务端要求确认云服务费用，了解费用后可显式传入 `--acknowledge-cloud-fee`。

## 附件

`chat create/send` 支持重复传入 `--file <path>`。小型文本文件可以直接作为内容输入，其余文件上传并完成审核后才发送消息。单文件上限 20MB。

`session get --include-attachments` 返回可见附件清单；`chat state --include-file <name>` 读取指定可见附件正文。系统文件和密钥配置文件不会作为结果附件返回。

## 输出与错误

业务命令在 stdout 输出一条 JSON，诊断和更新进度写入 stderr。

```json
{
  "schemaVersion": "1",
  "ok": true,
  "data": {
    "state": "RUNNING",
    "sessionId": "session_id",
    "messages": [],
    "progress": [],
    "interactions": []
  }
}
```

| 退出码 | 含义 |
|---|---|
| 0 | 查询成功、请求已接受、仍在运行、需要输入或任务完成 |
| 2 | 参数或输入格式错误 |
| 3 | PAT 缺失、无效或访问被拒绝 |
| 4 | 版本检查或更新失败 |
| 5 | 业务失败、交互过期/歧义或写请求结果不确定 |
| 6 | 当前版本不支持所需交互 |
| 7 | 附件等辅助操作等待超时 |
| 8 | 网络或响应协议错误 |
| 130 | 本地命令被中断 |

`OUTCOME_UNKNOWN` 表示请求可能已被接受，不能直接重试写操作。先使用返回的会话 ID 查询状态；创建请求若未取得会话 ID，应查询项目列表确认。

## 更新

CLI 每次执行业务命令前都查询 npm `latest`，检查本机全局安装的版本。版本不一致或安装不完整时，直接通过 npm 全局更新本机 CLI，校验成功后再执行本次业务命令；已经是最新版则直接执行。更新或校验失败时会停止执行，请根据错误提示处理后重试。帮助、`version` 和 `auth logout` 可离线使用。

自动更新不创建、读取或删除 `update.lock`，也不再向 CLI 自建的 `versions` 缓存安装或从中选择版本运行；新版会实际更新到 npm 全局安装位置。旧缓存中的 CLI 执行到新版更新逻辑时，同样会检查并升级全局入口，避免每次仍从旧版本启动。

版本预检和安装统一通过 npm 执行，沿用 npm 的代理和证书配置，并自动重试短暂的网络故障。官方 Registry 不可用时，会尝试用户已配置的 Registry，安装沿用查询成功的源；恢复过程不输出报错或安装日志。所有源均失败时才返回错误，`error.checks` 包含各次检查的原因码，不包含原始 npm 日志或凭据。不会通过关闭证书校验或忽略版本检查来放行业务请求。

可以执行 `superun-ai update` 主动同步 npm `latest`。从源码安装也遵循相同的版本校验；修改源码后需要重新构建，如果全局命令不是链接到该目录，再执行 `npm install -g .`。

```bash
superun-ai version
superun-ai update
```

## 卸载

先清除本地 PAT，成功后再卸载程序：

```bash
superun-ai auth logout && npm uninstall -g superun-ai-cli
```

`npm uninstall` 不会自动执行 `logout`。如果设置过 `SUPERUN_PAT`，还需在当前终端执行 `unset SUPERUN_PAT`，并从设置它的 Shell 配置或运行环境中移除。`logout` 不会注销浏览器登录，也不会撤销服务端 PAT。

# superun-ai-cli

[English](README.en.md) | [中文](README.md)

superun-ai-cli 命令行工具，支持项目管理、对话创作、交互问答、插件管理和应用发布。人和自动化程序使用同一组命令；业务结果以 JSON 输出。

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

用户选择风格后，`chat style select` 默认内部完成演示就绪等待、演示状态衔接和版本保留，再生成研发规划。调用方只提示“已采用方案 B，正在生成研发规划，完成后请你确认”，不展示演示阶段的提示或额外询问。研发规划内容及“确认规划 / 调整功能”引导保持原样，确认规划后才生成供用户选择的开发功能清单。`--no-wait` 或等待超时返回时，按 `CONTINUE_STYLE_PLANNING` 继续执行 `chat wait`；它会核对当前状态后继续衔接。`chat state` 仍只读，旧项目仍可使用 `chat demo` 和 `chat develop`。

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

CLI 会在执行业务命令前检查 npm `latest` 版本，与本地版本不同时自动安装该版本并继续执行。更新或校验失败时会停止执行，请根据错误提示处理后重试。帮助、`version` 和 `auth logout` 可离线使用。

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

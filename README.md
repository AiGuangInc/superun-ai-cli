# Superun CLI

Superun 命令行工具，支持项目管理、对话创作、交互问答、插件管理和应用发布。人和自动化程序使用同一组命令；业务结果以 JSON 输出。

## 安装与本地运行

需要 Node.js 22 或更新版本，以及 npm。

```bash
npm install
npm run build
npm start -- --help
```

当前为尚未发布的开发版本。源码调试使用 `npm run dev -- <命令>`；该入口只在 `package.json` 标记为私有开发包时可用。正式入口会在业务操作前检查并运行指定版本。

## PAT 登录

```bash
npm run dev -- auth login --pat
npm run dev -- auth status
npm run dev -- auth logout
```

`auth login --pat` 在终端隐藏读取现有 PAT，即使已设置 `SUPERUN_PAT` 也会要求重新输入。`--pat` 是输入方式开关，后面不能直接跟 PAT 明文，并且不能与 `--stdin` 同时使用。当前不带选项的 `auth login` 仍兼容原有行为：优先读取环境变量，否则隐藏读取 PAT；网页创建入口尚未实现。

自动化环境可以设置 `SUPERUN_PAT`，也可以通过标准输入登录：

```bash
printf '%s\n' "$SUPERUN_PAT" | npm run dev -- auth login --stdin
```

凭据优先级为 `SUPERUN_PAT` 环境变量，其次是 `~/.config/superun-creation-cli/credentials.json`。文件权限为 `0600`；退出登录只清除本地保存的凭据，不撤销服务端 PAT。请勿将 PAT 写进命令行参数、仓库或日志。

### 统一执行流程

业务命令遵循同一流程：**解析命令 → 检查版本 → 读取 PAT → 直接调用业务接口 → 输出结果**。所有业务命令都必须提供 PAT；缺失或格式错误在本地拦截，有效性和资源权限由实际业务请求的服务端鉴权决定。

CLI 不额外调用用户资料接口，也不发送用于探测登录状态的 Session 查询。例如，`session list` 只按用户传入的筛选和分页参数请求一次列表接口。命令内的多个请求共用凭据和连接，每个实际 API 请求仍由服务端鉴权。

`auth login` 只检查 PAT 格式并按输入方式保存；`auth status` 只检查本地凭据配置。两者返回 `CONFIGURED` 与 `credentialSource`，表示本地已配置凭据，不代表服务端已经接受 PAT，也不返回用户资料。PAT 过期、禁用等问题会在实际业务请求时返回 `AUTH_REQUIRED`。这两个命令不调用业务接口，发行入口原有的版本检查保持不变。

帮助、`version`、`update` 和清除本地凭据的 `auth logout` 不要求已有 PAT。提供 `SUPERUN_PAT` 即可直接调用业务命令，无需重复执行登录命令。

## 常用命令

以下使用正式命令名 `superun-create`。源码调试时，将它替换为 `npm run dev --`。

```bash
superun-create session list --limit 20
superun-create session get <sessionId>
superun-create chat create --message "为咖啡店制作一个活动网站"
superun-create chat send <sessionId> --message "增加会员权益介绍"
superun-create chat state <sessionId>
superun-create chat wait <sessionId> --timeout 120
superun-create session stop <sessionId>
```

写命令支持 `--no-wait`：请求被接受后立即返回。`chat wait` 等待到需要输入、需要选择或任务结束；达到本地等待时限后返回当前状态和 `waitTimedOut: true`，可以继续查询。按 Ctrl+C 只结束本地等待；远端停止需要显式执行 `session stop`。

全局参数：`--env prod|pre` 选择正式或预发布环境，默认使用正式环境；`--endpoint <URL>` 指定 API 地址，`--locale <language>` 指定响应语言。远端连接使用 HTTPS，本机调试允许 localhost 的 HTTP 地址。

### 环境切换

```bash
# 源码调试：使用预发布环境验证登录并查询项目
npm run --silent dev -- --env pre auth status
npm run --silent dev -- --env pre session list --limit 5

# 正式命令同样支持切换环境
superun-create --env pre session list
superun-create --env prod session list
```

也可以设置 `SUPERUN_ENV=pre`。地址优先级为：`--endpoint` → `--env` → `SUPERUN_ENDPOINT` → `SUPERUN_ENV` → 默认正式环境，因此显式传入 `--env pre` 会覆盖环境变量中的默认地址。

预发布环境需要额外的网关访问凭据 `PRIVATE_TOKEN`，它只通过 `PRIVATE-TOKEN` 请求头发送到预发布 API 地址，不会保存到凭据文件、输出到日志或发送到正式/自定义地址。`SUPERUN_PAT` 则用于业务登录，两者不能互换。

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
superun-create chat interaction reply <sessionId> <interactionId> --input ./answer.json
superun-create chat interaction skip <sessionId> <interactionId>
```

选择下标从 `0` 开始。只有交互声明支持 `SKIP` 时才可跳过。需求问卷使用 `REFINE` 或 `GENERATE_STYLES`；阶段交接、数据库变更确认等交互应使用各自返回的动作，不能统一发送 `SUBMIT`。

密钥输入使用 `{"values":{"请求的键名":"密钥值"}}`，只提交当前交互要求的键；内容不会回显。过期或存在歧义的交互会被拒绝，请重新查询状态。

`chat interaction reply --no-wait` 控制回答处理完成后的创作等待。部分插件配置需要在前台等待配置结束并提交交互结果，这一步不会因该选项被省略；中断后应先查询插件与会话状态。

## 风格、插件和发布

交互、风格、插件和发布均归属对话创作，统一使用 `chat interaction`、`chat style`、`chat plugin` 和 `chat publish`，不提供对应顶层入口。

```bash
superun-create chat style generate <sessionId> --content "生成简洁的品牌风格" --count 2
superun-create chat style list <sessionId>
superun-create chat style select <sessionId> <choiceId>
superun-create chat style retry <sessionId> <choiceId>

superun-create chat plugin list <sessionId>
superun-create chat plugin status <sessionId> <pluginId>
superun-create chat plugin enable <sessionId> <pluginId>
superun-create chat plugin disable <sessionId> <pluginId>

superun-create chat publish status <sessionId>
superun-create chat publish start <sessionId> <encryptedId>
superun-create chat publish visibility <sessionId> public
superun-create chat publish visibility <sessionId> private
```

风格默认生成 2 个，支持 1～4 个；使用查询结果中的 `choiceId`。发布使用查询结果中的 `encryptedId`，按目标版本跟踪部署状态。插件 ID 以 `chat plugin list` 返回值为准。

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

正式入口每次执行业务命令都会校验发布渠道指定版本。需要更新时安装到用户目录的独立版本缓存，校验完成后再运行原命令；不会覆盖正在执行的全局安装。更新或校验失败时不发送业务请求。`help`、`version` 和 `auth logout` 可离线使用。

## 命令分包

命令按领域组织，`index.ts` 负责注册该领域的子命令，具体操作放在各自文件中。共用消息流程只供创建和续写复用；跨命令认证保持统一入口。

```text
src/commands/  # 按命令域分包，只负责命令注册、输入校验和操作编排
├── auth/  # auth：PAT 登录管理
│   ├── index.ts  # 注册 login、status、logout
│   ├── login.ts  # 接收并保存 PAT
│   ├── status.ts  # 查看本地 PAT 配置状态
│   └── logout.ts  # 清除本地 PAT
├── session/  # session：项目查询和管理
│   ├── index.ts  # 注册 list、get、stop
│   ├── list.ts  # 项目列表、筛选与分页
│   ├── get.ts  # 项目详情与可见附件
│   └── stop.ts  # 停止远端任务
├── chat/  # chat：对话创作及其子流程
│   ├── index.ts  # 注册创作命令与 style、interaction、plugin、publish
│   ├── create.ts  # 新建项目并发送需求
│   ├── send.ts  # 继续项目创作
│   ├── message.ts  # create/send 共用的输入校验、附件上传和消息发送
│   ├── state.ts  # 查询当前任务、交互与指定附件
│   ├── wait.ts  # 等待交互或任务结果
│   ├── style.ts  # chat style：风格生成、查询、选择与重试
│   ├── interaction.ts  # chat interaction：提交或跳过当前交互
│   ├── plugin.ts  # chat plugin：插件查询、启用与禁用
│   └── publish.ts  # chat publish：版本发布、进度查询与站点上下线
├── system/  # 根级工具命令，不额外引入 system 命令层级
│   ├── update.ts  # 安装当前发布渠道指定的版本
│   └── version.ts  # 显示本地版本与输出协议版本
└── shared.ts  # 跨命令共用的凭据和连接上下文、输入读取与等待辅助
```

## 开发检查

```bash
npm run typecheck
npm run format:check
npm run build
npm pack --dry-run
```

发布前需要确定正式包名、Registry 和开源许可证，并完成目标环境的契约验证。当前仓库不包含访问凭据。

- [ ] 推送仓库前提醒维护者移除预发布调试入口及专用网关凭据支持。

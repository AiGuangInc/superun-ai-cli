# superun-ai-cli

superun-ai-cli 命令行工具，支持项目管理、对话创作、交互问答、插件管理和应用发布。人和自动化程序使用同一组命令；业务结果以 JSON 输出。

## 安装

需要 Node.js 22 或更新版本，以及 npm。

> 当前版本尚未正式发布，以下为正式发布后的安装与使用方式。

```bash
npm install -g superun-ai-cli
superun-ai --help
```

`-g` 表示全局安装。安装会下载运行所需的程序和依赖，无需下载源码仓库或自行编译。全局命令目录在 `PATH` 中时，可以在任意目录使用 `superun-ai`。

安装包名为 `superun-ai-cli`，使用时的命令名为 `superun-ai`。

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
│   │   ├── select <sessionId> <choiceId>        # 选择已完成的风格
│   │   └── retry <sessionId> <choiceId>         # 重试失败风格
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

查看某一组命令或具体命令的帮助：

```bash
superun-ai chat --help
superun-ai chat style generate --help
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

默认连接正式环境。全局参数 `--endpoint <URL>` 可指定 API 地址，`--locale <language>` 可指定响应语言。

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
superun-ai chat style retry <sessionId> <choiceId>

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

CLI 会在执行业务命令前检查版本，需要更新时自动安装指定版本后继续执行。更新或校验失败时会停止执行，请根据错误提示处理后重试。帮助、`version` 和 `auth logout` 可离线使用。

```bash
superun-ai version
superun-ai update
```

## 卸载

```bash
npm uninstall -g superun-ai-cli
```

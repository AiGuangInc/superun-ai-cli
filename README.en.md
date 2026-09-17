# superun-ai-cli

[English](README.en.md) | [中文](README.md)

superun-ai-cli is a command-line tool for project management, conversational creation, interactive questions, plugins, and application publishing. People and automation use the same commands; business results are returned as JSON.

## Installation

Requires Node.js 22 or newer and npm.

> Available on [npm](https://www.npmjs.com/package/superun-ai-cli). Install with npm by default; cloning or compiling the source is not required.

### 🤖 Install and configure with an AI agent (recommended)

Send the following prompt to Claude Code, Codex, or another AI coding agent. The agent will follow the [installation guide](INSTALL.md) to check your environment, install the CLI, and guide you through login and verification:

```text
Read https://raw.githubusercontent.com/AiGuangInc/superun-ai-cli/refs/heads/main/INSTALL.md and help me install and configure superun-ai-cli. Install from npm. Let me complete Superun login in my browser; do not request or display my PAT in plain text.
```

If the agent already has this repository open, ask it to read `INSTALL.md` in the repository root.

### Manual installation

```bash
npm install -g superun-ai-cli --registry=https://registry.npmjs.org
```

`-g` installs the package globally. Once the global command directory is on your `PATH`, you can run `superun-ai` from any directory. Installing this public package does not require an npm publishing account; sign in to Superun after installation.

The package name is `superun-ai-cli`; the shell command is `superun-ai`.

### Optional: install from source

If you need to change the CLI source, clone the repository with Git and build it:

```bash
git clone https://github.com/AiGuangInc/superun-ai-cli.git
cd superun-ai-cli
npm ci
npm run build
npm install -g .
```

If you already have a local checkout, use that directory and preserve any uncommitted changes. The build clears `dist` before generating files. Keep the source directory if your global command is linked to it.

## Publish to npm

Commit current changes, switch to `main`, and run:

```bash
npm run release
```

The script prints the previous version and verifies npm authentication with `npm whoami`. If authentication fails, it runs `npm login` and verifies again; failure stops the process before changing the version. It then runs `npm version patch`, prints the new version, publishes to npm with the `latest` tag, and runs `git push origin main --follow-tags`. Versioning creates a Git commit and tag. Publishing uses the existing `prepack` type check and build. Valid authentication does not guarantee package publishing permission; use an authorized account. npm may prompt for two-factor authentication.

Each failure stops the sequence. If publication is uncertain, check the target version on npm first. If npm publication succeeded but Git push failed, retry only `git push origin main --follow-tags`. Publishing to `latest` affects existing CLI users through its built-in update logic.

## Help

After installation, run help separately. These commands do not start login or create a project:

```bash
superun-ai --help
superun-ai chat --help
superun-ai chat style generate --help
```

## Command tree

This reference is for developers and integrating agents, not a user-facing menu. Execute `nextActions.command` / `input` internally and show users only status, results, and necessary questions. After style selection, keep demo transitions, version preservation, development entry, and initial plan approval silent. Credit errors, execution failures, and real business questions must still be shown.

The tree below lists command groups, positional arguments, and their purpose. Replace required arguments written as `<...>` with actual values. Use each command's `--help` to see its options and requirements.

```text
superun-ai
├── auth                                                          # Manage PAT login
│   ├── login                                                     # Sign in and save a PAT
│   ├── status                                                    # Check local PAT configuration
│   └── logout                                                    # Remove the locally saved PAT
├── session                                                       # Query projects
│   ├── list                                                      # List projects
│   └── get <sessionId>                                           # Get project details
├── chat                                                          # Conversational creation
│   ├── create                                                    # Create a project and send a request
│   ├── send <sessionId>                                          # Continue the conversation
│   ├── test <sessionId>                                          # Test existing functionality and repair identified issues
│   ├── review <sessionId>                                        # Review existing code and repair identified issues
│   ├── state <sessionId>                                         # Inspect the task and interactions
│   ├── wait <sessionId>                                          # Wait for input or a task result
│   ├── stop <sessionId>                                          # Stop the remote task
│   ├── retry <sessionId> <messageId>                             # Retry the original failed task after recharging
│   ├── style                                                     # Manage creative styles
│   │   ├── generate <sessionId>                                  # Generate style candidates
│   │   ├── list <sessionId>                                      # List style batches
│   │   ├── append <sessionId>                                    # Generate one additional design from existing requirements
│   │   ├── retry <sessionId> <choiceId>                          # Retry the original failed style task
│   │   └── select <sessionId> <choiceId>                         # Choose a style and show the development feature list
│   ├── demo <sessionId>                                          # View the demo and record it as viewed
│   ├── develop <sessionId>                                       # Keep the demo and plan development
│   ├── interaction                                               # Answer or skip interactions
│   │   ├── reply <sessionId> <interactionId>                     # Submit an answer
│   │   └── skip <sessionId> <interactionId>                      # 跳过当前交互
│   ├── plugin                                                    # Query, enable, and disable plugins
│   │   ├── list <sessionId>                                      # List available plugins
│   │   ├── status <sessionId> <pluginId>                         # Inspect a plugin
│   │   ├── enable <sessionId> <pluginId>                         # Enable a plugin
│   │   └── disable <sessionId> <pluginId>                        # Disable a plugin
│   └── publish                                                   # Publish applications and manage visibility
│       ├── status <sessionId>                                    # Query versions and deployment progress
│       ├── start <sessionId> <encryptedId>                       # Publish a specific version
│       └── visibility <sessionId> <visibility>                   # Make the site public or private
├── update                                                        # Check and update to the latest CLI version
└── version                                                       # Show local and output-schema versions
```

Run `npm run docs:sync` after changing command registration to update both command trees. `npm run docs:check` validates their completeness; `prepack` also checks them before packaging.

## PAT login

```bash
superun-ai auth login
superun-ai auth status
superun-ai auth logout
```

`auth login` reuses an existing PAT. If none is configured, it opens the system default browser for Superun login and saves the resulting PAT locally. Business commands without a PAT use the same login flow, including commands run from an agent's non-TTY shell, then resume the original operation without requiring a separate `auth login` command. `auth status` only checks existing configuration and does not open a browser.

Browser login waits for up to five minutes. Press Ctrl+C to cancel. If the browser does not open automatically, use the URL printed in the terminal. The website login token is only used to obtain a PAT and is not stored locally.

To import an existing PAT manually:

```bash
superun-ai auth login --pat
```

`--pat` reads hidden input from the terminal, even if `SUPERUN_PAT` is already set. It is an input-mode switch: do not put the PAT after it, and do not combine it with `--stdin`.

Automated business commands without a PAT fail instead of opening a browser. Set `SUPERUN_PAT` or log in using standard input:

```bash
printf '%s\n' "$SUPERUN_PAT" | superun-ai auth login --stdin
```

The CLI prefers `SUPERUN_PAT`, then `~/.config/superun-ai-cli/credentials.json`. The file uses `0600` permissions. Logging out removes the local credential without revoking the server-side PAT. Never put a PAT in command-line arguments, source control, or logs.

`auth status` only checks local credential configuration. It does not open a browser or request a PAT. `CONFIGURED` means a credential is configured locally; its validity and project permissions are checked by actual business requests. An expired or disabled PAT, or a damaged credential file, results in an error rather than an automatic login or overwrite.

`auth logout` deletes the saved PAT. If `SUPERUN_PAT` is set, it remains effective until you remove it from your shell:

```bash
unset SUPERUN_PAT
```

Help, `version`, `update`, and `auth logout` do not require an existing PAT. With `SUPERUN_PAT` set, you can call business commands without first running login again.

## Common commands

```bash
superun-ai session list --limit 20
superun-ai session get <sessionId>
superun-ai chat create --message "Build a promotional website for a coffee shop"
superun-ai chat send <sessionId> --message "Add a membership benefits section"
superun-ai chat state <sessionId>
superun-ai chat wait <sessionId> --timeout 120
superun-ai chat stop <sessionId>
```

Write commands support `--no-wait`, returning as soon as the request is accepted. `chat wait` waits for input, a selection, or task completion. When an explicit local waiting limit is reached, it returns the current state with `waitTimedOut: true`; you can continue querying. Ctrl+C only ends local waiting. Use `chat stop` explicitly to stop a remote task.

Chat task responses also include `taskProgress`. During development with an approved plan in the current user’s round, `tasks` contains only checked, unfinished features from Glow’s in-progress list, read independently from the same `internal/features.json` and `internal/todos.json` used by Glow. Steps are joined by the actual `featureId`; `steps` preserves their text, order, and `pending / in_progress / completed` status, while `stepProgress` contains the actual completed and total counts. Running features come first, preserving server order within each status. Historical completed features and their steps are excluded. Pending selected features show only their title and status, without stale Todos. Legacy Todos without a feature ID are not assigned to another feature. Running features without steps display a pending-generation notice rather than a fabricated 0/0. The card no longer includes execution details, duplicate message/subtask tables, or tool counts. After the whole round reaches `COMPLETED`, preserve the original completion text in `messages`, preview links, and existing continue-creation / launch guidance. Do not replace the reply with a step table or completion card. Only append `toolUsage.markdown` after the completion text. The count uses the same current-round `activity.summary.toolCount` as Glow’s completion bubble, without adding subtask counts. Read, edit, and deployment counts are not displayed separately; missing statistics are explicitly reported as unavailable.

Other stages retain the original task list. A successful development-progress query with no unfinished features returns an empty list instead of restoring completed tasks from a previous round. Background tasks are deduplicated by identity; other-member or unknown-owner background tasks expose status only. `markdown` is a ready-to-display card. `revision` tracks visible step and status changes (tool counts do not affect the card revision), and feature progress refreshes even when the parent message is unchanged. Failed reads or malformed data fall back to execution status with `complete: false` and `warnings`; missing steps are never treated as completed, and percentages are not estimated.

While `chat wait` or a write command is waiting, progress from every polling iteration is emitted as newline-delimited JSON on stderr with `event: "task_progress"`; the card is in `data.taskProgress.markdown`. Host agents should read output from the running command and display every task. Update the same card using `taskProgress.id` when supported; otherwise display the current snapshot on every query, including when `changed: false`. Progress events are not final results: continue waiting on the same process without interrupting or resubmitting the task. stdout still emits a single command result.

Overall completion retains the existing session, message, interaction, and background-work rules. `taskProgress` is display-only: a completed item or changed card does not end the wait, and item counts do not determine overall completion. Existing early style-preview notifications, local timeouts, and user-input behavior remain unchanged. Pass `--progress-revision` with the previous revision to compute `changed`; it does not suppress progress output on subsequent queries, and `chat state` and `chat style list` also accept this option.

The CLI connects to Superun by default. Use the global `--endpoint <URL>` option to specify an API endpoint and `--locale <language>` to choose the response language.

## 回答交互

CLI 返回专家团 main 已使用的交互格式：`interactions[].kind`、`questions`、`actions`、`details` 和 `answerSchema`。先展示 `messages` 中的完整说明，再按问题原文和选项收集回答；推荐标记不代表用户已选。密钥仍走安全输入，风格仍使用 `choices` 与风格命令。

普通问卷一次返回整组问题。可以整组、逐题或按宿主容量分批展示，收齐当前全部问题后，通过 `chat interaction reply <sessionId> <interactionId> --input <file>` 一次提交：

```json
{
  "action": "SUBMIT",
  "answers": [
    { "questionId": "q0", "selectedIndices": [0], "otherValue": "" },
    { "questionId": "q1", "selectedIndices": [], "otherValue": "用户原文" }
  ]
}
```

保留真实 questionId 和选项 index，不能用展示编号代替。按当前 `actions` 与 `answerSchema` 选择操作；例如 PRD 使用 `GENERATE_STYLES`。用户答齐后直接提交，不追加“是否提交”。仅当当前 actions 包含 `SKIP` 时，才可使用 `chat interaction skip <sessionId> <interactionId>`。

托管智能体向导由 CLI 内部转换成普通 `ASK_USER_TOOL`，专家团无需识别向导类型、维护步骤或构造资源参数。CLI 按 Glow 流程依次返回设定、知识和记忆、扩展能力及创建确认。返回、跳过、智能修改、撤回、快速创建、终止等操作显示为当前问题的选项；返回、跳过、终止等导航选项必须单独选择。每次页面变化都会获得新的 interactionId，回答当前问题后继续处理命令返回的下一条问答。

本次知识文件为空，不提供附件路径或技能包上传入口；普通 chat create/send 的附件能力不受影响。只有最终确认或明确选择快速创建后才创建资源。创建成功的资源 ID 立即保存，失败恢复复用已创建资源；结果不确定时禁止盲目重发。

首次启用通用智能体保留 Glow 的产品适配判断和配置入口。`chat plugin enable` 返回处理中后，原有 `chat plugin status` 会继续返回该入口的进度或普通问答；调用方无需增加专用等待分支。重复 enable 会读取已提交的流程，不重复发起；其他插件仍使用原有生命周期接口。

草稿按环境、凭据作用域和交互来源隔离。CLI 在内部校验页面版本；调用方只需保留 sessionId、当前 interactionId 和原始输出，无需传 pageRevision、view 或 response。网页已完成、页面或选项目录变化时，旧回答会被拒绝，需重新查询。单页答完不代表整个任务完成，最终状态仍以 CLI 返回为准。

## Automatic testing and code review

```bash
superun-ai chat test <sessionId>
superun-ai chat test <sessionId> --message "Verify login and logout"
superun-ai chat review <sessionId>
superun-ai chat review <sessionId> --message "Review capacity updates and cancellation handling"
superun-ai chat send <sessionId> --test-followup <sourceMessageId> --message "Fix issue 2"
superun-ai chat send <sessionId> --review-followup <sourceMessageId> --message "Fix issue 2"
```

Use the actual report `sourceMessageId` for follow-ups. Display the returned findings and follow the current `nextActions`; do not invent test results or approve unresolved business decisions.

## Insufficient credits and retrying

When a request or running task fails because of insufficient credits, open [superun.ai](https://superun.ai) to recharge, then reply “Retry”. The CLI does not retry automatically while waiting for the user.

- A rejected request: repeat the original operation with its original input after recharging; do not retry an earlier completed message.
- A failed running task: use the returned `RECHARGE_AND_RETRY` command. It checks the balance and calls Glow's existing retry API for the current failed message. Completed, running, or stale messages are rejected.
- Owner or team balance failures require funding the corresponding account. Member monthly/total quota failures require an administrator to adjust the quota.

```bash
superun-ai chat retry <sessionId> <messageId>
superun-ai chat retry <sessionId> <messageId> --no-wait
superun-ai chat retry <sessionId> <messageId> --timeout 120
```

Use the actual failed agent message ID from `nextActions.command`, not a user message ID or a style `choiceId`. Retry waits for the result by default. With `--no-wait`, follow the returned guidance to check progress after the request is accepted. Failed style candidates use `chat style retry <sessionId> <choiceId>` instead.

## Styles, plugins, and publishing

Interactions, styles, plugins, and publishing belong under `chat`. Use `chat interaction`, `chat style`, `chat plugin`, and `chat publish`; they are not top-level commands.

```bash
superun-ai chat style generate <sessionId> --content "Create a clean brand style"
superun-ai chat style list <sessionId>
superun-ai chat style append <sessionId> --anchor <branchAnchor>
superun-ai chat style retry <sessionId> <choiceId>
superun-ai chat style select <sessionId> <choiceId>
superun-ai chat demo <sessionId>
superun-ai chat develop <sessionId>

superun-ai chat plugin list <sessionId>
superun-ai chat plugin status <sessionId> <pluginId>
superun-ai chat plugin enable <sessionId> <pluginId>
superun-ai chat plugin disable <sessionId> <pluginId>

superun-ai chat publish status <sessionId>
superun-ai chat publish start <sessionId> <encryptedId>
superun-ai chat publish visibility <sessionId> public
superun-ai chat publish visibility <sessionId> private
```

首次固定生成一个方案，已移除 `--count` / `styleCount`；`chat style append <sessionId> --anchor <branchAnchor>` 每次基于已有需求追加一版，不接受额外要求或参考文件。`chat style retry <sessionId> <choiceId>` 重试原失败任务。展示 `styleGeneration.notice`，按 `nextActions` 引导用户采用已有方案或委托高级设计师再设计一版方案；费用以服务端实际结果为准。 Use the returned `choiceId` to select a style. Publishing uses the returned `encryptedId` and tracks the selected version's deployment. Plugin IDs come from `chat plugin list`.

Style waiting returns progress as soon as one candidate succeeds and its preview page is ready, while the batch remains `RUNNING`. Each candidate exposes `previewUrl`, the same interactive page used by Glow's branch preview. Screenshot URLs are not returned, and screenshot generation does not delay readiness. Show that candidate and its page link immediately, then follow `QUERY_STYLES` to keep checking the remaining candidates. For example: “Style B is ready; waiting for style A.” Labels A/B/C/D correspond to the original `index` 0/1/2/3, regardless of completion order. Announce each `choiceId` only once and wait for the user's selection after the batch finishes.

After development completes, the preview link is returned in `development.previewUrl` as `https://id--<sessionId>.<hosting-domain>`, matching Glow's stable development-mainline address and updating with mainline builds. Development no longer looks up or waits for snapshots. Style candidates and saved demo versions retain their own snapshot pages, while launch operations return the published domain.

After the user selects a style, `chat style select` waits for its demo, completes the demo transition and preserves the version internally, then generates the development plan. Show only that the selected style is being used to prepare the plan, without demo-stage prompts or additional questions. The CLI silently generates and confirms the initial plan, then displays the actual feature list for the user to choose what to develop. Real business questions still require user input. After `--no-wait` or a local timeout, follow `CONTINUE_STYLE_PLANNING` with `chat wait` to check the current state and resume the transition. `chat state` remains read-only, and existing projects can still use `chat demo` and `chat develop`.

After the user explicitly asks to launch the site, use `chat publish status <sessionId> --for-launch` to get the latest pending version from the publishing panel. Show its `changeLog` unchanged, then follow the returned publishing command without a second confirmation. For a deployment already in progress, only track progress. If deployment is complete but the site is not public, finish the visibility step and return the public URL. `status` is always read-only; an ordinary status query does not grant publishing authorization.

`chat publish start --indexing allow|deny` controls search-engine indexing, not visitor access. Change site visibility with `chat publish visibility`. If the service requires acknowledgment of cloud costs, review them before explicitly passing `--acknowledge-cloud-fee`.

## Attachments

`chat create/send` accepts repeated `--file <path>` options. Small text files may be included directly in the message; other files are uploaded and approved before the message is sent. The per-file limit is 20 MB.

`session get --include-attachments` returns visible attachments. `chat state --include-file <name>` reads a named visible file. System files and secret configuration are not returned as result attachments.

## Output and errors

Business commands write one JSON result to stdout. Diagnostics and update progress go to stderr.

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

| Exit code | Meaning |
|---|---|
| 0 | Query succeeded, request accepted, running, input needed, or completed |
| 2 | Invalid arguments or input |
| 3 | Missing or invalid PAT, or access denied |
| 4 | Version check or update failed |
| 5 | Business failure, stale or ambiguous interaction, or uncertain write outcome |
| 6 | Interaction unsupported by this CLI version |
| 7 | Timeout for an attachment or auxiliary operation |
| 8 | Network or response-protocol error |
| 130 | Local command interrupted |

`OUTCOME_UNKNOWN` means a request may have been accepted. Do not immediately retry the write. Query the returned session ID first. If a create request did not return a session ID, check the project list before deciding what to do next.

## Updates

The CLI checks npm's `latest` version before business commands. If it differs from the local version, the CLI installs that version and resumes the command. If an update or verification fails, the CLI stops; resolve the reported issue before retrying. Help, `version`, and `auth logout` work offline.

Version checks and installation both run through npm, inheriting its proxy and certificate configuration and retrying transient network failures. If the official Registry is unavailable, the CLI tries the user's configured Registry and uses the successful source for installation. Recovery does not print errors or installation logs. If all sources fail, `error.checks` provides reason codes without raw npm logs or credentials. The CLI does not disable certificate verification or skip the version check to allow business requests.

Run `superun-ai update` to sync with npm `latest` explicitly. Source installations use the same version check. Rebuild after changing the source; if the global command is not linked to that checkout, run `npm install -g .` again.

```bash
superun-ai version
superun-ai update
```

## Uninstalling

Clear the local PAT first, then uninstall only if logout succeeds:

```bash
superun-ai auth logout && npm uninstall -g superun-ai-cli
```

`npm uninstall` does not run `logout` automatically. If you configured `SUPERUN_PAT`, also run `unset SUPERUN_PAT` in the current shell and remove it from the shell configuration or environment that sets it. Logging out does not sign you out of the browser or revoke the server-side PAT.

<!-- @author xiuyu.yi -->

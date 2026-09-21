# superun-ai-cli

[English](README.en.md) | [中文](README.md)

superun-ai-cli is a command-line tool for project management, conversational creation, interactive questions, plugins, and application publishing. People and automation use the same commands; business results are returned as JSON.

## Installation

Requires Node.js 22 or newer and npm.

> Available on [npm](https://www.npmjs.com/package/superun-ai-cli). Install with npm by default; cloning or compiling the source is not required.

### 🤖 Install and configure with an AI agent (recommended)

Send the following prompt to Claude Code, Codex, or another AI coding agent. The agent will follow the [installation guide](INSTALL.md) to check your environment, install the CLI, and guide you through login and verification:

```text
Read https://raw.githubusercontent.com/AiGuangInc/superun-ai-cli/refs/heads/main/INSTALL.md and help me install and configure superun-ai-cli. Install from npm. Let me complete superun login in my browser; do not request or display my PAT in plain text.
```

If the agent already has this repository open, ask it to read `INSTALL.md` in the repository root.

### Manual installation

```bash
npm install -g superun-ai-cli --registry=https://registry.npmjs.org
```

`-g` installs the package globally. Once the global command directory is on your `PATH`, you can run `superun-ai` from any directory. Installing this public package does not require an npm publishing account; sign in to superun after installation.

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
├── session                                                       # Query projects and conversation binding
│   ├── list                                                      # List projects
│   ├── get <sessionId>                                           # Get project details
│   ├── current                                                   # Read the saved project for this host conversation
│   ├── use <sessionId>                                           # Select a project for this conversation
│   └── clear                                                     # Clear the local binding and keep the remote project
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
│   ├── security <sessionId>                                      # Scan security, apply necessary fixes, and generate an audit report
│   ├── agent-friendly <sessionId>                                # Prepare agent-friendly access and choose Skill or connector instructions
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

## Restore the project for this conversation

In Codex and WorkBuddy / CodeBuddy environments with a verifiable conversation identity, the CLI remembers one project per conversation. Creating a project or explicitly operating on another project replaces the binding. Listing projects, reading details, and waiting for tasks do not change it.

```bash
superun-ai session current
superun-ai session use <sessionId>
superun-ai session clear
```

`current` returns the saved `sessionId`. Use existing commands to read project details or continue with `chat send <sessionId>`. Use `use` when switching projects without starting work; `clear` removes only the local binding and keeps the remote project. You do not need to run `use` before every command.

Bindings survive reopening the same host conversation and are isolated by conversation, superun account, and endpoint. WorkBuddy subagents share the main task binding when their ownership can be verified. Bindings are local to this device.

`UNBOUND` means no project is selected. `UNAVAILABLE` means the host conversation cannot be identified; continue passing an explicit `sessionId`. For `CREATING` or `CREATE_UNKNOWN`, check the original creation request before creating again. Once you have confirmed the project ID, restore the binding with `use`.

## PAT login

```bash
superun-ai auth login
superun-ai auth status
superun-ai auth logout
```

`auth login` reuses an existing PAT. If none is configured, it opens the system default browser for superun login and saves the resulting PAT locally. Business commands without a PAT use the same login flow, including commands run from an agent's non-TTY shell, then resume the original operation without requiring a separate `auth login` command. `auth status` only checks existing configuration and does not open a browser.

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

The CLI connects to superun by default. Use the global `--endpoint <URL>` option to specify an API endpoint and `--locale <language>` to choose the response language.

## Answer questions and create an agent

The CLI pauses when it needs more information or a choice from you. When using the expert team, answer the questions shown in the interface. Multiple-choice questions can accept several selections; recommended options are still yours to choose.

Creating a managed agent has three setup steps:

1. **Agent settings**: describe what the agent should do. Edit the description directly or choose the AI-assisted editing option.
2. **Knowledge and memory**: create a memory store, use an existing one, or continue without one. For a new store, use the suggested name or enter your own.
3. **Capabilities**: choose file handling, web search, Word, PDF, PowerPoint, spreadsheet, and other available capabilities as needed. Longer lists span several pages. You can select “None on this page” without affecting other pages, or continue without selecting anything on any page.

Review the settings and confirm creation once you have finished. You can go back to make changes, skip optional steps, or stop creating the agent. “Quick create” uses the current description without adding knowledge files, a memory store, or optional skills.

Upload knowledge files and custom skill packages through the superun website after creation. Built-in capabilities are currently included with the agent; clearing their checkboxes does not disable them.

When using the CLI directly, prepare an answer file following the current question's instructions, then submit it:

```bash
superun-ai chat interaction reply <sessionId> <interactionId> --input ./answer.json
```

If the current question allows skipping, run:

```bash
superun-ai chat interaction skip <sessionId> <interactionId>
```

If you exit midway, the questions change, or an operation's outcome is unclear, check the current status before continuing to avoid creating duplicates:

```bash
superun-ai chat state <sessionId>
```

## Enable plugins

Use `superun-ai chat plugin list <sessionId>` to see the plugins available to your project, then enable one as needed:

```bash
superun-ai chat plugin enable <sessionId> <pluginId>
superun-ai chat plugin status <sessionId> <pluginId>
```

Plugins with a platform-managed option, such as speech recognition, do not require your own credentials by default. To use your own account or a plugin that requires credentials, follow the secure-input instructions. Do not paste secrets into ordinary chat. When using the CLI directly, provide a configuration file with `--input ./plugin-config.json`.

To start a disabled plugin again, use the same `chat plugin enable` command. In-progress operations continue waiting without a duplicate submission.

If an enable request appears in a conversation, answer that request instead of running a second enable command. Keep following its progress while it runs. Restoring a configured plugin will either reuse its settings or ask for credentials as needed.

If external authorization or website configuration is needed, follow the instructions before continuing. You can skip plugins you do not need yet.

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

## Text input and attachments

`chat create/send/test/review` supports repeated `--file <path>` options for local uploads. Supply text through mutually exclusive `--message <text>` or `--input <file>` / `--input -`. JSON accepts only `content` or `message`, not `attachments`, inline file data, or attachment URLs. `--input` reads request JSON; only `--file` uploads a file. create/send also accepts files without text.

```bash
superun-ai chat create --message "Build a chat summary app using the attachment" --file ./feishu-group-digest.md
superun-ai chat send <sessionId> --input ./request.json --file ./design.png --file ./requirements.pdf
```

The CLI loads Glow's current file extension and size rules before uploading. Current China production limits are listed below; the connected environment's response is authoritative.

| Category | Supported extensions | Current per-file limit |
| --- | --- | --- |
| Images | png, jpg, jpeg, webp, gif | 20 MB; try Glow's compression flow when exceeded |
| Text and code | txt, md, svg, js, ts, jsx, tsx, py, java, cpp, c, h, cs, php, rb, go, rs, swift, html, css, scss, less, json, xml, yaml, yml | 5 MB |
| Documents | pdf, docx | 50 MB |
| Spreadsheets | xlsx, xls; csv | Excel 30 MB; CSV 5 MB |
| Video | mp4, mov, webm, avi, wmv, flv, mkv | 15 MB; readable duration of at most 5 minutes plus 2 seconds tolerance |
| Audio and archives | mp3, wav, ogg, flac, m4a, aac, zip, rar | 15 MB |

Each message allows at most 10 files, including at most 5 PDFs. Image dimensions/pixel count, PDF pages, and Word image counts follow the same rules as Glow. Current China production limits are 29900 pixels per image edge, 24999999 total pixels, and 800 PDF pages or Word images. Missing configuration, invalid files, audit failures, or preprocessing failures stop the entire message instead of silently dropping attachments.

Every file, including small Markdown/TXT files, is uploaded and audited before being sent as `name/url/mediaType/meta`. PDFs, Word documents, and Excel/CSV files use Glow's preprocessing services and retain their parsed metadata. File text and Base64 are never sent as attachment `content`. Progress goes to stderr; the creation message is sent once, after every attachment is ready. `--no-wait` still completes upload, audit, and preprocessing. Bundled dependencies read image dimensions and video duration locally without requiring FFmpeg. Do not upload `.env` or CLI credential files.

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
| 9 | Local state permission, I/O, lock contention, or recovery error |
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

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

The script prints the previous version, runs `npm version patch`, prints the new version, publishes to npm with the `latest` tag, and runs `git push origin main --follow-tags`. Versioning creates a Git commit and tag. Publishing uses the existing `prepack` type check and build, and your local npm credentials; npm may prompt for two-factor authentication.

Each failure stops the sequence. If publication is uncertain, check the target version on npm first. If npm publication succeeded but Git push failed, retry only `git push origin main --follow-tags`. Publishing to `latest` affects existing CLI users through its built-in update logic.

## Help

After installation, run help separately. These commands do not start login or create a project:

```bash
superun-ai --help
superun-ai chat --help
superun-ai chat style generate --help
```

## Command tree

The tree below lists command groups, positional arguments, and their purpose. Replace required arguments written as `<...>` with actual values. Use each command's `--help` to see its options and requirements.

```text
superun-ai
├── auth                                         # Manage PAT login
│   ├── login                                    # Sign in and save a PAT
│   ├── status                                   # Check local PAT configuration
│   └── logout                                   # Remove the locally saved PAT
├── session                                      # Query projects
│   ├── list                                     # List projects
│   └── get <sessionId>                          # Get project details
├── chat                                         # Conversational creation
│   ├── create                                   # Create a project and send a request
│   ├── send <sessionId>                         # Continue the conversation
│   ├── state <sessionId>                        # Inspect the task and interactions
│   ├── wait <sessionId>                         # Wait for input or a task result
│   ├── stop <sessionId>                         # Stop the remote task
│   ├── style                                    # Manage creative styles
│   │   ├── generate <sessionId>                 # Generate style candidates
│   │   ├── list <sessionId>                     # List style batches
│   │   └── select <sessionId> <choiceId>        # Choose a style and generate the development plan
│   ├── demo <sessionId>                         # View the demo and record it as viewed
│   ├── develop <sessionId>                      # Keep the demo and plan development
│   ├── interaction                              # Answer or skip interactions
│   │   ├── reply <sessionId> <interactionId>    # Submit an answer
│   │   └── skip <sessionId> <interactionId>     # Skip an eligible interaction
│   ├── plugin                                   # Query, enable, and disable plugins
│   │   ├── list <sessionId>                     # List available plugins
│   │   ├── status <sessionId> <pluginId>        # Inspect a plugin
│   │   ├── enable <sessionId> <pluginId>        # Enable a plugin
│   │   └── disable <sessionId> <pluginId>       # Disable a plugin
│   └── publish                                  # Publish applications and manage visibility
│       ├── status <sessionId>                   # Query versions and deployment progress
│       ├── start <sessionId> <encryptedId>      # Publish a specific version
│       └── visibility <sessionId> <visibility>  # Make the site public or private
├── update                                       # Check and install the required version
└── version                                      # Show local and output-schema versions
```

## PAT login

```bash
superun-ai auth login
superun-ai auth status
superun-ai auth logout
```

`auth login` reuses an existing PAT. If none is configured, it opens the Superun website so you can sign in and obtain a PAT, then saves it locally without requiring you to copy it. When you first run a business command in an interactive terminal without a PAT, the CLI uses the same login flow and then resumes the original command.

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

Chat task responses also include `taskProgress`. During development with an approved plan in the current user’s round, `tasks` primarily contains selected or completed features and their internal steps, read independently from the same `internal/features.json` and `internal/todos.json` used by Glow. Steps are joined by the actual `featureId`; `steps` preserves their text, order, and `pending / in_progress / completed` status, while `stepProgress` contains the actual completed and total counts. Legacy Todos without a feature ID are not assigned to another feature. Features without steps display a pending-generation notice rather than a fabricated 0/0. The card no longer includes execution details, duplicate message/subtask tables, or tool counts. After the whole round reaches `COMPLETED`, preserve the original completion text in `messages`, preview links, and existing continue-creation / launch guidance. Do not replace the reply with a step table or completion card. Only append `toolUsage.markdown` after the completion text. The count uses the same current-round `activity.summary.toolCount` as Glow’s completion bubble, without adding subtask counts. Read, edit, and deployment counts are not displayed separately; missing statistics are explicitly reported as unavailable.

Other stages, or projects without displayable features, retain the original task list. Background tasks are deduplicated by identity; other-member or unknown-owner background tasks expose status only. `markdown` is a ready-to-display card. `revision` tracks visible step and status changes (tool counts do not affect the card revision), and feature progress refreshes even when the parent message is unchanged. Failed reads or malformed data fall back to execution status with `complete: false` and `warnings`; missing steps are never treated as completed, and percentages are not estimated.

While `chat wait` or a write command is waiting, progress from every polling iteration is emitted as newline-delimited JSON on stderr with `event: "task_progress"`; the card is in `data.taskProgress.markdown`. Host agents should read output from the running command and display every task. Update the same card using `taskProgress.id` when supported; otherwise display the current snapshot on every query, including when `changed: false`. Progress events are not final results: continue waiting on the same process without interrupting or resubmitting the task. stdout still emits a single command result.

Overall completion retains the existing session, message, interaction, and background-work rules. `taskProgress` is display-only: a completed item or changed card does not end the wait, and item counts do not determine overall completion. Existing early style-preview notifications, local timeouts, and user-input behavior remain unchanged. Pass `--progress-revision` with the previous revision to compute `changed`; it does not suppress progress output on subsequent queries, and `chat state` and `chat style list` also accept this option.

The CLI connects to Superun by default. Use the global `--endpoint <URL>` option to specify an API endpoint and `--locale <language>` to choose the response language.

## Answering interactions

When the CLI returns `NEEDS_INPUT`, read the questions, allowed `actions`, and `answerSchema` in `interactions`. Always reply using the `interactionId` from that result.

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

Selection indices start at `0`. Skip only when the interaction allows `SKIP`. Completing the requirements questionnaire starts style generation directly; omit `action` or use `GENERATE_STYLES`. The `SUBMIT` example above applies to ordinary questions. Stage transitions, database approvals, and other interactions use their own returned actions.

For secret input, submit `{"values":{"requested-key":"secret-value"}}` with only the requested keys. Values are not echoed. Stale or ambiguous interactions are rejected; query the current state again.

`chat interaction reply --no-wait` controls waiting for subsequent creation after the reply has been processed. Some plugin configuration steps must finish in the foreground before submitting their interaction result; this option does not skip those steps. After an interruption, check the plugin and conversation states first.

## Styles, plugins, and publishing

Interactions, styles, plugins, and publishing belong under `chat`. Use `chat interaction`, `chat style`, `chat plugin`, and `chat publish`; they are not top-level commands.

```bash
superun-ai chat style generate <sessionId> --content "Create a clean brand style" --count 2
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

Style generation defaults to two candidates and supports one to four. Use the returned `choiceId` to select a style. Publishing uses the returned `encryptedId` and tracks the selected version's deployment. Plugin IDs come from `chat plugin list`.

Style waiting returns progress as soon as one candidate succeeds and its screenshot is ready, while the batch remains `RUNNING`. Show that candidate and its screenshot link immediately, then follow `QUERY_STYLES` to keep checking the remaining candidates. For example: “Style B is ready; waiting for style A.” Labels A/B/C/D correspond to the original `index` 0/1/2/3, regardless of completion order. Announce each `choiceId` only once and wait for the user's selection after the batch finishes.

After the user selects a style, `chat style select` waits for its demo, completes the demo transition and preserves the version internally, then generates the development plan. Show only that the selected style is being used to prepare the plan, without demo-stage prompts or additional questions. Keep the existing plan content and confirmation/adjustment guidance unchanged; the feature-selection step follows plan approval. After `--no-wait` or a local timeout, follow `CONTINUE_STYLE_PLANNING` with `chat wait` to check the current state and resume the transition. `chat state` remains read-only, and existing projects can still use `chat demo` and `chat develop`.

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

# superun-ai-cli 安装与配置指南

[English README](README.en.md) | [中文 README](README.md)

本指南供 AI Agent 协助用户安装和配置 CLI。请使用用户的语言说明进度，只完成安装、登录和只读验证，不自动创建、修改或发布项目。

- npm 包名：`superun-ai-cli`。
- 命令名：`superun-ai`。
- 官方仓库：<https://github.com/AiGuangInc/superun-ai-cli>。
- 默认服务：<https://superun.com>。不要擅自指定其他服务地址。

## 1. 检查环境

本指南中的 npm 命令表示要执行的参数。AI 安装助手执行任何 npm 命令（包括 `--version`、`view` 和 `install`）时，都必须按下一节隔离配置与子进程环境，不能直接继承当前 Shell 的全部配置。

```bash
node --version
npm --version
```

需要 Node.js 22 或更新版本和 npm。缺少依赖或版本不满足时，说明问题并征得用户同意后再安装或升级；不要擅自更换用户的 Node.js 管理方式、修改全局配置或使用 `sudo`。

如果 `superun-ai` 已存在，先检查其路径及 `superun-ai version`，区分 npm 安装和源码目录链接。保留现有凭据及用户未提交的代码，不卸载或覆盖其他工具。

WorkBuddy 等工具可能使用自带 Node/npm，与普通终端的安装位置不同。安装助手应在实际执行业务的环境里完成安装与验证，不把区分环境、查 PATH 或手动升级交给用户。使用当前 Node 对应的 npm；不要根据另一套终端的安装结果判断当前工具已经可用，也不要切换出宿主允许的执行环境。

## 2. 通过 npm 安装

### 安装助手的无凭证执行方式

首次安装、版本查询及旧版升级统一使用以下方式；由安装助手准备并执行，不要求用户读取凭证或修改自己的 npm 配置：

- 按当前 Node 和 PATH 定位 npm 可执行文件，解析符号链接得到 `npm-cli.js`，通过当前 Node 直接启动它；不读取 `.npmrc` 来定位 npm，也不执行 `npm config list/get`。
- 为 npm 子进程新建环境，只传系统运行所需的 PATH、HOME、临时目录、Windows 系统目录、语言，以及代理、CA/证书、缓存配置。不要复制整个环境后仅删除几个已知 Token 名；不传 npm Token、Superun PAT、其他业务凭证和 `NODE_OPTIONS`。主进程中的 Superun 登录配置保持不变。
- 在子进程中固定 `npm_config_userconfig = os.devNull`、`npm_config_globalconfig = path.join(os.devNull, 'superun-empty-npmrc')`、`npm_config_global = 'true'`、`npm_config_registry = 'https://registry.npmjs.org/'`，不继承其他 npm 配置。两份空配置使用不同路径；全局模式跳过项目 `.npmrc`。跨平台路径由 Node 的 `node:os`、`node:path` 计算。
- 使用下列命令参数安装公开包，并关闭安装脚本、审计与捐助提示。捕获 npm 输出，只报告安装结果、版本或错误码，不把 npm 原始日志发给模型，也不通过打印环境变量排查认证。
- 旧版在启动更新前被拦截时，不反复执行旧版业务命令；在同一 Node 环境按上述方式安装新版，再验证 `superun-ai version`。安装来源、权限或网络问题应如实报告，不要求用户关闭宿主的敏感信息保护。

`superun-ai-cli` 已发布到 npm，默认安装公开包，无需 Git、源码构建或 npm 发布账号：

```bash
npm install -g superun-ai-cli --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
```

需要核对当前发布版本时，可以只读查询：

```bash
npm view superun-ai-cli name version dist-tags --registry=https://registry.npmjs.org --json
```

- 安装成功后继续验证命令，再引导用户登录 Superun。
- 如果返回 `E404`、网络、证书、权限或其他错误，如实说明并检查 npm 官方 Registry 的访问情况，不自动切换包名、镜像源或源码安装方式。
- 更新现有安装时，保留用户的 Superun 凭据；不要求重新导入 PAT。
- 公开包安装、版本查询及旧入口修复均由安装助手在当前执行环境完成。使用当前 Node 启动对应 npm，以空用户/全局配置执行，禁止读取用户 npmrc 或继承 npm 登录 Token；保留必要的代理和证书环境变量。不要把 npm 凭证授权、环境切换或升级命令转交给用户，也不要关闭宿主的权限保护。

### 可选：用户明确要求从源码安装

需要 Git 和仓库访问权限。先确认安装目录；若已有本仓库，复用该目录并检查 `git status` 和 remote，不覆盖未提交改动、不强制切换分支。

源码安装的 `npm ci` 使用本地模式，并将用户、全局配置指向上述空路径；若项目 `.npmrc` 需要私有源认证，说明具体依赖要求，不读取凭证明文。构建显式执行项目脚本，不使用公开包安装的 `--ignore-scripts` 替代构建。

新目录安装示例：

```bash
git clone https://github.com/AiGuangInc/superun-ai-cli.git
cd superun-ai-cli
npm ci
npm run build
npm install -g .
```

逐条执行，失败即停。`npm run build` 会先清理 `dist` 再构建。仓库访问失败时，说明需要的访问权限，不索取 GitHub 凭据明文。安装任务不修改包名、版本或发包配置，也不执行 `npm publish`。

源码安装可能把全局命令链接到当前目录，因此应保留源码目录。以后修改源码时重新构建；全局命令若不是源码链接，再执行 `npm install -g .`。源码安装与 npm 安装均遵循 npm `latest` 版本检查，不绕过校验。

## 3. 单独验证命令安装

业务命令缺少 PAT 时会直接尝试打开系统默认浏览器，包括 Agent 的非 TTY Shell；完成网页登录后自动继续原操作，不需要用户另行执行登录命令。无法打开浏览器时仍展示登录链接并等待登录结果。

安装完成后再运行帮助和版本命令：

```bash
superun-ai --help
superun-ai version
```

确认命令可以启动。若提示找不到命令，检查当前终端的 `PATH`、所用 Node.js 安装及 npm 全局目录；不要把它误判为业务登录失败。不要通过全量打印环境变量来排查，避免泄露凭据。

业务命令会先检查 npm `latest`，在独立目录安装并验证新版，切换默认执行入口后继续；原 npm 安装作为启动入口保留，普通终端和工具自带环境各自维护版本。业务执行不清理旧版本或失败安装目录，不通过原地全局更新触发旧包批量删除。版本查询或更新失败时停止业务，不回退旧版继续请求。公开包更新不需要 npm 登录 Token，不让模型读取 npm 凭证明文。版本校验失败时先处理 Registry 访问或安装错误，不清除 Superun 凭据。旧入口如在加载新版之前就失败，由安装助手在同一环境完成一次升级并验证，再继续用户任务，不要求用户自行查路径或敲命令；宿主要求权限时仍按实际授权流程处理。

## 4. 引导用户登录

先查询本地配置状态：

```bash
superun-ai auth status
```

- 返回 `CONFIGURED`：复用已有 PAT，不先执行 `auth logout`，也不要求用户重复登录。
- 明确提示未配置 PAT：执行下面的登录命令，让用户本人在浏览器完成登录。
- 提示凭据文件异常、版本检查失败或其他错误：说明错误，等待用户决定如何处理，不删除凭据或无限循环登录。

```bash
superun-ai auth login
```

CLI 会打开 Superun 登录页面，完成后领取 PAT 并保存到本地。浏览器未自动打开时，把 CLI 打印的登录地址提供给用户。保持登录命令运行，等它返回成功；不要另起重复登录流程。等待期间告诉用户需要完成网页登录，超时或取消时如实说明。

如果用户明确要导入已有 PAT，请让用户在自己的交互式终端执行：

```bash
superun-ai auth login --pat
```

`--pat` 后不能跟凭据值，由终端隐藏读取。不要让用户把 PAT 发到聊天里，也不要读取或展示凭据文件内容。已安全设置 `SUPERUN_PAT` 的自动化环境可直接复用；需要持久化时可通过 `auth login --stdin` 输入，但不得回显或记录秘密。

## 5. 只读验证线上访问

登录完成后执行：

```bash
superun-ai session list --limit 1
```

返回 `ok: true`、`state: COMPLETED` 表示查询成功；空列表也是正常结果，不要为了验证自动创建项目。`auth status` 只证明本地有配置，不能替代本次实际访问校验。

如果返回鉴权错误，先说明现有 PAT 或权限校验未通过，由用户决定是否重新登录；不要自动清除 PAT、切换账号或更换服务地址。其他网络或业务错误也应如实反馈。

## 6. 向用户交付结果

简要告知安装来源、实际版本、命令是否可用、登录与只读验证结果，并给出下一步入口：

```bash
superun-ai --help
```

只在用户随后提出创作需求时才调用 `chat create`。安装配置本身不代表用户授权创建项目、启用插件、发布应用、改变站点可见性或发 npm 包。

## 7. 用户要求卸载时

仅在用户明确要求卸载时执行。先清除本地 PAT，成功后再卸载程序；清理失败时先处理错误，不跳过清理：

```bash
superun-ai auth logout && npm uninstall -g superun-ai-cli
```

`npm uninstall` 不会自动执行 `logout`。如果配置过 `SUPERUN_PAT`，提醒用户在自己的终端执行 `unset SUPERUN_PAT`，并从设置它的 Shell 配置或运行环境中移除；子进程无法替用户清除父终端的环境变量。不要输出变量值。此流程不注销浏览器登录，也不撤销服务端 PAT。

<!-- @author xiuyu.yi -->

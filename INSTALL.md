# superun-ai-cli 安装与配置指南

[English README](README.en.md) | [中文 README](README.md)

本指南供 AI Agent 协助用户安装和配置 CLI。请使用用户的语言说明进度，只完成安装、登录和只读验证，不自动创建、修改或发布项目。

- npm 包名：`superun-ai-cli`。
- 命令名：`superun-ai`。
- 官方仓库：<https://github.com/AiGuangInc/superun-ai-cli>。
- 默认服务：<https://superun.com>。不要擅自指定其他服务地址。

## 1. 检查环境

```bash
node --version
npm --version
```

需要 Node.js 22 或更新版本和 npm。缺少依赖或版本不满足时，说明问题并征得用户同意后再安装或升级；不要擅自更换用户的 Node.js 管理方式、修改全局配置或使用 `sudo`。

如果 `superun-ai` 已存在，先检查其路径及 `superun-ai version`，区分 npm 安装和源码目录链接。保留现有凭据及用户未提交的代码，不卸载或覆盖其他工具。

## 2. 通过 npm 安装

`superun-ai-cli` 已发布到 npm，默认安装公开包，无需 Git、源码构建或 npm 发布账号：

```bash
npm install -g superun-ai-cli --registry=https://registry.npmjs.org
```

需要核对当前发布版本时，可以只读查询：

```bash
npm view superun-ai-cli name version dist-tags --registry=https://registry.npmjs.org --json
```

- 安装成功后继续验证命令，再引导用户登录 Superun。
- 如果返回 `E404`、网络、证书、权限或其他错误，如实说明并检查 npm 官方 Registry 的访问情况，不自动切换包名、镜像源或源码安装方式。
- 更新现有安装时，保留用户的 Superun 凭据；不要求重新导入 PAT。

### 可选：用户明确要求从源码安装

需要 Git 和仓库访问权限。先确认安装目录；若已有本仓库，复用该目录并检查 `git status` 和 remote，不覆盖未提交改动、不强制切换分支。

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

安装完成后再运行帮助和版本命令：

```bash
superun-ai --help
superun-ai version
```

确认命令可以启动。若提示找不到命令，检查当前终端的 `PATH`、所用 Node.js 安装及 npm 全局目录；不要把它误判为业务登录失败。不要通过全量打印环境变量来排查，避免泄露凭据。

业务命令会先检查 npm `latest`，本地版本不一致时自动安装并继续；也可以用 `superun-ai update` 主动同步。若版本校验失败，先处理 Registry 访问或安装错误，不清除 Superun 凭据。

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

<!-- @author xiuyu.yi -->

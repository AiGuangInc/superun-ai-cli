/** npm 版本查询与安装共用网络配置，恢复过程不打断业务输出。@author xiuyu.yi */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valid } from 'semver';
import { NPM_REGISTRY, PACKAGE_NAME, PACKAGE_PRIVATE } from '../config/constants.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';

const execute = promisify(execFile);
const NETWORK_CONFIG = new Set(['proxy', 'https-proxy', 'noproxy', 'ca', 'cafile', 'strict-ssl', 'cache']);
const PUBLIC_NPM_ENV = new Set([
  'path',
  'home',
  'userprofile',
  'homedrive',
  'homepath',
  'systemroot',
  'windir',
  'comspec',
  'pathext',
  'appdata',
  'localappdata',
  'tmp',
  'temp',
  'tmpdir',
  'lang',
  'tz',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'node_extra_ca_certs',
  'node_use_system_ca',
  'node_use_env_proxy',
  'ssl_cert_file',
  'ssl_cert_dir',
]);
let npmRuntime: Promise<{ entry: string; prefix?: string }> | undefined;
export const NPM_FETCH_OPTIONS = [
  '--fetch-retries=2',
  '--fetch-retry-mintimeout=1000',
  '--fetch-retry-maxtimeout=3000',
  '--fetch-timeout=15000',
];

export class NpmCommandError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function resolveNpmRuntime(): Promise<{ entry: string; prefix?: string }> {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    join(nodeDirectory, 'npm'),
    process.env.npm_execpath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .flatMap((path) => [join(path, 'npm'), join(path, 'node_modules/npm/bin/npm-cli.js')]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const entry = await realpath(candidate).catch(() => undefined);
    if (!entry || basename(entry) !== 'npm-cli.js' || !(await stat(entry).catch(() => undefined))?.isFile())
      continue;
    const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
    const modulesDirectory = dirname(packageDirectory);
    const container = dirname(modulesDirectory);
    // npm 全局安装的 CLI 固定更新自己的前缀，避免 PATH 指向另一套 Node/npm。
    const prefix =
      basename(modulesDirectory) === 'node_modules' && basename(container) === 'lib'
        ? dirname(container)
        : undefined;
    return { entry, prefix };
  }
  throw new NpmCommandError('NPM_NOT_FOUND');
}

function publicRegistry(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {
    // 不将可能包含凭证的 Registry 原始值传到诊断或子进程。
  }
  return undefined;
}

export async function runNpm(
  args: Array<string>,
  options: { registry?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<string> {
  const runtime = await (npmRuntime ??= resolveNpmRuntime());
  // 仅传运行和网络配置，避免任意名称的凭证、npm 登录信息或 Node 预加载脚本进入更新进程。
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const config = /^npm_config_(.*)$/i.exec(key)?.[1]?.toLowerCase().replace(/_/g, '-');
    if (config && NETWORK_CONFIG.has(config)) env[`npm_config_${config}`] = value;
    else if (PUBLIC_NPM_ENV.has(key.toLowerCase()) || /^lc_[a-z_]+$/i.test(key)) env[key] = value;
  }
  // 公开包更新不加载用户、全局或项目 npmrc，也不继承 npm 登录令牌。
  // 空设备及其不可作为文件的子路径提供两份空配置，无需创建或清理配置文件。
  env.npm_config_userconfig = devNull;
  env.npm_config_globalconfig = join(devNull, 'superun-empty-npmrc');
  env.npm_config_global = 'true';
  env.npm_config_registry = publicRegistry(options.registry) ?? NPM_REGISTRY;
  if (runtime.prefix) env.npm_config_prefix = runtime.prefix;
  try {
    const { stdout } = await execute(process.execPath, [runtime.entry, ...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 55_000,
      killSignal: 'SIGKILL',
      maxBuffer: 2_000_000,
      cwd: options.cwd,
      // 使用当前 Node 启动 npm，保留环境中的代理和证书配置，不回显 npm 原始诊断。
      env,
    });
    return stdout.trim();
  } catch (error) {
    const failure = object(error);
    const stderr = text(failure.stderr) ?? '';
    const reason = failure.killed
      ? 'ETIMEDOUT'
      : typeof failure.code === 'string'
        ? failure.code
        : /npm (?:ERR!|error) code ([A-Z0-9_]+)/.exec(stderr)?.[1];
    throw new NpmCommandError(reason && /^[A-Z0-9_]+$/.test(reason) ? reason : 'NPM_REQUEST_FAILED');
  }
}

export async function latestVersion(): Promise<{ version: string; registry: string }> {
  if (PACKAGE_PRIVATE)
    throw new CliError(
      'UPDATE_REQUIRED',
      '当前为未发布的私有开发包；正式包名和 Registry 确认并发布后才能启用业务命令',
    );

  const registries = [NPM_REGISTRY];
  const configured = publicRegistry(process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY);
  if (configured && configured !== new URL(NPM_REGISTRY).href) registries.push(configured);

  const failures: Array<{ source: string; reason: string }> = [];
  for (const [index, registry] of registries.entries()) {
    try {
      const raw = await runNpm(
        ['view', PACKAGE_NAME, 'dist-tags.latest', '--json', '--prefer-online', ...NPM_FETCH_OPTIONS],
        { registry },
      );
      let version: unknown;
      try {
        version = JSON.parse(raw);
      } catch {
        throw new NpmCommandError('INVALID_VERSION_RESPONSE');
      }
      if (typeof version !== 'string' || valid(version) !== version)
        throw new NpmCommandError('INVALID_VERSION_RESPONSE');
      return { version, registry };
    } catch (error) {
      failures.push({
        source: index === 0 ? 'official' : 'configured',
        reason: error instanceof NpmCommandError ? error.reason : 'NPM_REQUEST_FAILED',
      });
    }
  }
  throw new CliError(
    'VERSION_CHECK_FAILED',
    '版本检查在自动重试后仍失败，请检查 npm 网络、代理或证书配置；业务请求未发送',
    { checks: failures },
  );
}

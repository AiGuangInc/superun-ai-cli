/** npm 版本查询与安装共用网络配置，恢复过程不打断业务输出。@author xiuyu.yi */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { valid } from 'semver';
import { NPM_REGISTRY, PACKAGE_NAME, PACKAGE_PRIVATE } from '../config/constants.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';

const execute = promisify(execFile);
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

export async function runNpm(
  args: Array<string>,
  options: { registry?: string; timeoutMs?: number } = {},
): Promise<string> {
  const env = { ...process.env };
  if (options.registry) {
    delete env.NPM_CONFIG_REGISTRY;
    env.npm_config_registry = options.registry;
  }
  try {
    const { stdout } = await execute('npm', args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 55_000,
      killSignal: 'SIGKILL',
      maxBuffer: 2_000_000,
      // Registry 可能包含认证信息，只通过环境传入，不回显命令或 npm 原始诊断。
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
  try {
    const configured = new URL(await runNpm(['config', 'get', 'registry'], { timeoutMs: 5000 }));
    if (
      ['https:', 'http:'].includes(configured.protocol) &&
      !configured.search &&
      !configured.hash &&
      configured.href !== new URL(NPM_REGISTRY).href
    )
      registries.push(configured.href);
  } catch {
    // 读取配置失败不妨碍官方源查询；npm 缺失等问题由下面的正式检查统一报告。
  }

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

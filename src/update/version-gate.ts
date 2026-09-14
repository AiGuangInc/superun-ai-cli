/** 业务请求之前强制更新本机 CLI 到 npm latest。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../config/constants.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { latestVersion, runNpm, NPM_FETCH_OPTIONS, NpmCommandError } from './npm-registry.js';

async function installedEntry(root: string, version: string): Promise<string | undefined> {
  const packageDirectory = join(root, PACKAGE_NAME);
  try {
    const metadata = object(JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')));
    const candidate = join(packageDirectory, 'dist', 'cli.js');
    if (metadata.name === PACKAGE_NAME && metadata.version === version && (await stat(candidate)).isFile())
      return candidate;
  } catch {
    /* 未完成安装的目录不作为可执行版本。 */
  }
  return undefined;
}

export async function versionGate(
  argv: Array<string>,
  _output: OutputWriter,
  updateOnly = false,
): Promise<{ reexecuted: boolean; version: string; exitCode?: number }> {
  const source = await latestVersion();
  const required = source.version;
  if (required !== PACKAGE_VERSION && process.env.SUPERUN_AI_CLI_REEXEC === '1')
    throw new CliError('UPDATE_FAILED', '重启后版本仍不匹配，已停止重复更新');

  let root: string;
  try {
    root = await runNpm(['root', '--global'], { timeoutMs: 5000 });
    if (!isAbsolute(root) || /[\r\n]/.test(root)) throw new Error();
  } catch (error) {
    throw new CliError('UPDATE_FAILED', '无法定位 npm 全局安装目录，业务请求未发送', {
      reason: error instanceof NpmCommandError ? error.reason : 'INVALID_INSTALL_DIRECTORY',
    });
  }

  // 校验真实安装入口，旧缓存版本启动到这里时也要把本机安装升级，避免下次仍从旧入口启动。
  let entry = await installedEntry(root, required);
  if (!entry) {
    try {
      await runNpm(
        [
          'install',
          '--global',
          `${PACKAGE_NAME}@${required}`,
          '--package-lock=false',
          ...NPM_FETCH_OPTIONS,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { registry: source.registry, timeoutMs: 180_000 },
      );
    } catch (error) {
      throw new CliError('UPDATE_FAILED', 'npm 自动更新失败，业务请求未发送', {
        reason: error instanceof NpmCommandError ? error.reason : 'NPM_REQUEST_FAILED',
      });
    }
    entry = await installedEntry(root, required);
    if (!entry) throw new CliError('UPDATE_FAILED', '安装后的版本或执行入口校验失败，业务请求未发送');
  }
  if (updateOnly || required === PACKAGE_VERSION) return { reexecuted: false, version: required };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      shell: false,
      stdio: 'inherit',
      env: { ...process.env, SUPERUN_AI_CLI_REEXEC: '1' },
    });
    child.once('error', () => reject(new CliError('UPDATE_FAILED', '新版本命令启动失败')));
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  return { reexecuted: true, version: required, exitCode };
}

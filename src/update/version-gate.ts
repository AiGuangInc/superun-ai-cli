/** 业务请求之前强制校验 npm latest。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../config/constants.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { withUpdateLock } from './update-lock.js';
import { latestVersion, runNpm, NPM_FETCH_OPTIONS, NpmCommandError } from './npm-registry.js';

export async function versionGate(
  argv: Array<string>,
  _output: OutputWriter,
  updateOnly = false,
): Promise<{ reexecuted: boolean; version: string; exitCode?: number }> {
  let source = await latestVersion();
  let required = source.version;
  if (required === PACKAGE_VERSION) return { reexecuted: false, version: required };
  if (process.env.SUPERUN_AI_CLI_REEXEC === '1')
    throw new CliError('UPDATE_FAILED', '重启后版本仍不匹配，已停止重复更新');
  const entry = await withUpdateLock(async () => {
    source = await latestVersion();
    required = source.version;
    const root = join(homedir(), '.cache', PACKAGE_NAME, 'versions');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = join(root, required);
    const verifiedEntry = async (directory: string): Promise<string | undefined> => {
      const packageDirectory = join(directory, 'node_modules', PACKAGE_NAME);
      try {
        const metadata = object(JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')));
        const candidate = join(packageDirectory, 'dist', 'cli.js');
        if (
          metadata.name === PACKAGE_NAME &&
          metadata.version === required &&
          (await stat(candidate)).isFile()
        )
          return candidate;
      } catch {
        /* 未完成安装的目录不作为可执行版本。 */
      }
      return undefined;
    };
    const cached = await verifiedEntry(destination);
    if (cached) return cached;
    const staging = await mkdtemp(join(root, `.${required}-`));
    try {
      await runNpm(
        [
          'install',
          '--prefix',
          staging,
          '--no-save',
          '--package-lock=false',
          `${PACKAGE_NAME}@${required}`,
          ...NPM_FETCH_OPTIONS,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { registry: source.registry, timeoutMs: 180_000 },
      ).catch((error: unknown) => {
        throw new CliError('UPDATE_FAILED', 'npm 自动更新失败，业务请求未发送', {
          reason: error instanceof NpmCommandError ? error.reason : 'NPM_REQUEST_FAILED',
        });
      });
      if (!(await verifiedEntry(staging)))
        throw new CliError('UPDATE_FAILED', '安装后的版本或执行入口校验失败');
      if (await stat(destination).catch(() => undefined))
        await rename(destination, `${destination}.invalid-${randomUUID()}`);
      await rename(staging, destination);
      return join(destination, 'node_modules', PACKAGE_NAME, 'dist', 'cli.js');
    } finally {
      // 只清理本次 mkdtemp 创建的安装暂存目录。
      await rm(staging, { recursive: true, force: true });
    }
  });
  if (updateOnly) return { reexecuted: false, version: required };
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

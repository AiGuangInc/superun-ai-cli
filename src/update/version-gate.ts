/** 业务请求前独立安装 npm latest，验证后静默切换并保留旧版本。@author xiuyu.yi */
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../config/constants.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { latestVersion, runNpm, NPM_FETCH_OPTIONS, NpmCommandError } from './npm-registry.js';
import { activateInstallation, activeEntry, installationRoot, verifiedEntry } from './installation.js';

const execute = promisify(execFile);

export async function versionGate(
  argv: Array<string>,
  _output: OutputWriter,
  updateOnly = false,
): Promise<{ reexecuted: boolean; version: string; exitCode?: number }> {
  const source = await latestVersion();
  const required = source.version;
  if (required === PACKAGE_VERSION) return { reexecuted: false, version: required };
  if (process.env.SUPERUN_AI_CLI_REEXEC === '1')
    throw new CliError('UPDATE_FAILED', '重启后版本仍不匹配，已停止重复更新');

  const { root, origin } = await installationRoot();
  let entry = await activeEntry(root, required);
  if (!entry) {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, `${required}-`));
      await runNpm(
        [
          'install',
          '--global=false',
          '--prefix',
          directory,
          `${PACKAGE_NAME}@${required}`,
          '--no-save',
          '--package-lock=false',
          ...NPM_FETCH_OPTIONS,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { registry: source.registry, timeoutMs: 180_000, cwd: directory },
      );
      entry = await verifiedEntry(directory, required);
      if (!entry) throw new Error('INVALID_INSTALLATION');
      // 激活前真实启动一次离线命令，验证模块与依赖完整；探测过程不输出给用户。
      const { stdout } = await execute(process.execPath, [entry, 'version'], {
        timeout: 15_000,
        maxBuffer: 1_000_000,
      });
      const result = object(JSON.parse(stdout));
      if (result.ok !== true || object(result.data).version !== required)
        throw new Error('INVALID_INSTALLATION');
      await activateInstallation(root, origin, basename(directory), required);
      // 成功与失败均保留独立目录，不在业务调用中清理旧包或安装残留。
    } catch (error) {
      throw new CliError('UPDATE_FAILED', 'npm 自动更新失败，业务请求未发送', {
        reason: error instanceof NpmCommandError ? error.reason : 'NPM_REQUEST_FAILED',
      });
    }
  }
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

/** 业务请求之前强制校验 npm latest。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { valid } from 'semver';
import { PACKAGE_NAME, PACKAGE_VERSION, PACKAGE_PRIVATE, NPM_REGISTRY } from '../config/constants.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { withUpdateLock } from './update-lock.js';

async function npm(args: Array<string>, output: OutputWriter, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (capture) captured += chunk.toString();
      else output.log(chunk.toString().trimEnd());
    });
    child.stderr.on('data', (chunk: Buffer) => output.log(chunk.toString().trimEnd()));
    child.once('error', () => reject(new CliError('UPDATE_FAILED', '无法执行 npm，请检查安装与 PATH')));
    child.once('close', (code) =>
      code === 0
        ? resolve(captured.trim())
        : reject(new CliError('UPDATE_FAILED', 'npm 更新失败，业务请求未发送')),
    );
  });
}

async function latestVersion(): Promise<string> {
  if (PACKAGE_PRIVATE)
    throw new CliError(
      'UPDATE_REQUIRED',
      '当前为未发布的私有开发包；正式包名和 Registry 确认并发布后才能启用业务命令',
    );
  try {
    const response = await fetch(`${NPM_REGISTRY}${encodeURIComponent(PACKAGE_NAME)}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('registry');
    const data: unknown = await response.json();
    const latest = text(object(object(data)['dist-tags']).latest);
    if (!latest || valid(latest) !== latest) throw new Error('version');
    return latest;
  } catch {
    throw new CliError('VERSION_CHECK_FAILED', '无法确认 npm latest 版本，业务请求未发送');
  }
}

export async function versionGate(
  argv: Array<string>,
  output: OutputWriter,
  updateOnly = false,
): Promise<{ reexecuted: boolean; version: string; exitCode?: number }> {
  let required = await latestVersion();
  if (required === PACKAGE_VERSION) return { reexecuted: false, version: required };
  if (process.env.SUPERUN_CLI_REEXEC === '1')
    throw new CliError('UPDATE_FAILED', '重启后版本仍不匹配，已停止重复更新');
  const entry = await withUpdateLock(async () => {
    required = await latestVersion();
    const root = join(homedir(), '.cache', 'superun-creation-cli', 'versions');
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
      await npm(
        [
          'install',
          '--prefix',
          staging,
          '--no-save',
          '--package-lock=false',
          `${PACKAGE_NAME}@${required}`,
          '--registry',
          NPM_REGISTRY,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        output,
      );
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
      env: { ...process.env, SUPERUN_CLI_REEXEC: '1' },
    });
    child.once('error', () => reject(new CliError('UPDATE_FAILED', '新版本命令启动失败')));
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  return { reexecuted: true, version: required, exitCode };
}

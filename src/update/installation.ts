/** 独立安装与默认入口切换，业务命令不清理历史版本。@author xiuyu.yi */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME } from '../config/constants.js';
import { object } from '../contracts/value.js';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
const originFile = '.superun-update-origin.json';

export async function installationRoot(): Promise<{ root: string; origin: string }> {
  let origin = packageDirectory;
  try {
    const metadata = object(JSON.parse(await readFile(join(packageDirectory, originFile), 'utf8')));
    if (typeof metadata.origin === 'string' && isAbsolute(metadata.origin)) origin = metadata.origin;
  } catch {
    // 首次安装没有来源标记，以当前包作为稳定启动入口。
  }
  // 不同 Node 环境、源码目录及全局安装各自维护入口，更新不会串到另一套安装。
  const identity = createHash('sha256').update(`${process.execPath}\0${origin}`).digest('hex');
  return { root: join(homedir(), '.cache', PACKAGE_NAME, 'installations', identity), origin };
}

export async function verifiedEntry(directory: string, version: string): Promise<string | undefined> {
  const installedPackage = join(directory, 'node_modules', PACKAGE_NAME);
  try {
    const metadata = object(JSON.parse(await readFile(join(installedPackage, 'package.json'), 'utf8')));
    const entry = join(installedPackage, 'dist', 'cli.js');
    if (metadata.name === PACKAGE_NAME && metadata.version === version && (await stat(entry)).isFile())
      return realpath(entry);
  } catch {
    // 不完整的安装不作为可执行入口。
  }
  return undefined;
}

export async function activeEntry(root: string, version?: string): Promise<string | undefined> {
  try {
    const active = object(JSON.parse(await readFile(join(root, 'active.json'), 'utf8')));
    if (
      typeof active.directory !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(active.directory) ||
      typeof active.version !== 'string' ||
      (version !== undefined && active.version !== version)
    )
      return undefined;
    return verifiedEntry(join(root, active.directory), active.version);
  } catch {
    // 未切换过版本或入口损坏时保留原安装的启动能力。
  }
}

export async function activateInstallation(
  root: string,
  origin: string,
  directory: string,
  version: string,
): Promise<void> {
  await writeFile(
    join(root, directory, 'node_modules', PACKAGE_NAME, originFile),
    JSON.stringify({ origin }),
    { mode: 0o600, flag: 'wx' },
  );
  const pending = join(root, `.active-${randomUUID()}.json`);
  await writeFile(pending, JSON.stringify({ directory, version }), { mode: 0o600, flag: 'wx' });
  // 同目录原子替换小型入口记录；并发安装各用独立目录，原包与旧版本始终保留。
  await rename(pending, join(root, 'active.json'));
}

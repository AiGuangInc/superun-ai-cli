/** 本机更新串行锁。@author xiuyu.yi */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CREDENTIAL_DIRECTORY } from '../auth/pat-store.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';

export async function withUpdateLock<T>(
  action: () => Promise<T>,
  directory = CREDENTIAL_DIRECTORY,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'update.lock');
  const contents = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: Date.now() });
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (object(error).code !== 'EEXIST') throw new CliError('UPDATE_FAILED', '无法创建更新锁');
      try {
        const previous = await readFile(path, 'utf8');
        const lock = object(JSON.parse(previous));
        if (typeof lock.pid === 'number' && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
          try {
            process.kill(lock.pid, 0);
          } catch (failure) {
            if (object(failure).code === 'ESRCH' && (await readFile(path, 'utf8')) === previous)
              await unlink(path);
          }
        }
      } catch {
        /* 锁正在初始化或被其他进程清理，下一轮重新竞争。 */
      }
      if (Date.now() >= deadline) throw new CliError('UPDATE_FAILED', '等待其他 CLI 进程更新超时');
      await delay(500);
    }
  }
  try {
    return await action();
  } finally {
    if ((await readFile(path, 'utf8').catch(() => '')) === contents) await unlink(path);
  }
}

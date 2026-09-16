/** 按环境和凭据隔离交互草稿，串行保存回答与创建进度。@author xiuyu.yi */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../output/exit-codes.js';
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class InteractionDraftStore {
  constructor(
    private readonly scope: string,
    private readonly root = join(homedir(), '.config/superun-ai-cli/interactions'),
  ) {}
  private path(key: string) {
    return join(this.root, this.scope, `${fingerprint(key)}.json`);
  }
  async read(key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CliError('PROTOCOL_ERROR', '交互草稿无法读取，请保留文件排查，勿重复创建');
    }
  }
  async write(key: string, value: unknown): Promise<void> {
    await mkdir(join(this.root, this.scope), { recursive: true, mode: 0o700 });
    const path = this.path(key),
      temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }
  async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    await mkdir(join(this.root, this.scope), { recursive: true, mode: 0o700 });
    const path = `${this.path(key)}.lock`;
    // 不回收无法确认归属的锁。已退出进程的遗留锁可在下一次操作恢复。
    let lock;
    try {
      lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 遗留锁回收也必须互斥，避免两个恢复进程误删对方刚取得的新锁。
      const recoveryPath = `${path}.recovery`;
      let recovery;
      try {
        recovery = await open(recoveryPath, 'wx', 0o600);
      } catch {
        throw new CliError('AMBIGUOUS_INTERACTION', '交互锁正在恢复，请稍后查询状态');
      }
      try {
        let dead = false;
        try {
          const pid = Number(await readFile(path, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (cause) {
              dead = (cause as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }
        } catch {
          /* 未写完的锁不能抢占。 */
        }
        if (!dead) throw new CliError('AMBIGUOUS_INTERACTION', '当前交互正在处理，请稍后查询状态');
        await unlink(path);
        try {
          lock = await open(path, 'wx', 0o600);
        } catch {
          throw new CliError('AMBIGUOUS_INTERACTION', '当前交互正在处理，请稍后查询状态');
        }
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
    }
    try {
      await lock.writeFile(String(process.pid));
      return await run();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }
}

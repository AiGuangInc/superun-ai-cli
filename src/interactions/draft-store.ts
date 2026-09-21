/** 按环境和凭据隔离交互草稿，串行保存回答与创建进度。@author xiuyu.yi */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stateDirectory } from '../config/state-directory.js';
import { CliError } from '../output/exit-codes.js';
import { filesystemCode, stateOperation, withStateCleanup } from './state-storage.js';

export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
// 同一进程同一目录只检查一次；实际操作仍处理权限变化与磁盘异常。
const checkedDirectories = new Map<string, Promise<void>>();

export class InteractionDraftStore {
  constructor(
    private readonly scope: string,
    private readonly root = stateDirectory('interactions'),
  ) {}
  private path(key: string) {
    return join(this.root, this.scope, `${fingerprint(key)}.json`);
  }
  async read(key: string): Promise<unknown> {
    const path = this.path(key);
    const content = await stateOperation('read', path, async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (filesystemCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    });
    if (content === undefined) return undefined;
    try {
      return JSON.parse(content);
    } catch {
      throw new CliError('PROTOCOL_ERROR', '本地状态文件格式无效，请保留文件排查，勿重复创建', { path });
    }
  }
  private remove(path: string): Promise<void> {
    return stateOperation('unlink', path, async () => {
      try {
        await unlink(path);
      } catch (error) {
        if (filesystemCode(error) !== 'ENOENT') throw error;
      }
    });
  }
  private close(file: FileHandle, path: string): Promise<void> {
    return stateOperation('close', path, () => file.close());
  }
  private async writeFile(path: string, content: string): Promise<void> {
    const file = await stateOperation('create', path, () => open(path, 'wx', 0o600));
    await withStateCleanup(async () => {
      await stateOperation('write', path, () => file.writeFile(content));
      await stateOperation('fsync', path, () => file.sync());
    }, [() => this.close(file, path)]);
  }
  private prepare(): Promise<void> {
    const directory = resolve(this.root, this.scope);
    let checked = checkedDirectories.get(directory);
    if (!checked) {
      checked = this.checkDirectory(directory).catch((error: unknown) => {
        checkedDirectories.delete(directory);
        throw error;
      });
      checkedDirectories.set(directory, checked);
    }
    return checked;
  }
  private async checkDirectory(directory: string): Promise<void> {
    await stateOperation('mkdir', directory, () => mkdir(directory, { recursive: true, mode: 0o700 }));
    const temp = join(directory, `.state-probe-${randomUUID()}.tmp`);
    const target = `${temp}.ready`;
    // 检查失败最多留下诊断文件，不能先创建真实业务锁；清理失败保留路径。
    await withStateCleanup(async () => {
      await this.writeFile(temp, '{}');
      await stateOperation('rename', temp, () => rename(temp, target));
      // 同时验证覆盖已存在文件的原子改名，避免首次绑定成功、后续更新才失败。
      await this.writeFile(temp, '{}');
      await stateOperation('rename', temp, () => rename(temp, target));
    }, [() => this.remove(temp), () => this.remove(target)]);
  }
  async write(key: string, value: unknown): Promise<void> {
    await this.prepare();
    const path = this.path(key),
      temp = `${path}.${randomUUID()}.tmp`;
    await withStateCleanup(async () => {
      await this.writeFile(temp, JSON.stringify(value));
      await stateOperation('rename', temp, () => rename(temp, path));
    }, [() => this.remove(temp)]);
  }
  private async owner(path: string): Promise<number | undefined> {
    const content = await stateOperation('read-lock', path, async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (filesystemCode(error) === 'ENOENT')
          throw new CliError('LOCAL_STATE_LOCKED', '本地状态锁已变化，请重新查询状态', { path });
        throw error;
      }
    });
    const pid = Number(content);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
  private async alive(pid: number, path: string): Promise<boolean> {
    return stateOperation('check-lock-owner', path, async () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (filesystemCode(error) === 'ESRCH') return false;
        throw error;
      }
    });
  }
  private recoveryRequired(path: string, lockPid?: number): CliError {
    return new CliError(
      'LOCAL_STATE_RECOVERY_REQUIRED',
      '本地状态锁无法安全自动回收；请先确认没有写入进程，再备份并恢复所列锁文件，不要反复重试或按文件年龄强制删除',
      { path, lockPid },
    );
  }
  async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    await this.prepare();
    const path = `${this.path(key)}.lock`;
    let lock: FileHandle | undefined;
    const acquire = () => open(path, 'wx', 0o600);
    return withStateCleanup(async () => {
      // 恢复分支清理失败时，外层仍会释放刚取得的业务锁。
      await stateOperation('acquire-lock', path, async () => {
        try {
          lock = await acquire();
          return;
        } catch (error) {
          if (filesystemCode(error) !== 'EEXIST') throw error;
        }
        const recoveryPath = `${path}.recovery`;
        const recovery = await stateOperation('acquire-recovery-lock', recoveryPath, async () => {
          try {
            return await open(recoveryPath, 'wx', 0o600);
          } catch (error) {
            if (filesystemCode(error) !== 'EEXIST') throw error;
            const pid = await this.owner(recoveryPath);
            if (pid !== undefined && (await this.alive(pid, recoveryPath)))
              throw new CliError('LOCAL_STATE_LOCKED', '本地状态锁正在恢复，请等待持有进程结束', {
                path: recoveryPath,
                lockPid: pid,
              });
            // 旧空锁或已退出恢复进程的锁无法凭年龄判断归属，必须显式维护。
            throw this.recoveryRequired(recoveryPath, pid);
          }
        });
        await withStateCleanup(async () => {
          await stateOperation('write-lock-owner', recoveryPath, () =>
            recovery.writeFile(String(process.pid)),
          );
          const pid = await this.owner(path);
          if (pid === undefined) throw this.recoveryRequired(path);
          if (await this.alive(pid, path))
            throw new CliError('LOCAL_STATE_LOCKED', '本地状态正在由其他进程更新，请等待该进程结束', {
              path,
              lockPid: pid,
            });
          await this.remove(path);
          try {
            lock = await acquire();
          } catch (error) {
            if (filesystemCode(error) !== 'EEXIST') throw error;
            throw new CliError('LOCAL_STATE_LOCKED', '其他进程已取得本地状态锁，请稍后查询', { path });
          }
        }, [() => this.close(recovery, recoveryPath), () => this.remove(recoveryPath)]);
      });
      await stateOperation('write-lock-owner', path, () => lock!.writeFile(String(process.pid)));
      return run();
    }, [
      async () => {
        if (lock) await this.close(lock, path);
      },
      async () => {
        if (lock) await this.remove(path);
      },
    ]);
  }
}

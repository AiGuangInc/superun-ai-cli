/** 通用辅助会话映射：单文件直接写入，不加锁、不改名、不删除。@author xiuyu.yi */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { object } from '../contracts/value.js';
import { filesystemCode, stateOperation } from '../interactions/state-storage.js';

type Bindings = Record<string, Record<string, string>>;
export class ProjectBindings {
  constructor(
    private readonly path: string,
    private readonly scope: string,
  ) {}

  private async load(): Promise<Bindings> {
    const content = await stateOperation('read', this.path, async () => {
      try {
        return await readFile(this.path, 'utf8');
      } catch (error) {
        if (filesystemCode(error) === 'ENOENT') return '';
        throw error;
      }
    });
    // 这是辅助缓存。直接覆盖过程中的不完整内容不阻断显式项目操作。
    try {
      const value = object(JSON.parse(content));
      const bindings: Bindings = Object.create(null);
      for (const [scope, entries] of Object.entries(value)) {
        bindings[scope] = Object.create(null);
        for (const [key, sessionId] of Object.entries(object(entries))) {
          if (typeof sessionId === 'string' && sessionId.trim()) bindings[scope]![key] = sessionId;
        }
      }
      return bindings;
    } catch {
      return {};
    }
  }
  async read(key: string): Promise<string | undefined> {
    return (await this.load())[this.scope]?.[key];
  }
  async write(key: string, sessionId?: string): Promise<void> {
    const bindings = await this.load();
    const entries = bindings[this.scope] ?? (bindings[this.scope] = Object.create(null));
    if (entries[key] === sessionId) return;
    if (sessionId) entries[key] = sessionId;
    else delete entries[key];
    await stateOperation('mkdir', dirname(this.path), () =>
      mkdir(dirname(this.path), { recursive: true, mode: 0o700 }),
    );
    await stateOperation('write', this.path, () =>
      writeFile(this.path, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 }),
    );
  }
}

/** PAT 的安全输入和本地存储。@author xiuyu.yi */
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PACKAGE_NAME, PAT_PREFIX } from '../config/constants.js';
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';

export const CREDENTIAL_DIRECTORY = join(homedir(), '.config', PACKAGE_NAME);

export function validatePat(value: string): string {
  const pat = value.trim();
  if (!pat.startsWith(PAT_PREFIX) || !/^sup_pat_[A-Za-z0-9_-]+$/.test(pat)) {
    throw new CliError('AUTH_REQUIRED', '请输入以 sup_pat_ 开头的有效 PAT');
  }
  return pat;
}

export class PatStore {
  constructor(private readonly directory = CREDENTIAL_DIRECTORY) {}

  async read(): Promise<{ pat: string; source: 'env' | 'file' }> {
    if (process.env.SUPERUN_PAT !== undefined)
      return { pat: validatePat(process.env.SUPERUN_PAT), source: 'env' };
    const path = join(this.directory, 'credentials.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new CliError('AUTH_REQUIRED', '本地凭据必须为权限 0600 的普通文件，请重新执行 auth login');
      }
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      return { pat: validatePat(text(object(value).pat) ?? ''), source: 'file' };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('AUTH_REQUIRED', '未找到有效 PAT，请执行 auth login 或设置 SUPERUN_PAT');
    }
  }

  async save(pat: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.credentials-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pat: validatePat(pat), createdAt: new Date().toISOString() }));
      await handle.sync();
      await handle.close();
      await rename(temporary, join(this.directory, 'credentials.json'));
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(join(this.directory, 'credentials.json'));
    } catch (error) {
      if (object(error).code !== 'ENOENT') throw new CliError('AUTH_REQUIRED', '本地凭据清除失败');
    }
  }
}

export async function readPatFromStdin(hidden: boolean): Promise<string> {
  if (!hidden) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 4096) throw new CliError('INVALID_ARGUMENT', 'PAT 输入过长');
    }
    return validatePat(input);
  }
  if (!process.stdin.isTTY) throw new CliError('INVALID_ARGUMENT', '非终端输入请使用 auth login --stdin');
  process.stderr.write('请输入 PAT（输入不显示）：');
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let input = '';
    const finish = (error?: CliError) => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else {
        try {
          resolve(validatePat(input));
        } catch (failure) {
          reject(failure);
        }
      }
    };
    const receive = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new CliError('INTERRUPTED', '已取消登录'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') input = input.slice(0, -1);
        else input += character;
        if (input.length > 4096) {
          finish(new CliError('INVALID_ARGUMENT', 'PAT 输入过长'));
          return;
        }
      }
    };
    process.stdin.on('data', receive);
  });
}

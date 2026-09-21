/** 各宿主共用的持久化状态目录，不影响凭据与安装缓存。@author xiuyu.yi */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { CliError } from '../output/exit-codes.js';

export function stateDirectory(kind: 'sessions' | 'interactions'): string {
  const configured = process.env.SUPERUN_STATE_DIR;
  if (configured === undefined) return join(homedir(), '.config/superun-ai-cli', kind);
  if (!configured.trim() || !isAbsolute(configured))
    throw new CliError('INVALID_ARGUMENT', 'SUPERUN_STATE_DIR 必须是宿主允许读写的持久化目录绝对路径');
  return join(normalize(configured), kind);
}

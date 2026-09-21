/** 通用用户级状态目录，不依赖宿主或当前工作目录。@author xiuyu.yi */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function stateDirectory(kind?: 'interactions'): string {
  const configured = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_STATE_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : process.platform === 'win32'
        ? join(homedir(), 'AppData', 'Local')
        : join(homedir(), '.local', 'state');
  const root = join(base, 'superun-ai-cli');
  return kind ? join(root, kind) : root;
}

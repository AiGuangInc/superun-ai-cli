/** 从宿主身份和会话归属恢复根会话，不用工作目录代替会话。@author xiuyu.yi */
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HostContext = { host: 'codebuddy' | 'codex'; conversationId: string };
const validId = (value: string | undefined): value is string =>
  !!value && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

/** 只解析首条消息的身份，不使用对话正文，也不在所有项目里搜索最近记录。 */
async function transcriptSession(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const value = buffer.toString('utf8', 0, bytesRead);
    const end = value.indexOf('\n');
    if (end < 0 && bytesRead === buffer.length) return undefined;
    const record = JSON.parse(end < 0 ? value : value.slice(0, end));
    return validId(record.sessionId) ? record.sessionId : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && validId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function detectHostContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostContext | undefined> {
  if (env.CODEBUDDY_SESSION_ID) {
    const id = env.CODEBUDDY_SESSION_ID;
    const project = env.CODEBUDDY_PROJECT_DIR;
    if (!validId(id) || !project) return undefined;
    // 与宿主 PathUtils 一致；路径仅用于定位元数据，必须再匹配实际会话 ID。
    const canonical = await realpath(project).catch(() => project);
    const compressed = canonical
      .replace(/[/\\:]/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    const roots = env.CODEBUDDY_CONFIG_DIR
      ? [env.CODEBUDDY_CONFIG_DIR]
      : [join(homedir(), '.workbuddy'), join(homedir(), '.codebuddy')];
    const matches = new Set<string>();
    for (const root of roots) {
      const directory = join(root, 'projects', compressed);
      if ((await transcriptSession(join(directory, `${id}.jsonl`))) === id) matches.add(id);
      // WorkBuddy 为子专家注入子会话 ID，子专家记录位于主会话的 subagents 目录。
      for (const parent of await directories(directory)) {
        const children = join(directory, parent, 'subagents');
        let files: string[];
        try {
          files = await readdir(children);
        } catch {
          continue;
        }
        for (const file of files.filter((name) => /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(name))) {
          if ((await transcriptSession(join(children, file))) !== id) continue;
          if ((await transcriptSession(join(directory, `${parent}.jsonl`))) === parent) matches.add(parent);
        }
      }
    }
    if (matches.size === 1) return { host: 'codebuddy', conversationId: [...matches][0]! };
    return undefined;
  }
  if (validId(env.CODEX_THREAD_ID)) return { host: 'codex', conversationId: env.CODEX_THREAD_ID };
  return undefined;
}

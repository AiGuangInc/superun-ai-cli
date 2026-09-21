/** 后台保存辅助项目绑定，不占用业务命令的生命周期。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type RememberRequest = {
  sessionId: string;
  requestedAt: string;
  endpoint: string;
  locale: string;
  credentialScope: string;
  creationRevision?: string;
};

export function scheduleRemember(request: RememberRequest): void {
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./remember-worker.js', import.meta.url)), JSON.stringify(request)],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.once('error', () => undefined);
    child.unref();
  } catch {
    // 宿主不允许后台进程时放弃辅助保存，不改变业务结果，也不绕过权限。
  }
}

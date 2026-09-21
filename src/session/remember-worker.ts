/** 单次后台绑定保存；只查询身份与写本地状态，不执行创作或登录。@author xiuyu.yi */
import { z } from 'zod';
import { PatStore } from '../auth/pat-store.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { ApiClient } from '../transport/api-client.js';
import { detectHostContext } from './host-context.js';
import { SessionBinding } from './binding.js';
import { ConversationApi } from '../api/conversation-api.js';

try {
  const request = z
    .object({
      sessionId: z.string().trim().min(1).max(500),
      requestedAt: z.string().datetime(),
      endpoint: z.string(),
      locale: z.string(),
      credentialScope: z.string().regex(/^[a-f0-9]{64}$/),
      creationRevision: z.string().uuid().optional(),
    })
    .strict()
    .parse(JSON.parse(process.argv[2] ?? ''));
  const host = await detectHostContext();
  if (host) {
    const credential = await new PatStore().readIfPresent();
    if (credential) {
      const config = { ...runtimeConfig(request), timeoutMs: 5_000 };
      const client = new ApiClient(config, credential.pat, undefined, AbortSignal.timeout(5_000));
      // 凭据可能在主命令结束后变更；不能把旧操作写入另一个账号的绑定。
      if (client.interactionScope === request.credentialScope) {
        const binding = await SessionBinding.connect({ client }, host);
        const project = await new ConversationApi(client).recently(request.sessionId);
        if (project.session.sessionId === request.sessionId) {
          const current =
            !request.creationRevision || (await binding.matchesCreation(request.creationRevision));
          if (current) {
            await binding.remember(request.sessionId, request.requestedAt);
            if (request.creationRevision) await binding.finishCreation(request.creationRevision, 'RESOLVED');
          }
        }
      }
    }
  }
} catch {
  // 保存失败静默结束，不重新派发、不输出提示、不提交任何业务请求。
}

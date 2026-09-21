/** 辅助项目映射与无项目 ID 时的创建保护彼此独立。@author xiuyu.yi */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { stateDirectory } from '../config/state-directory.js';
import type { CreationRuntime } from '../runtime.js';
import { InteractionDraftStore, fingerprint } from '../interactions/draft-store.js';
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';
import type { HostContext } from './host-context.js';
import { ProjectBindings } from './project-bindings.js';

const creationSchema = z
  .object({
    revision: z.string().uuid(),
    requestedAt: z.string().datetime(),
    state: z.enum(['CREATING', 'CREATE_UNKNOWN', 'CREATE_FAILED', 'RESOLVED']),
  })
  .strict();
type CreationRecord = z.infer<typeof creationSchema>;

export class SessionBinding {
  private readonly creationStore: InteractionDraftStore;
  private readonly bindings: ProjectBindings;
  private readonly key: string;
  constructor(
    readonly host: HostContext,
    endpoint: string,
    userCode: string,
    root = stateDirectory(),
  ) {
    const scope = fingerprint([endpoint, userCode]);
    this.bindings = new ProjectBindings(join(root, 'sessions.json'), scope);
    this.creationStore = new InteractionDraftStore(scope, join(root, 'creation'));
    this.key = `${host.host}:${host.conversationId}`;
  }
  static async connect(service: Pick<CreationRuntime, 'client'>, host: HostContext): Promise<SessionBinding> {
    const account = object(
      await service.client.call('/api/uxa-center/support/UserAccount/queryAccount', { product: 13 }),
    );
    const userCode = text(account.userCode);
    if (!userCode) throw new CliError('PROTOCOL_ERROR', '无法确认当前登录身份，未读取或修改项目绑定');
    return new SessionBinding(host, service.client.config.endpoint, userCode);
  }
  private async creation(): Promise<CreationRecord | undefined> {
    const raw = await this.creationStore.read(this.key);
    if (raw === undefined) return;
    const record = creationSchema.safeParse(raw);
    if (!record.success)
      throw new CliError('LOCAL_STATE_RECOVERY_REQUIRED', '创建保护记录无法读取，请先确认原创建结果');
    return record.data;
  }
  async current() {
    const creation = await this.creation();
    if (creation?.state === 'CREATING' || creation?.state === 'CREATE_UNKNOWN')
      return { host: this.host, ...creation };
    const sessionId = await this.bindings.read(this.key);
    return {
      host: this.host,
      state: sessionId ? ('BOUND' as const) : ('UNBOUND' as const),
      ...(sessionId ? { sessionId } : {}),
    };
  }
  async select(service: CreationRuntime, sessionId: string): Promise<void> {
    const creation = await this.creation();
    const result = await service.conversation.recently(sessionId);
    if (result.session.sessionId !== sessionId)
      throw new CliError('PROTOCOL_ERROR', '项目校验返回了不同的 sessionId');
    await this.bindings.write(this.key, sessionId);
    if (creation && ['CREATING', 'CREATE_UNKNOWN'].includes(creation.state)) {
      if (!(await this.finishCreation(creation.revision, 'RESOLVED')))
        throw new CliError('STALE_INTERACTION', '创建状态已变化，请先查询原创建结果');
    }
  }
  async clear(): Promise<void> {
    const creation = await this.creation();
    if (creation?.state === 'CREATING' || creation?.state === 'CREATE_UNKNOWN')
      throw new CliError(
        'OUTCOME_UNKNOWN',
        '创建结果尚未确认，请先核对原请求；确认项目 ID 后可用 session use 恢复',
      );
    await this.bindings.write(this.key);
  }
  async remember(sessionId: string, requestedAt: string): Promise<void> {
    const creation = await this.creation();
    if (creation && creation.requestedAt > requestedAt) return;
    await this.bindings.write(this.key, sessionId);
  }
  async beginCreation(requestedAt = new Date().toISOString()): Promise<string> {
    return this.creationStore.locked(this.key, async () => {
      const current = await this.creation();
      if (current?.state === 'CREATING' || current?.state === 'CREATE_UNKNOWN')
        throw new CliError('OUTCOME_UNKNOWN', '上次创建尚未确认结果，请先查询原请求；不要重复创建');
      const revision = randomUUID();
      await this.creationStore.write(this.key, { revision, requestedAt, state: 'CREATING' });
      return revision;
    });
  }
  async matchesCreation(revision: string): Promise<boolean> {
    return (await this.creation())?.revision === revision;
  }
  async finishCreation(
    revision: string,
    state: 'CREATE_FAILED' | 'CREATE_UNKNOWN' | 'RESOLVED',
  ): Promise<boolean> {
    return this.creationStore.locked(this.key, async () => {
      const current = await this.creation();
      if (current?.revision !== revision) return false;
      await this.creationStore.write(this.key, { ...current, revision: randomUUID(), state });
      return true;
    });
  }
}

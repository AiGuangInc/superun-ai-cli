/** 当前宿主会话唯一的项目绑定；创建回执按修订号提交。@author xiuyu.yi */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { InteractionDraftStore, fingerprint } from '../interactions/draft-store.js';
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';
import type { HostContext } from './host-context.js';

const recordSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().uuid(),
    updatedAt: z.string().datetime(),
    state: z.enum(['UNBOUND', 'BOUND', 'CREATING', 'CREATE_FAILED', 'CREATE_UNKNOWN']),
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((record) => (record.state === 'BOUND') === !!record.sessionId);
type BindingRecord = z.infer<typeof recordSchema>;
type BindingValue = Pick<BindingRecord, 'state' | 'sessionId'>;

export class SessionBinding {
  private readonly store: InteractionDraftStore;
  private readonly key: string;
  constructor(
    readonly host: HostContext,
    endpoint: string,
    userCode: string,
    root = join(homedir(), '.config/superun-ai-cli/sessions'),
  ) {
    this.store = new InteractionDraftStore(fingerprint([endpoint, userCode]), root);
    this.key = `${host.host}:${host.conversationId}`;
  }

  static async connect(service: CreationRuntime, host: HostContext): Promise<SessionBinding> {
    // 使用登录用户的稳定身份；不保存 PAT，同账号更换 PAT 后仍可恢复。
    const account = object(
      await service.client.call('/api/uxa-center/support/UserAccount/queryAccount', { product: 13 }),
    );
    const userCode = text(account.userCode);
    if (!userCode) throw new CliError('PROTOCOL_ERROR', '无法确认当前登录身份，未读取或修改项目绑定');
    return new SessionBinding(host, service.client.config.endpoint, userCode);
  }

  private async storage<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CliError && ['OUTCOME_UNKNOWN', 'STALE_INTERACTION'].includes(error.code))
        throw error;
      throw new CliError(
        error instanceof CliError ? error.code : 'PROTOCOL_ERROR',
        '当前会话的项目绑定无法读写或正被更新，请稍后查询；不要重复提交创作请求',
      );
    }
  }

  async read(): Promise<BindingRecord | undefined> {
    return this.storage(async () => {
      const raw = await this.store.read(this.key);
      if (raw === undefined) return undefined;
      return recordSchema.parse(raw);
    });
  }

  async current() {
    return { host: this.host, ...((await this.read()) ?? { state: 'UNBOUND' as const }) };
  }

  private async save(value: BindingValue): Promise<BindingRecord> {
    const record = recordSchema.parse({
      version: 1,
      revision: randomUUID(),
      updatedAt: new Date().toISOString(),
      ...value,
    });
    await this.store.write(this.key, record);
    return record;
  }

  async select(service: CreationRuntime, sessionId: string) {
    const revision = (await this.read())?.revision;
    const result = await service.conversation.recently(sessionId);
    if (result.session.sessionId !== sessionId)
      throw new CliError('PROTOCOL_ERROR', '项目校验返回了不同的 sessionId，未切换绑定');
    return this.storage(() =>
      this.store.locked(this.key, async () => {
        if ((await this.read())?.revision !== revision)
          throw new CliError('STALE_INTERACTION', '校验项目期间当前绑定已变化，请重新读取绑定后再操作');
        return this.save({ state: 'BOUND', sessionId });
      }),
    );
  }

  async clear() {
    return this.storage(() => this.store.locked(this.key, () => this.save({ state: 'UNBOUND' })));
  }

  async beginCreation(): Promise<string> {
    return this.storage(() =>
      this.store.locked(this.key, async () => {
        const current = await this.read();
        if (current?.state === 'CREATING' || current?.state === 'CREATE_UNKNOWN')
          throw new CliError('OUTCOME_UNKNOWN', '上次创建尚未确认结果，请先查询原请求；不要重复创建');
        return (await this.save({ state: 'CREATING' })).revision;
      }),
    );
  }

  async finishCreation(revision: string, value: BindingValue): Promise<void> {
    await this.storage(() =>
      this.store.locked(this.key, async () => {
        // clear、显式切换以及更新的创建均使旧回执失效。
        if ((await this.read())?.revision === revision) await this.save(value);
      }),
    );
  }
}

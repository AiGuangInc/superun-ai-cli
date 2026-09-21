/** 当前宿主会话唯一的项目绑定；创建回执按修订号提交。@author xiuyu.yi */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stateDirectory } from '../config/state-directory.js';
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
  private readonly creationStore: InteractionDraftStore;
  private readonly key: string;
  constructor(
    readonly host: HostContext,
    endpoint: string,
    userCode: string,
    root = stateDirectory('sessions'),
  ) {
    const scope = fingerprint([endpoint, userCode]);
    this.store = new InteractionDraftStore(scope, root);
    this.creationStore = new InteractionDraftStore(scope, join(root, 'creation'));
    this.key = `${host.host}:${host.conversationId}`;
  }

  static async connect(service: Pick<CreationRuntime, 'client'>, host: HostContext): Promise<SessionBinding> {
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
      if (error instanceof CliError) throw error;
      throw new CliError(
        'PROTOCOL_ERROR',
        '当前会话的项目绑定格式无效，请保留状态文件排查；不要重复提交创作请求',
      );
    }
  }

  private async readRecord(store: InteractionDraftStore): Promise<BindingRecord | undefined> {
    return this.storage(async () => {
      const raw = await store.read(this.key);
      if (raw === undefined) return undefined;
      return recordSchema.parse(raw);
    });
  }

  async read(): Promise<BindingRecord | undefined> {
    const creation = await this.readRecord(this.creationStore);
    if (creation?.state === 'CREATING' || creation?.state === 'CREATE_UNKNOWN') return creation;
    const binding = await this.readRecord(this.store);
    // 创建后的辅助保存尚未完成时，也不能重新暴露之前项目的旧绑定。
    if (creation && (!binding || creation.updatedAt > binding.updatedAt)) return creation;
    return binding;
  }

  async current() {
    return { host: this.host, ...((await this.read()) ?? { state: 'UNBOUND' as const }) };
  }

  private async save(
    value: BindingValue,
    updatedAt = new Date().toISOString(),
    store = this.store,
  ): Promise<BindingRecord> {
    const record = recordSchema.parse({
      version: 1,
      revision: randomUUID(),
      updatedAt,
      ...value,
    });
    await store.write(this.key, record);
    return record;
  }

  async select(service: CreationRuntime, sessionId: string) {
    const revision = (await this.readRecord(this.store))?.revision;
    const creation = await this.readRecord(this.creationStore);
    const result = await service.conversation.recently(sessionId);
    if (result.session.sessionId !== sessionId)
      throw new CliError('PROTOCOL_ERROR', '项目校验返回了不同的 sessionId，未切换绑定');
    const selected = await this.storage(() =>
      this.store.locked(this.key, async () => {
        if ((await this.readRecord(this.store))?.revision !== revision)
          throw new CliError('STALE_INTERACTION', '校验项目期间当前绑定已变化，请重新读取绑定后再操作');
        if ((await this.readRecord(this.creationStore))?.revision !== creation?.revision)
          throw new CliError('STALE_INTERACTION', '校验项目期间创建状态已变化，请先查询原创建结果');
        return this.save({ state: 'BOUND', sessionId });
      }),
    );
    if (creation && ['CREATING', 'CREATE_UNKNOWN'].includes(creation.state)) {
      if (!(await this.finishCreation(creation.revision, 'UNBOUND')))
        throw new CliError('STALE_INTERACTION', '恢复绑定期间创建状态已变化，请先查询原创建结果');
    }
    return selected;
  }

  async clear() {
    return this.storage(() =>
      this.store.locked(this.key, async () => {
        const current = await this.read();
        if (current?.state === 'CREATING' || current?.state === 'CREATE_UNKNOWN')
          throw new CliError(
            'OUTCOME_UNKNOWN',
            '创建结果尚未确认，请先查询原请求；确认项目 ID 后可用 session use 恢复绑定',
          );
        return this.save({ state: 'UNBOUND' });
      }),
    );
  }

  async remember(sessionId: string, requestedAt: string): Promise<void> {
    await this.storage(() =>
      this.store.locked(this.key, async () => {
        const current = await this.readRecord(this.store);
        const creation = await this.readRecord(this.creationStore);
        if (creation && creation.updatedAt > requestedAt) return;
        // 后台任务可能乱序完成；旧操作不能覆盖较新的选择、清除或创建状态。
        if (
          current &&
          (current.updatedAt >= requestedAt ||
            current.state === 'CREATING' ||
            current.state === 'CREATE_UNKNOWN')
        )
          return;
        await this.save({ state: 'BOUND', sessionId }, requestedAt);
      }),
    );
  }

  async beginCreation(requestedAt = new Date().toISOString()): Promise<string> {
    return this.storage(() =>
      this.creationStore.locked(this.key, async () => {
        const current = await this.readRecord(this.creationStore);
        // 升级前的未决创建可能仍在旧绑定文件中，不能忽略后重新创建。
        const legacy = await this.readRecord(this.store);
        if (
          [current, legacy].some(
            (record) => record?.state === 'CREATING' || record?.state === 'CREATE_UNKNOWN',
          )
        )
          throw new CliError('OUTCOME_UNKNOWN', '上次创建尚未确认结果，请先查询原请求；不要重复创建');
        return (await this.save({ state: 'CREATING' }, requestedAt, this.creationStore)).revision;
      }),
    );
  }

  async finishCreation(
    revision: string,
    state: 'CREATE_FAILED' | 'CREATE_UNKNOWN' | 'UNBOUND',
  ): Promise<boolean> {
    return this.storage(() =>
      this.creationStore.locked(this.key, async () => {
        const current = await this.readRecord(this.creationStore);
        if (current?.revision !== revision) return false;
        // 保护记录只保存创建状态，不保存项目 ID；时间保留原请求顺序。
        await this.save({ state }, current.updatedAt, this.creationStore);
        return true;
      }),
    );
  }
}

/** App 专属流程：只由新 App 命令调用。@author xiuyu.yi */
import { join } from 'node:path';
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { CliError } from '../output/exit-codes.js';
import { InteractionDraftStore, fingerprint } from '../interactions/draft-store.js';
import { stateDirectory } from '../config/state-directory.js';
import { object, text, list, type JsonObject } from '../contracts/value.js';
import { parseWire } from '../contracts/node-wire.js';
import { projectCheckPreflight, projectMainlineHead } from '../conversation/project-check-preflight.js';
import { hasCompletedCreationResult } from '../conversation/next-actions.js';
import { currentRound, roundMessage, roundContainingMessage } from '../conversation/round-selector.js';
import { applySnapshot } from '../conversation/session-waiter.js';
import { projectText } from '../conversation/text-projector.js';
import { AppApi } from './api.js';
import { appGuidance } from './guidance.js';
import { appIdFields, contextSchema, planFeatureSchema, platformNames } from './contracts.js';
import type { AppContext, AppPlatform, AppResult, AppQuestion, AppPlanFeature } from './contracts.js';
import type { NextAction } from '../contracts/cli-output.js';
import type { CreationResult } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';

export class AppService {
  readonly api: AppApi;
  private readonly store: InteractionDraftStore;
  private readonly key: string;
  constructor(
    readonly runtime: CreationRuntime,
    readonly sessionId: string,
    readonly platform: AppPlatform,
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new CliError('INVALID_ARGUMENT', '请明确本次单个项目 ID');
    this.api = new AppApi(runtime.client);
    this.store = new InteractionDraftStore(runtime.client.interactionScope, join(stateDirectory(), 'app'));
    this.key = `${sessionId}:${platform}`;
  }
  async context(): Promise<AppContext> {
    const raw = await this.store.read(this.key);
    return raw === undefined ? {} : parseWire(contextSchema, raw);
  }
  private async save(value: AppContext) {
    await this.store.write(this.key, value);
  }
  private async updateContext(expected: AppContext, patch: Partial<AppContext>) {
    return this.store.locked(this.key, async () => {
      const current = await this.context();
      const fields: Array<keyof AppContext> = [
        'developmentMessageId',
        'consultId',
        'consultMessageId',
        'consultRequestPending',
        'executionMessageId',
        'executionPending',
        ...(Object.keys(patch) as Array<keyof AppContext>),
      ];
      for (const field of fields) {
        if (
          current[field] !== expected[field] &&
          !(Object.hasOwn(patch, field) && current[field] === patch[field])
        )
          throw new CliError('STALE_INTERACTION', 'App 任务状态已变化，请重新查询当前任务，不覆盖新状态');
      }
      // 网络查询不持锁；提交时仅合并本步字段，保留并发写入的构建及未知提交保护。
      await this.save({ ...current, ...patch });
    });
  }
  private command(...args: string[]) {
    return [
      'superun-ai',
      '--endpoint',
      this.runtime.client.config.endpoint,
      '--locale',
      this.runtime.client.config.locale,
      'app',
      ...args,
      '--platform',
      this.platform,
    ];
  }
  private action(action: string, instruction: string, args: string[], requiresUserInput = true): NextAction {
    return { action, instruction, requiresUserInput, command: this.command(...args) };
  }
  private result(
    stage: string,
    state: AppResult['state'],
    values: Record<string, unknown> = {},
    nextActions: NextAction[] = [],
  ): AppResult {
    return { state, sessionId: this.sessionId, platform: this.platform, stage, ...values, nextActions };
  }
  private question(
    result: AppResult,
    header: string,
    question: string,
    options: AppQuestion['options'],
  ): AppResult {
    return { ...result, question: { header, question, multiSelect: false as const, options } };
  }
  private async mainView() {
    const [base, pipeline] = await Promise.all([
      this.runtime.load(this.sessionId),
      this.api.mainline(this.sessionId),
    ]);
    // 咨询可能占满混合首屏；App 单独读取主线，不改变通用命令的取数和解析。
    const view = { ...base, pipeline };
    const message = roundMessage(view, currentRound(view));
    if (view.session.status === 3 && message?.roundExtra?.hasSelectedStyle === '1')
      view.features = await this.runtime.query.features(this.sessionId);
    return view;
  }
  private async mainline(label: string) {
    const view = await this.mainView();
    const gate = await projectCheckPreflight(this.runtime, view, this.sessionId, label);
    if (gate.stage !== 'development' || gate.hasStaging)
      throw new CliError('INVALID_ARGUMENT', '请先完成本轮研发并处理源码暂存，再继续 App 流程');
    return { view, gate };
  }
  private async creationFinished(result: CreationResult) {
    if (hasCompletedCreationResult(result)) return true;
    // 已有作品可能缺研发预览字段；可选功能菜单不等于仍有本轮任务在执行。
    if (
      result.state !== 'NEEDS_INPUT' ||
      !result.interactions.length ||
      result.interactions.some((item) => item.kind !== 'SELECT_FEATURES') ||
      !result.development?.started ||
      !result.development.planApproved
    )
      return false;
    const config = await this.api.config(this.sessionId);
    return typeof config.currentSnapshotId === 'number' && config.currentSnapshotId > 0;
  }
  async history(limit = 50, taskId?: string) {
    const records = await this.api.builds(this.sessionId, this.platform, limit);
    const items = taskId ? records.filter((item) => item.taskId === taskId) : records;
    if (taskId && !items.length)
      throw new CliError('INVALID_ARGUMENT', '当前查询范围内没有该包，不能判断更早的历史包是否存在', {
        taskId,
        limit,
      });
    return this.result('HISTORY', 'COMPLETED', {
      items,
      requestedLimit: limit,
      fullHistory: false,
      notice: items.length
        ? '当前为服务端返回的最近记录，并包含最近成功入口；接口没有历史分页，不表示全部历史。查询不会重新打包或上传。'
        : '本次返回的最近范围内没有本平台打包记录；未查询全部历史，不能表述为从未打包。查询不会重新打包或上传。',
    });
  }
  async filing() {
    const raw = parseWire(
      z.object({
        appName: z.string(),
        iconUrl: z.string().nullish(),
        serviceDomain: z.string().nullish(),
        platforms: z.array(z.object({ platform: z.string() }).passthrough()),
      }),
      await this.api.call('queryAppFilingInfo', { sessionId: this.sessionId }),
    );
    return this.result('FILING', 'COMPLETED', {
      filing: { ...raw, platforms: raw.platforms.filter((item) => item.platform === this.platform) },
      notice:
        '证书材料以最近成功正式包及其版本为准；只有体验包时可能未就绪。这些是填写资料，不表示已完成备案。',
    });
  }
  async config() {
    const config = await this.api.config(this.sessionId);
    return this.question(
      this.result(
        'APPLICATION_INFO',
        'NEEDS_INPUT',
        {
          config: {
            appName: config.appName,
            iconUrl: config.iconUrl,
            appId: config[appIdFields[this.platform]],
          },
          notice: '名称和图标由当前项目各平台共用，应用 ID 只对应当前平台；更改 ID 后无法覆盖安装旧包。',
        },
        [
          this.action('USE_APPLICATION_INFO', '沿用当前信息，检查本平台实际缺项。', [
            'prepare',
            this.sessionId,
          ]),
          this.action('EDIT_APPLICATION_INFO', '收取用户修改内容，通过 config set 的输入文件保存。', [
            'config',
            'set',
            this.sessionId,
            '--input',
            '<应用信息JSON文件>',
          ]),
        ],
      ),
      '应用信息',
      '打包前，如何处理当前应用信息？',
      [
        {
          label: '使用当前信息',
          description: '沿用以上应用名称、图标和应用 ID。',
          action: 'USE_APPLICATION_INFO',
        },
        { label: '修改应用信息', description: '告诉我想修改的内容。', action: 'EDIT_APPLICATION_INFO' },
      ],
    );
  }
  async prepare(buildType: 'debug' | 'release' = 'debug') {
    const [config, accounts, signing, view, publication, context] = await Promise.all([
      this.api.config(this.sessionId),
      this.api.accounts(this.sessionId),
      this.api.signing(this.sessionId),
      this.mainView(),
      this.runtime.publish.status(this.sessionId),
      this.context(),
    ]);
    const missing: Array<{ code: string; message: string }> = [];
    const versions = list(publication.publishedVersions).map(object);
    const published =
      view.session.publicStatus === 1 &&
      versions.some((item) => item.deployStatus === 1) &&
      typeof config.currentSnapshotId === 'number' &&
      config.currentSnapshotId > 0 &&
      config.publishedSnapshotId === config.currentSnapshotId;
    const adapted =
      context.adaptedMessageId && projectMainlineHead(view)?.messageId === context.adaptedMessageId;
    if (!adapted)
      missing.push({
        code: 'ADAPTATION_REQUIRED',
        message: '本次 App 适配完成状态尚未核验，请先咨询并确认执行适配规划。',
      });
    if (!published)
      missing.push({
        code: 'PUBLICATION_REQUIRED',
        message: '只有当前版本上线运营成功后，才能进行 App 打包。',
      });
    const account = accounts.find((item) => item.platform === this.platform);
    const signature = signing.find((item) => item.platform === this.platform);
    if (!config.appName.trim() || !config[appIdFields[this.platform]].trim())
      missing.push({ code: 'APPLICATION_INFO_REQUIRED', message: '请补齐应用名称和应用 ID。' });
    if (this.platform !== 'android') {
      if (!account)
        throw new CliError('PROTOCOL_ERROR', '接口未返回本平台账号状态，请重新查询，不将缺失当作未连接');
      if (!account.connected)
        missing.push({
          code: 'ACCOUNT_REQUIRED',
          message: `请先连接自己的${this.platform === 'ios' ? '苹果' : '华为'}开发者账号。`,
        });
      else {
        if (
          this.platform === 'harmony' &&
          (!account.agcAppId || account.harmonyBundleName !== config.harmonyAppId)
        )
          missing.push({ code: 'APPLICATION_LINK_REQUIRED', message: '请关联与当前包名一致的 AGC 应用。' });
        if (buildType === 'debug' && !account.testDeviceIds?.length)
          missing.push({
            code: 'TEST_DEVICE_REQUIRED',
            message: '请添加并选择本次需要安装体验包的测试手机。',
          });
      }
    } else if (buildType === 'release' && !signature?.certificateDname)
      missing.push({ code: 'SIGNING_SUBJECT_REQUIRED', message: '请填写并保存签名主体名称和两位国家代码。' });
    if (buildType === 'release') {
      const records = await this.api.builds(this.sessionId, this.platform);
      if (!records.some((item) => item.buildType === 'debug' && item.buildStatus === 1 && item.downloadUrl))
        missing.push({
          code: 'TRIAL_REQUIRED',
          message: '请先生成本平台的手机体验包，体验修复后再生成应用商店包。',
        });
    }
    const actions: NextAction[] = [];
    if (missing.some((item) => item.code === 'ADAPTATION_REQUIRED'))
      actions.push(
        this.action(
          'APP_CONSULT',
          '仅在本次明确制作或继续研发 App，且本轮研发实际结束后先告知用户，再自动开始适配咨询；只读查询不执行，已有咨询则续查原任务。',
          ['consult', 'start', this.sessionId],
          false,
        ),
      );
    else if (!published)
      actions.push({
        action: 'PUBLISH_APP_SOURCE',
        requiresUserInput: true,
        instruction:
          '明确说明只有上线运营成功后才能打包。用户选择上线并打包后，沿原发布流程处理目标版本和费用，成功后继续 App 配置，不展示其他专家菜单。',
        command: [
          'superun-ai',
          '--endpoint',
          this.runtime.client.config.endpoint,
          'chat',
          'publish',
          'status',
          '--for-launch',
          '--',
          this.sessionId,
        ],
      });
    else if (!missing.length)
      actions.push(
        this.action(
          'BUILD_APP',
          '用户已选择上线并打包且本次配置已确认时直接执行；仅查询准备状态不授权新构建。',
          [
            'build',
            this.sessionId,
            '--build-type',
            buildType,
            '--version-bump',
            buildType === 'debug' ? 'none' : 'patch',
          ],
        ),
      );
    if (missing.some((item) => item.code === 'ACCOUNT_REQUIRED'))
      actions.push(
        this.action(
          'CONNECT_ACCOUNT',
          '先展示指导和官方链接，再由项目主人提供文件路径；不读取或回显私钥正文。',
          ['account', 'connect', this.sessionId],
        ),
      );
    if (
      missing.some(
        (item) => item.code === 'APPLICATION_LINK_REQUIRED' || item.code === 'TEST_DEVICE_REQUIRED',
      )
    )
      actions.push(
        this.action('CONFIGURE_DEVICES', '读取真实应用/设备选项，按用户选择保存，不编造 ID。', [
          'devices',
          'list',
          this.sessionId,
        ]),
      );
    if (missing.some((item) => item.code === 'SIGNING_SUBJECT_REQUIRED'))
      actions.push(
        this.action('CONFIGURE_SIGNING', '请用户填写签名主体，保存后继续本次打包。', [
          'signing',
          'set',
          this.sessionId,
          '--input',
          '<签名主体JSON文件>',
        ]),
      );
    return this.result(
      'PACKAGE_PREPARATION',
      missing.length ? 'NEEDS_INPUT' : 'READY',
      {
        config,
        account,
        signing: signature,
        published,
        missing,
        guidance: appGuidance(this.platform, buildType),
        notice:
          '只展示当前专家平台的实际缺项，已完成的配置直接复用；不要把 account_required 签名模式当作账号未连接。',
      },
      actions,
    );
  }
  async startConsultation(sourceMessageId?: string, retryFailedId?: string) {
    const result = await this.store.locked(this.key, async () => {
      const { view, gate } = await this.mainline('App 适配咨询');
      const source = sourceMessageId ?? gate.sourceMessageId;
      if (source !== gate.sourceMessageId)
        throw new CliError('STALE_INTERACTION', '研发来源已变化，请读取当前真实结果再开始咨询');
      const context = await this.context();
      if (context.adaptedMessageId === source) return undefined;
      if (retryFailedId) {
        if (context.consultId !== retryFailedId || context.developmentMessageId !== source)
          throw new CliError('STALE_INTERACTION', '重试目标与本次研发来源不一致');
        const failed = await this.consultation(retryFailedId);
        if (!['FAILED', 'INTERRUPTED'].includes(failed.state) || object(failed.thread).closed)
          throw new CliError('INVALID_ARGUMENT', '只有明确失败或中断且尚未交接的本次咨询才可主动重试');
      } else if (context.developmentMessageId === source && context.consultId)
        return this.consultation(context.consultId);
      if (context.consultRequestPending)
        throw new CliError('OUTCOME_UNKNOWN', '原咨询提交结果尚未确认，请查询咨询状态，勿重复提交', {
          sessionId: this.sessionId,
        });
      const main = await this.runtime.inspect(view);
      if (!(await this.creationFinished(main)))
        throw new CliError('INVALID_ARGUMENT', '本轮研发尚未完成，请继续原研发任务');
      const prepared = await this.api.prepareConsultation(this.sessionId);
      if (prepared.previewVersionId !== 0 || !prepared.preReplyMessageId)
        throw new CliError('PROTOCOL_ERROR', '未取得本次研发主线的稳定咨询锚点');
      const pending: AppContext = { developmentMessageId: source, consultRequestPending: true };
      await this.save(pending);
      let receipt: JsonObject;
      try {
        receipt = await this.api.consult({
          sessionId: this.sessionId,
          mode: 11,
          framework: 6,
          background: true,
          previewVersionId: 0,
          newThread: true,
          preReplyMessageId: prepared.preReplyMessageId,
          content: `目标平台：${platformNames[this.platform]}。检查这个项目做成手机 App 后，原来的功能能否正常使用，并指出需要调整的地方，整理实际可执行的适配规划。`,
          roundExtra: {
            humanizeVer: '1',
            versionPreview: '0',
            appAdaptationConsult: '1',
            appTargetPlatform: this.platform,
            appDevelopmentSource: source,
          },
          excludedInheritedRoundExtraKeys: ['startDevelopment', 'stage0Intro', 'stage0SkillUnavailable'],
        });
      } catch (error) {
        if (
          error instanceof CliError &&
          ['BUSINESS_ERROR', 'INVALID_ARGUMENT', 'AUTH_REQUIRED'].includes(error.code)
        )
          await this.save({ developmentMessageId: source });
        throw error;
      }
      const consultId = receipt.consultId == null ? undefined : String(receipt.consultId);
      const messageId = text(receipt.messageId);
      if (!consultId || !messageId)
        throw new CliError('OUTCOME_UNKNOWN', '咨询已提交但缺少线程回执，请查询原咨询，勿重复提交');
      await this.save({ developmentMessageId: source, consultId, consultMessageId: messageId });
      return this.result(
        'CONSULTATION',
        'ACCEPTED',
        {
          consultId,
          messageId,
          notice: '本轮功能研发已完成，正在进行 App 适配咨询并整理规划；规划返回后先展示，再请用户确认执行。',
        },
        [
          this.action(
            'WAIT_APP_CONSULT',
            '等待本次咨询，不重新创建咨询。',
            ['consult', 'status', this.sessionId, consultId],
            false,
          ),
        ],
      );
    });
    return result ?? this.executionStatus();
  }
  async consultation(id?: string): Promise<AppResult> {
    const context = await this.context();
    const consultId = id ?? context.consultId;
    if (!consultId) throw new CliError('INVALID_ARGUMENT', '尚无本次 App 咨询标识；未知提交结果不能直接重建');
    const thread = (await this.api.threads(this.sessionId, consultId)).find(
      (item) => item.consultId === consultId,
    );
    if (!thread || thread.previewVersionId !== 0)
      throw new CliError('INVALID_ARGUMENT', '当前项目研发主线没有该咨询线程');
    const snapshot = await this.runtime.conversation.snapshot(this.sessionId, thread.lastMessageId);
    const pipeline = snapshot.pipeline;
    if (!pipeline) throw new CliError('PROTOCOL_ERROR', '咨询快照没有返回本次消息');
    const base = await this.api.consultation(this.sessionId);
    // 当前快照是 roundPatch，先与咨询读侧的完整轮次合并；不改通用主链过滤规则。
    const view = applySnapshot({ ...base, extra: object(base.session.extra) }, pipeline);
    const source = view.pipeline.messages.find((item) => item.messageId === thread.lastMessageId);
    const round = roundContainingMessage(view, thread.lastMessageId);
    if (!source || !round) throw new CliError('PROTOCOL_ERROR', '无法确认本次咨询快照来源');
    if (
      String(source.roundExtra?.appAdaptationConsult) !== '1' ||
      source.roundExtra?.appTargetPlatform !== this.platform
    )
      throw new CliError(
        'INVALID_ARGUMENT',
        '该咨询不属于当前平台的 App 专家流程，不将其他咨询规划用于 App 适配',
      );
    const messages = projectText([round]).messages;
    const state =
      thread.running || round.status === 'running'
        ? 'RUNNING'
        : round.status === 'failed'
          ? 'FAILED'
          : round.status === 'interrupted'
            ? 'INTERRUPTED'
            : 'COMPLETED';
    const result = this.result('CONSULTATION', state, {
      consultId,
      messageId: source.messageId,
      messages,
      thread,
      notice: '按顺序展示本次真实咨询内容；只有规划确认后才执行适配。继续咨询沿用同一个线程。',
      executionActivity: await this.runtime.executionActivity.read(view, { rounds: [round], consultId }),
    });
    if (['FAILED', 'INTERRUPTED'].includes(state) && !thread.closed)
      return this.question(
        {
          ...result,
          notice: '本次 App 咨询未完成。请先查看以上实际原因，处理后可主动重试咨询。',
          nextActions: [
            this.action(
              'RETRY_APP_CONSULT',
              '用户处理原因并明确重试后，创建本次失败咨询的新一轮，不重新开发项目。',
              ['consult', 'start', this.sessionId, '--retry-failed', consultId],
            ),
          ],
        },
        '咨询未完成',
        '处理以上原因后，接下来怎么做？',
        [
          { label: '重试咨询', description: '原因处理后重新进行本次适配咨询。', action: 'RETRY_APP_CONSULT' },
          {
            label: '稍后处理',
            description: '保留当前项目和记录，暂不提交新任务。',
            action: 'DEFER_APP_ACTION',
          },
        ],
      );
    if (state !== 'COMPLETED' || thread.closed) return result;
    return {
      ...result,
      nextActions: [
        this.action(
          'READ_APP_PLAN',
          '读取当前咨询实际规划并完整展示。',
          ['plan', 'get', this.sessionId, consultId],
          false,
        ),
      ],
    };
  }
  async continueConsultation(consultId: string, content: string) {
    return this.store.locked(this.key, async () => {
      const status = await this.consultation(consultId);
      const thread = object(status.thread);
      if (thread.closed || status.state !== 'COMPLETED')
        throw new CliError('INVALID_ARGUMENT', '请先等待当前咨询完成；已经交接执行的咨询不再续问');
      if (!content.trim())
        throw new CliError('INVALID_ARGUMENT', '请先提供具体问题或修改意见，不直接发送“继续咨询”按钮文字');
      await this.api.prepareConsultation(this.sessionId);
      const context = await this.context();
      // 续问也保留未知结果，避免网络中断后重复发送用户要求。
      if (context.consultRequestPending)
        throw new CliError('OUTCOME_UNKNOWN', '原续问结果尚未确认，请先查询并读取原咨询规划，勿重复提交');
      await this.save({ ...context, consultRequestPending: true, planFingerprint: undefined });
      try {
        const receipt = await this.api.consult({
          sessionId: this.sessionId,
          consultId,
          mode: 11,
          framework: 6,
          background: true,
          previewVersionId: 0,
          content,
          roundExtra: {
            humanizeVer: '1',
            versionPreview: '0',
            appAdaptationConsult: '1',
            appTargetPlatform: this.platform,
          },
          excludedInheritedRoundExtraKeys: ['startDevelopment', 'stage0Intro', 'stage0SkillUnavailable'],
        });
        if (!text(receipt.messageId))
          throw new CliError('OUTCOME_UNKNOWN', '咨询续问回执缺少消息标识，请查询原线程');
        await this.save({
          ...context,
          consultId,
          consultMessageId: text(receipt.messageId),
          planFingerprint: undefined,
        });
        return this.result('CONSULTATION', 'ACCEPTED', { consultId, messageId: receipt.messageId }, [
          this.action(
            'WAIT_APP_CONSULT',
            '继续查询原咨询。',
            ['consult', 'status', this.sessionId, consultId],
            false,
          ),
        ]);
      } catch (error) {
        if (
          error instanceof CliError &&
          ['BUSINESS_ERROR', 'INVALID_ARGUMENT', 'AUTH_REQUIRED'].includes(error.code)
        )
          await this.save(context);
        throw error;
      }
    });
  }
  async plan(consultId: string, saveShown = true) {
    const context = await this.context();
    const status = await this.consultation(consultId);
    if (status.state !== 'COMPLETED' || object(status.thread).closed) return status;
    if (context.consultRequestPending && status.messageId === context.consultMessageId)
      throw new CliError('OUTCOME_UNKNOWN', '原续问结果尚未确认，请继续查询原咨询，不沿用旧规划');
    const thread = object(status.thread);
    const anchor = text(thread.lastReplyMessageId);
    if (!anchor) throw new CliError('PROTOCOL_ERROR', '规划缺少咨询来源锚点');
    let raw: unknown;
    try {
      raw = JSON.parse(await this.api.planAttachment(this.sessionId, anchor));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('PROTOCOL_ERROR', '本次规划附件不是有效 JSON');
    }
    if (!Array.isArray(raw)) throw new CliError('PROTOCOL_ERROR', '本次规划附件不是清单');
    const pending = raw.filter((item) => {
      const value = object(item);
      return (
        value.origin === 'consult_plan' &&
        value.status === 'pending' &&
        value.checked === false &&
        value.type !== 'separator'
      );
    });
    if (!pending.length)
      return this.result(
        'PLAN_REVIEW',
        'NEEDS_INPUT',
        {
          ...status,
          stage: 'PLAN_REVIEW',
          state: 'NEEDS_INPUT',
          notice:
            '本次咨询没有返回可执行的待确认规划，不能编造执行计划。请继续咨询，明确需要处理的适配内容。',
        },
        [
          this.action('CONTINUE_APP_CONSULT', '先收取具体问题，再沿原咨询发送。', [
            'consult',
            'send',
            this.sessionId,
            consultId,
            '--input',
            '<问题JSON文件>',
          ]),
        ],
      );
    const features = parseWire(z.array(planFeatureSchema), pending);
    const planBatchId = features.at(-1)!.planBatchId;
    const selected = features.filter((item) => item.planBatchId === planBatchId);
    if (new Set(selected.map((item) => item.id)).size !== selected.length)
      throw new CliError('PROTOCOL_ERROR', '当前规划功能 ID 重复');
    const hash = fingerprint({ consultId, messageId: status.messageId, planBatchId, features: selected });
    if (saveShown) {
      if (context.consultId && context.consultId !== consultId)
        throw new CliError('STALE_INTERACTION', '当前 App 任务已关联另一条咨询');
      await this.updateContext(context, {
        consultId,
        consultMessageId: String(status.messageId),
        consultRequestPending: false,
        planFingerprint: hash,
      });
    }
    return this.question(
      this.result(
        'PLAN_REVIEW',
        'NEEDS_INPUT',
        {
          consultId,
          messageId: status.messageId,
          messages: status.messages,
          planBatchId,
          planFingerprint: hash,
          features: selected,
          notice:
            '完整展示咨询内容及规划后，再用原生提问确认；用户继续咨询时先收取具体意见，规划更新后重新展示。',
        },
        [
          this.action('EXECUTE_APP_PLAN', '仅在用户明确确认以上这份规划后执行，确认前不开始修复。', [
            'plan',
            'execute',
            this.sessionId,
            consultId,
            '--plan-fingerprint',
            hash,
          ]),
          this.action('CONTINUE_APP_CONSULT', '收取具体补充或修改意见，沿同一咨询继续讨论。', [
            'consult',
            'send',
            this.sessionId,
            consultId,
            '--input',
            '<问题JSON文件>',
          ]),
        ],
      ),
      '适配规划',
      '请查看以上 App 适配规划，接下来怎么处理？',
      [
        { label: '确认执行', description: '按当前展示的规划开始适配修复。', action: 'EXECUTE_APP_PLAN' },
        {
          label: '继续咨询',
          description: '补充问题或修改要求，先继续讨论方案。',
          action: 'CONTINUE_APP_CONSULT',
        },
      ],
    );
  }
  async executePlan(consultId: string, shownFingerprint: string, chosen?: number[]) {
    const result = await this.store.locked(this.key, async () => {
      const context = await this.context();
      if (context.executionPending)
        throw new CliError('OUTCOME_UNKNOWN', '原计划交接结果尚未确认，请查询原咨询及执行回执，不重复提交');
      if (context.executionMessageId) return undefined;
      if (context.consultId !== consultId || context.planFingerprint !== shownFingerprint)
        throw new CliError('STALE_INTERACTION', '请先读取并展示当前规划，取得本次确认后再执行');
      const plan = await this.plan(consultId, false);
      if (plan.planFingerprint !== shownFingerprint)
        throw new CliError('STALE_INTERACTION', '规划已更新，请展示新规划并重新确认');
      const features = plan.features as AppPlanFeature[];
      const ids = chosen ?? features.map((item) => item.id);
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !features.some((item) => item.id === id))
      )
        throw new CliError('INVALID_ARGUMENT', '执行条目必须来自当前实际规划，且不能为空或重复');
      if (ids.length !== features.length)
        throw new CliError(
          'INVALID_ARGUMENT',
          '本专家按已确认的整份适配规划执行；如需改变范围，请先继续咨询并确认新规划',
        );
      await this.mainline('执行 App 适配');
      await this.save({ ...context, executionPending: true });
      try {
        const receipt = await this.runtime.command.chat({
          sessionId: this.sessionId,
          content: '立即执行',
          businessParams: {
            business_type: 'plan_execution',
            consultId,
            plan_batch_id: plan.planBatchId,
            selected_feature_ids: ids,
          },
        });
        const messageId = text(receipt.messageId);
        if (!messageId || (receipt.sessionId && receipt.sessionId !== this.sessionId))
          throw new CliError('OUTCOME_UNKNOWN', '计划已提交但无法确认执行消息，请查询原咨询交接结果');
        await this.save({ ...context, executionMessageId: messageId });
        return this.result('ADAPTATION', 'ACCEPTED', { messageId, consultId, selectedFeatureIds: ids }, [
          this.action(
            'WAIT_APP_ADAPTATION',
            '等待本次适配执行，不再次咨询或重复确认。',
            ['plan', 'wait', this.sessionId],
            false,
          ),
        ]);
      } catch (error) {
        if (
          error instanceof CliError &&
          ['BUSINESS_ERROR', 'INVALID_ARGUMENT', 'AUTH_REQUIRED'].includes(error.code)
        )
          await this.save(context);
        throw error;
      }
    });
    return result ?? this.executionStatus();
  }
  private async executionBelongsToMainline(view: SessionView, executionMessageId: string) {
    let pipeline = view.pipeline;
    const cursors = new Set<string>();
    // 只沿物理主线回读本次执行；自动报告可跨页，新的用户研发要求不能算作旧适配成果。
    for (let page = 0; page < 20; page++) {
      const lane = object(object(pipeline.lanes).chain);
      for (const row of list(lane.messages).map(object).reverse()) {
        if (row.sessionId !== this.sessionId || typeof row.messageId !== 'string') return false;
        if (row.messageId === executionMessageId) return true;
        if (row.role === 2) continue;
        if (
          row.role !== 1 ||
          !['sub_agent_report', 'background_task_report'].includes(
            String(object(row.roundExtra).business_type),
          ) ||
          object(object(row.extra).extra).FROM_QUEUE !== 'true'
        )
          return false;
      }
      const cursor = text(lane.oldestMessageId);
      if (!lane.hasMore || !cursor || cursors.has(cursor)) return false;
      cursors.add(cursor);
      pipeline = await this.api.mainline(this.sessionId, cursor);
    }
    return false;
  }
  async executionStatus(wait = false, timeout = 60): Promise<AppResult> {
    const context = await this.context();
    if (!context.executionMessageId) {
      if (context.executionPending && context.consultId) {
        const thread = (await this.api.threads(this.sessionId, context.consultId)).find(
          (item) => item.consultId === context.consultId,
        );
        if (thread?.handedOffMessageId) {
          await this.updateContext(context, {
            executionPending: false,
            executionMessageId: thread.handedOffMessageId,
          });
          return this.executionStatus(wait, timeout);
        }
      }
      throw new CliError('INVALID_ARGUMENT', '尚未取得已确认规划的执行回执，请先查询原计划交接结果');
    }
    let view = await this.mainView();
    let result = await this.runtime.inspect(view);
    if (wait && ['RUNNING', 'QUEUED', 'ACCEPTED'].includes(result.state)) {
      await this.runtime.wait(this.sessionId, { messageId: context.executionMessageId, timeout });
      view = await this.mainView();
      result = await this.runtime.inspect(view);
    }
    const round = currentRound(view),
      message = roundMessage(view, round);
    if (['FAILED', 'INTERRUPTED'].includes(result.state))
      return this.result('ADAPTATION', result.state, {
        result: { ...result, nextActions: [] },
        notice:
          '本次适配未完成，请先展示实际失败原因并处理。没有真实重试动作时不编造命令，不重复交接原规划，也不继续自动等待或打包。',
      });
    if (!(await this.creationFinished(result)))
      return this.result('ADAPTATION', result.state, { result: { ...result, nextActions: [] } }, [
        this.action(
          'WAIT_APP_ADAPTATION',
          '展示真实进度和必答问题，继续本次适配执行。',
          ['plan', 'wait', this.sessionId],
          false,
        ),
      ]);
    if (!message || !round) throw new CliError('PROTOCOL_ERROR', '未取得适配完成的真实主线来源');
    await this.mainline('核验 App 适配结果');
    const known = await this.executionBelongsToMainline(view, context.executionMessageId);
    if (!known)
      throw new CliError('STALE_INTERACTION', '当前结果不能关联本次适配执行，不把其他任务当作适配完成');
    await this.updateContext(context, { adaptedMessageId: message.messageId });
    return this.question(
      this.result(
        'READY_TO_PUBLISH',
        'COMPLETED',
        {
          messageId: message.messageId,
          messages: result.messages,
          development: result.development,
          notice: '本轮研发和 App 适配已完成。只有上线运营成功后，才能进行 App 打包。',
        },
        [
          {
            action: 'PUBLISH_AND_PACKAGE',
            requiresUserInput: true,
            instruction: '先按现有流程上线当前适配成果；上线成功后继续 App 应用信息和配置，不重新咨询。',
            command: [
              'superun-ai',
              '--endpoint',
              this.runtime.client.config.endpoint,
              'chat',
              'publish',
              'status',
              '--for-launch',
              '--',
              this.sessionId,
            ],
          },
          {
            action: 'CONTINUE_DEVELOPMENT',
            requiresUserInput: true,
            instruction: '收到新需求后原样继续当前项目，本轮完成后再进行必要适配。',
            command: ['superun-ai', 'chat', 'send', this.sessionId, '--input', '<需求JSON文件>'],
          },
        ],
      ),
      '下一步',
      '适配已完成，接下来想怎么处理？',
      [
        {
          label: '上线并打包',
          description: '先上线运营，成功后继续生成手机体验包。',
          action: 'PUBLISH_AND_PACKAGE',
        },
        { label: '继续研发', description: '直接告诉我想新增或调整的内容。', action: 'CONTINUE_DEVELOPMENT' },
      ],
    );
  }
  async build(buildType: 'debug' | 'release', versionBump: string, acknowledgeUpload: boolean) {
    return this.store.locked(this.key, async () => {
      const prepared = await this.prepare(buildType);
      if (prepared.state !== 'READY')
        throw new CliError('INVALID_ARGUMENT', '当前打包条件尚未满足，请处理列出的缺项', {
          preparation: prepared,
        });
      const context = await this.context();
      if (context.buildPending)
        throw new CliError('OUTCOME_UNKNOWN', '原打包提交结果尚未确认，先查询当前记录，勿重新打包');
      const { gate } = await this.mainline('App 打包');
      if (gate.sourceMessageId !== context.adaptedMessageId)
        throw new CliError(
          'STALE_INTERACTION',
          '适配完成后主线又有变化，请先核对当前需求和必要适配，不直接打旧结果',
        );
      const config = prepared.config as Awaited<ReturnType<AppApi['config']>>;
      if (buildType === 'release' && this.platform !== 'android' && !acknowledgeUpload)
        throw new CliError(
          'INVALID_ARGUMENT',
          '本次应用商店包生成后会自动上传第三方，明确告知并取得本次要求后传 --acknowledge-store-upload',
        );
      const before = await this.api.builds(this.sessionId, this.platform);
      if (before.some((item) => item.buildStatus === 0))
        throw new CliError('INVALID_ARGUMENT', '本平台已有打包任务，继续查询原任务');
      await this.save({
        ...context,
        buildPending: true,
        taskId: undefined,
        priorBuildIds: before.map((item) => item.taskId),
        publishedSnapshotId: config.publishedSnapshotId ?? undefined,
      });
      try {
        const receipt = parseWire(
          z.object({
            taskId: z.string().regex(/^[a-f0-9]{32}$/),
            versionName: z.string(),
            versionCode: z.number(),
          }),
          await this.api.call(
            'runAppBuild',
            {
              sessionId: this.sessionId,
              platform: this.platform,
              buildType,
              versionBump: buildType === 'debug' ? 'none' : versionBump,
              ...(config.environmentIsolationEnabled ? { environment: 'prod' } : {}),
            },
            true,
          ),
        );
        await this.save({
          ...context,
          taskId: receipt.taskId,
          publishedSnapshotId: config.publishedSnapshotId ?? undefined,
        });
        return this.result('BUILD', 'ACCEPTED', receipt, [
          this.action(
            'WAIT_APP_BUILD',
            '继续查询本次构建，不重新打包。',
            ['wait', this.sessionId, receipt.taskId],
            false,
          ),
        ]);
      } catch (error) {
        if (
          error instanceof CliError &&
          ['BUSINESS_ERROR', 'INVALID_ARGUMENT', 'AUTH_REQUIRED'].includes(error.code)
        )
          await this.save(context);
        throw error;
      }
    });
  }
  async buildStatus(taskId?: string): Promise<AppResult> {
    const context = await this.context();
    const records = await this.api.builds(this.sessionId, this.platform);
    let target = taskId ?? context.taskId;
    if (!target && context.buildPending && context.priorBuildIds) {
      const fresh = records.filter((item) => !context.priorBuildIds!.includes(item.taskId));
      if (fresh.length === 1) {
        target = fresh[0]!.taskId;
        await this.updateContext(context, { taskId: target, buildPending: false });
      }
    }
    if (!target)
      return this.result('BUILD', context.buildPending ? 'NEEDS_INPUT' : 'COMPLETED', {
        records,
        notice: context.buildPending
          ? '尚不能唯一确认原提交结果，请核对实际记录，不重复提交。'
          : '当前没有绑定的构建任务，以下为本平台真实最近记录。',
      });
    const record = records.find((item) => item.taskId === target);
    if (!record)
      throw new CliError('INVALID_ARGUMENT', '当前授权列表未返回该任务，不能当作不存在或改查其他项目', {
        taskId: target,
      });
    const state =
      record.buildStatus === 0
        ? 'RUNNING'
        : record.buildStatus === 1
          ? 'COMPLETED'
          : record.buildStatus === 2
            ? 'FAILED'
            : undefined;
    if (!state) throw new CliError('PROTOCOL_ERROR', '服务端返回未知的构建状态');
    if (
      state === 'COMPLETED' &&
      context.taskId === target &&
      context.publishedSnapshotId &&
      record.sourceSnapshotId !== context.publishedSnapshotId
    )
      throw new CliError(
        'STALE_INTERACTION',
        '包已生成，但源码来源与本次上线快照不一致，不能作为本次成果交付',
        { record, expectedSourceSnapshotId: context.publishedSnapshotId },
      );
    const result = this.result(
      'BUILD',
      state,
      {
        record,
        notice:
          state === 'FAILED'
            ? `打包失败：${record.errorMessage || '服务端暂未返回详细原因'}。修正原因后可主动重新打包。`
            : state === 'RUNNING'
              ? '原打包任务仍在进行，继续等待。'
              : '包已生成；安装、上传和审核状态分别核验。',
      },
      state === 'COMPLETED'
        ? [
            this.action(
              'DELIVER_APP',
              '核验本次安装信息，展示二维码和安装链接。',
              ['install', this.sessionId, target],
              false,
            ),
          ]
        : state === 'RUNNING'
          ? [this.action('WAIT_APP_BUILD', '查询原任务，不重提。', ['wait', this.sessionId, target], false)]
          : [],
    );
    if (state !== 'FAILED') return result;
    const retry = ['build', this.sessionId, '--build-type', record.buildType, '--version-bump', 'none'];
    if (record.buildType === 'release' && this.platform !== 'android')
      retry.push('--acknowledge-store-upload');
    return this.question(
      {
        ...result,
        nextActions: [
          this.action(
            'RETRY_APP_BUILD',
            '先处理实际失败原因，用户明确重试后再提交构建；保留旧失败记录。',
            retry,
          ),
        ],
      },
      '打包失败',
      '请先处理以上失败原因，接下来怎么做？',
      [
        { label: '重新打包', description: '原因处理后，重新生成本次包。', action: 'RETRY_APP_BUILD' },
        { label: '稍后处理', description: '保留当前项目和失败记录，暂不重试。', action: 'DEFER_APP_ACTION' },
      ],
    );
  }
}

/** 发布按目标版本与更新时间跟踪结果。@author xiuyu.yi */
import { Option } from 'commander';
import type { Command } from 'commander';
import { list, object, text } from '../../contracts/value.js';
import type { JsonObject } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { runtime, withWait, waitOptions, pollOperation, businessWrite } from '../shared.js';
import { COMMAND_NAME } from '../../config/constants.js';
import type { CreationRuntime } from '../../runtime.js';
import type { NextAction } from '../../contracts/cli-output.js';

function versions(value: JsonObject): Array<JsonObject> {
  return [
    ...(value.unPublishedVersion ? [object(value.unPublishedVersion)] : []),
    ...list(value.publishedVersions).map(object),
  ];
}
function projectPublish(value: JsonObject, encryptedId?: string): JsonObject {
  return {
    targetRegion: value.targetRegion,
    deploymentNode: value.deploymentNode,
    publishUrl: value.publishUrl,
    versions: versions(value)
      .filter((item) => !encryptedId || item.encryptedId === encryptedId)
      .map((item) => ({
        encryptedId: item.encryptedId,
        updatedAt: item.updatedAt,
        deployStatus: item.deployStatus,
        errorMessage: item.errorMessage,
        deploymentSteps: item.deploymentSteps,
        changeLog: item.changeLog,
        changeLogSummary: item.changeLogSummary,
        websiteIntroduction: item.websiteIntroduction,
      })),
  };
}
function publishActions(
  service: CreationRuntime,
  sessionId: string,
  value: JsonObject,
  publicStatus?: number,
  encryptedId?: string,
  forLaunch = false,
  showCompletedGuidance = true,
): Array<NextAction> {
  const command = [
    COMMAND_NAME,
    '--endpoint',
    service.client.config.endpoint,
    '--locale',
    service.client.config.locale,
    'chat',
    'publish',
  ];
  const records = versions(value);
  const pending = records.find(
    (item) => (!encryptedId || item.encryptedId === encryptedId) && item.deployStatus === 2,
  );
  if (pending)
    return [
      {
        action: 'QUERY_PUBLISH',
        instruction: '发布正在进行，继续查询该版本结果，不要重复提交发布。',
        requiresUserInput: false,
        command: [
          ...command,
          'status',
          ...(forLaunch ? ['--for-launch'] : []),
          '--version-id',
          String(pending.encryptedId),
          '--',
          sessionId,
        ],
      },
    ];
  const candidate = encryptedId
    ? records.find((item) => item.encryptedId === encryptedId)
    : object(value.unPublishedVersion);
  const target = text(candidate?.encryptedId);
  if (target && candidate?.deployStatus !== 1)
    return [
      {
        action: 'PUBLISH_VERSION',
        instruction: forLaunch
          ? '用户已明确要求上线运营。原样展示目标版本的 changeLog 作为发布进度说明，与 Glow 发布卡片保持一致；不要改写、概括或用 changeLogSummary 替代，缺少日志时如实说明。直接执行本版本发布并等待完成，不再询问是否确认发布；完成后展示 publishUrl。'
          : '只展示目标版本的 changeLog 原文和发布状态；用户明确要求发布或上线运营后执行发布命令，不把查询状态视为发布授权。',
        requiresUserInput: !forLaunch,
        command: [...command, 'start', ...(forLaunch ? ['--for-launch'] : []), '--', sessionId, target],
      },
    ];
  if (records.some((item) => item.deployStatus === 1) && publicStatus === 0)
    return [
      {
        action: 'MAKE_PUBLIC',
        instruction: forLaunch
          ? '部署已完成，继续按用户的上线运营要求将站点公开，不再重复确认；完成后展示 publishUrl。'
          : '部署已完成，但站点尚未公开；用户明确要求对外上线后执行此命令。',
        requiresUserInput: !forLaunch,
        command: [...command, 'visibility', '--', sessionId, 'public'],
      },
    ];
  if (
    showCompletedGuidance &&
    publicStatus === 1 &&
    records.some((item) => (!encryptedId || item.encryptedId === encryptedId) && item.deployStatus === 1)
  )
    return [
      {
        action: 'CONTINUE_CHAT',
        instruction:
          '展示发布成功结果、目标版本的 changeLog 原文和 publishUrl 可点击链接；未指定版本时使用 updatedAt 最新的已发布版本。最后另起一行原样展示：\n**继续创作**：直接告诉我想新增或调整的内容。\n等待用户响应；收到新的创作要求后，将用户原文不经改写或扩充地放入 content，通过 --input - 提交 JSON，不自动追加需求或重复发布。',
        requiresUserInput: true,
        command: [...command.slice(0, -1), 'send', '--input', '-', '--', sessionId],
      },
    ];
  return [];
}
async function publishResult(
  service: CreationRuntime,
  sessionId: string,
  value: JsonObject,
  encryptedId?: string,
  waitTimedOut = false,
  forLaunch = false,
) {
  const { session } = await service.conversation.recently(sessionId);
  const running = versions(value).some(
    (item) => (!encryptedId || item.encryptedId === encryptedId) && item.deployStatus === 2,
  );
  return {
    state: running || waitTimedOut ? 'RUNNING' : 'COMPLETED',
    sessionId,
    publish: { ...projectPublish(value, encryptedId), publicStatus: session.publicStatus },
    ...(waitTimedOut ? { waitTimedOut } : {}),
    nextActions: publishActions(
      service,
      sessionId,
      value,
      session.publicStatus,
      encryptedId,
      forLaunch,
      !waitTimedOut,
    ),
  };
}
export function registerPublish(chat: Command, context: CommandContext): void {
  const publish = chat.command('publish').description('发布应用和管理站点状态');
  publish
    .command('status <sessionId>')
    .description('查询发布版本与部署进度')
    .option('--version-id <encryptedId>', '只查询指定版本')
    .option('--for-launch', '用户已明确要求上线运营，返回直接发布的后续动作；本命令仍只读')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        value = await service.publish.status(sessionId),
        options = object(command.opts());
      context.output.write(
        await publishResult(
          service,
          sessionId,
          value,
          text(options.versionId),
          false,
          options.forLaunch === true,
        ),
      );
    });
  withWait(
    publish
      .command('start <sessionId> <encryptedId>')
      .description('发布指定版本')
      .option('--for-launch', '继续已授权的上线运营流程，部署后引导公开站点')
      .addOption(new Option('--region <region>', '部署区域').choices(['CN', 'INTL']))
      .addOption(
        new Option('--indexing <policy>', '搜索引擎索引策略；不代表访问权限').choices(['allow', 'deny']),
      )
      .option('--acknowledge-cloud-fee', '确认服务端提示的云服务费用'),
  ).action(async (sessionId: string, encryptedId: string, _options: unknown, command: Command) => {
    const service = await runtime(context, command),
      options = object(command.opts());
    const before = versions(await service.publish.status(sessionId)).find(
      (item) => item.encryptedId === encryptedId,
    );
    if (!before) throw new CliError('INVALID_ARGUMENT', '该版本不在当前项目的可发布记录中');
    if (before.deployStatus === 2) throw new CliError('INVALID_ARGUMENT', '该版本正在发布，请查询进度');
    await businessWrite(context, service, sessionId, async () => {
      const response = await service.publish.start({
        sessionId,
        encryptedId,
        changeLog: text(before.changeLog),
        changeLogSummary: text(before.changeLogSummary),
        websiteIntroduction: text(before.websiteIntroduction),
        targetRegion: text(options.region),
        ...(options.indexing ? { noIndex: options.indexing === 'deny' } : {}),
        ...(options.acknowledgeCloudFee ? { acknowledgedCloudServiceFee: true } : {}),
      });
      try {
        await service.command.sessionExtra(sessionId, { hasViewedLaunch: '1' });
      } catch {
        throw new CliError(
          'OUTCOME_UNKNOWN',
          '发布已提交，但发布阶段标记同步未确认；请查询发布进度，勿重复提交',
          {
            sessionId,
            encryptedId,
            phase: 'PUBLISH_STAGE_SYNC',
            retryable: false,
          },
        );
      }
      return response;
    });
    if (options.wait === false) {
      context.output.write({
        state: 'ACCEPTED',
        sessionId,
        publish: { encryptedId },
        nextActions: publishActions(
          service,
          sessionId,
          { publishedVersions: [{ encryptedId, deployStatus: 2 }] },
          undefined,
          encryptedId,
          options.forLaunch === true,
        ),
      });
      return;
    }
    let observed: JsonObject = {},
      waitTimedOut = false;
    try {
      observed = await pollOperation(
        () => service.publish.status(sessionId),
        (value) => {
          const record = versions(value).find((item) => item.encryptedId === encryptedId);
          return (
            !!record && Number(record.updatedAt) > Number(before.updatedAt ?? 0) && record.deployStatus !== 2
          );
        },
        { ...waitOptions(command), signal: context.signal },
      );
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'LOCAL_WAIT_TIMEOUT') throw error;
      waitTimedOut = true;
      observed = await service.publish.status(sessionId);
    }
    const record = versions(observed).find((item) => item.encryptedId === encryptedId);
    if (!waitTimedOut && record?.deployStatus !== 1)
      throw new CliError('BUSINESS_ERROR', text(record?.errorMessage) ?? '发布失败', {
        sessionId,
        encryptedId,
        publish: projectPublish(observed, encryptedId),
      });
    context.output.write(
      await publishResult(
        service,
        sessionId,
        observed,
        encryptedId,
        waitTimedOut,
        options.forLaunch === true,
      ),
    );
  });
  publish
    .command('visibility <sessionId> <visibility>')
    .description('设置站点上线或下线状态')
    .action(async (sessionId: string, visibility: string, _options: unknown, command: Command) => {
      if (!['public', 'private'].includes(visibility))
        throw new CliError('INVALID_ARGUMENT', 'visibility 必须为 public 或 private');
      const service = await runtime(context, command);
      if (
        visibility === 'public' &&
        !versions(await service.publish.status(sessionId)).some((item) => item.deployStatus === 1)
      )
        throw new CliError('INVALID_ARGUMENT', '请先成功部署一个版本再上线');
      await businessWrite(context, service, sessionId, () =>
        service.publish.visibility(sessionId, visibility === 'public'),
      );
      context.output.write({
        ...(await publishResult(service, sessionId, await service.publish.status(sessionId))),
        visibility,
      });
    });
}

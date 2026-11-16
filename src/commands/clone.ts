import { siteUrl, prepareSiteCloneInput } from '../conversation/site-clone-input.js';
/** 网站搬家：新建项目、观察进展和采用结果。@author xiuyu.yi */
import { Option } from 'commander';
import type { Command } from 'commander';
import type { CommandContext } from './shared.js';
import { businessWrite, runtime, positive, readInput } from './shared.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import {
  cloneCommand,
  cloneResult,
  cloneState,
  continueClone,
  siteCloneWeeklyDecision,
} from '../conversation/site-clone.js';
import { parseCloneCursor, waitForClone } from '../conversation/site-clone-waiter.js';
import type { SiteCloneQuotaEstimate } from '../contracts/cli-output.js';
import { SITE_CLONE_WEEKLY_QUOTA_KEY } from '../config/constants.js';
import { requestChannel } from '../config/request-channel.js';

const CLONE_NOTICE = '网站搬家已经开始，在后台运行：先读网站，读完自动生成第一版页面，整个过程比较久。';
const CLONE_INSTRUCTION =
  '告诉用户搬家已经在后台运行、需要一段时间，给项目页链接让用户随时去看；通过 clone wait 持续跟进同一项目，展示过程提醒和最终预览。';

export { siteUrl } from '../conversation/site-clone-input.js';

export function registerClone(program: Command, context: CommandContext): void {
  const clone = program
    .command('clone')
    .description('网站搬家：把已有网站的页面样式和内容复刻成 superun 项目');
  clone
    .command('prepare')
    .description('解析搬家输入，返回单网址、多网址选择或补充网址引导')
    .requiredOption('--input <file>', '输入 JSON 文件，只包含 content 与可选 selectedUrl')
    .action(async (_options: unknown, command: Command) => {
      const input = await readInput(command.opts<{ input: string }>().input);
      if (
        typeof input.content !== 'string' ||
        (input.selectedUrl !== undefined && typeof input.selectedUrl !== 'string') ||
        Object.keys(input).some((key) => !['content', 'selectedUrl'].includes(key))
      )
        throw new CliError('INVALID_ARGUMENT', '输入须包含 content，可选 selectedUrl');
      context.output.write(prepareSiteCloneInput(input.content, input.selectedUrl as string | undefined));
    });
  clone
    .command('create')
    .allowExcessArguments(false)
    .argument('<url>', '要搬家的网站地址，省略协议时按 https://', siteUrl)
    .description(
      '输入网址新建搬家项目，提交后在后台运行，不用等待；每周有免费次数（free-quota 的 site_clone_weekly），用完后按积分收费',
    )
    .option('--workspace-id <workspaceId>', '归属工作空间')
    .action(async (url: string, _options: unknown, command: Command) => {
      const { workspaceId } = command.opts<{ workspaceId?: string }>();
      const service = await runtime(context, command);
      const config = { language: service.client.config.locale };
      const quota = (await service.query.userFreeQuota(undefined, 5_000).catch(() => [])).find(
        (item) => item.quotaKey === SITE_CLONE_WEEKLY_QUOTA_KEY && item.scope === 'user',
      );
      if (context.signal.aborted) throw new CliError('INTERRUPTED', '已停止本地提交');
      const quotaEstimate: SiteCloneQuotaEstimate = quota
        ? {
            status: 'available',
            ...quota,
            scope: 'user',
            quotaKey: SITE_CLONE_WEEKLY_QUOTA_KEY,
            expectedCharge: quota.remaining > 0 ? 'free' : 'paid',
          }
        : { status: 'unknown', quotaKey: SITE_CLONE_WEEKLY_QUOTA_KEY };
      context.output.cloneQuota(quotaEstimate);
      const response = object(
        await businessWrite(context, service, undefined, () =>
          service.command.chat({
            content: url,
            workspaceId,
            // 和 Glow 搬家页一样从探索阶段读站开始；服务端读完自动交接并生成第一版。
            sessionExtra: {
              agentRuntime: 'shire',
              siteClone: '1',
              hasSlidesIntent: '0',
              generatedByBranch: '1',
              version: '6',
              source: requestChannel,
            },
            roundExtra: { ROUND_LANGUAGE: config.language },
          }),
        ),
      );
      // 搬家耗时长，提交后不跟：告诉用户已在后台运行，给项目页链接。
      const sessionId = text(response.sessionId);
      if (!sessionId)
        throw new CliError('OUTCOME_UNKNOWN', '搬家请求已返回，但缺少项目 ID；请先查询项目列表，勿重复创建', {
          retryable: false,
        });
      const projectUrl = new URL(
        `/web/project/${encodeURIComponent(sessionId)}`,
        service.client.config.endpoint,
      ).href;
      // 创建已受理。查询失败保留项目 ID，后续 wait 会重新读取服务端资格。
      const sessionExtra = await service.query.extra(sessionId, 2_000).catch(() => ({}));
      context.output.write({
        state: 'ACCEPTED',
        sessionId,
        messageId: text(response.messageId),
        replyMessageId: text(response.replyMessageId),
        cloneNotice: CLONE_NOTICE,
        siteClone: {
          projectUrl,
          quotaEstimate,
          weeklyFreeDecision: siteCloneWeeklyDecision(object(sessionExtra).siteCloneFree),
          quotaNote:
            '提交前的余量仅用于预估。免费资格覆盖首轮读站与页面搬家，后续样式编辑和研发按平台规则计费；实际领取及算力扣减以服务端和账单为准。',
        },
        nextActions: [
          {
            action: 'VIEW_PROJECT',
            requiresUserInput: false,
            url: projectUrl,
            instruction: CLONE_INSTRUCTION,
            command: cloneCommand(service, 'wait', sessionId),
          },
        ],
      });
    });
  clone
    .command('wait <sessionId>')
    .description('等待网站搬家，展示预计剩余时间和项目链接')
    .option('--timeout <seconds>', '本次等待窗口', positive)
    .option('--message-id <messageId>', '等待本次补充或回复对应的消息进入主线')
    .option('--cursor <file>', '上次等待的完整 JSON 回执文件')
    .option('--submitted-interaction-id <id>', '等待已提交问题的回复同步')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const options = command.opts<{
        timeout?: number;
        cursor?: string;
        messageId?: string;
        submittedInteractionId?: string;
      }>();
      const saved = options.cursor ? object(await readInput(options.cursor)) : {};
      const cursor = options.cursor
        ? parseCloneCursor(service, sessionId, object(object(saved.data ?? saved).cursor).siteClone)
        : undefined;
      context.output.write(
        await waitForClone(service, sessionId, {
          timeout: options.timeout,
          messageId: options.messageId,
          submittedInteractionId: options.submittedInteractionId,
          cursor,
        }),
      );
    });
  clone
    .command('continue <sessionId>')
    .description('采用搬家结果修改样式，或开发真实功能')
    .addOption(
      new Option('--target <mode>', '后续目标').choices(['demo', 'development']).makeOptionMandatory(),
    )
    .option('--result-id <id>', '本次已展示的搬家结果标识')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const options = command.opts<{ target: 'demo' | 'development'; resultId?: string }>();
      const response = await businessWrite(context, service, sessionId, () =>
        continueClone(service, sessionId, options.target, options.resultId),
      );
      const receipt = object(response);
      if (receipt.alreadyContinued) {
        context.output.write(await cloneResult(service, await cloneState(service, sessionId)));
        return;
      }
      const { endpoint, locale } = service.client.config;
      const messageId = text(receipt.messageId) ?? text(receipt.replyMessageId);
      context.output.write({
        state: 'ACCEPTED',
        ...receipt,
        sessionId,
        nextActions: [
          {
            action: 'WAIT',
            requiresUserInput: false,
            instruction:
              options.target === 'development'
                ? '正在整理研发规划和功能清单，继续等待本轮结果。'
                : '继续等待本轮样式编辑及预览。',
            command: [
              'superun-ai',
              '--endpoint',
              endpoint,
              '--locale',
              locale,
              'chat',
              'wait',
              sessionId,
              ...(messageId ? ['--message-id', messageId] : []),
            ],
          },
        ],
      });
    });
}

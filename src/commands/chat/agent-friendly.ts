/** Agent 友好：同源 chat 生成能力，按用户选择交付完整接入原文。@author xiuyu.yi */
import { Option, type Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite, withWait, waitOptions } from '../shared.js';
import { object, text } from '../../contracts/value.js';
import { AgentFriendlyApi } from '../../api/agent-friendly-api.js';
import { agentFriendlyChat, type AgentFriendlyMethod } from '../../conversation/agent-friendly-prompts.js';
import {
  agentFriendlyGuidance,
  agentFriendlyNotReady,
  isAgentFriendlyRound,
  projectAgentFriendlyGeneration,
  readyAgentFriendly,
} from '../../conversation/agent-friendly.js';
import { SessionWaiter } from '../../conversation/session-waiter.js';
import { CliError } from '../../output/exit-codes.js';
import {
  agentFriendlyAccess,
  agentFriendlyPublication,
  agentFriendlyAnchor,
  agentFriendlyWritePreflight,
} from '../../conversation/agent-friendly-preflight.js';

export function registerAgentFriendly(chat: Command, context: CommandContext): void {
  withWait(
    chat.command('agent-friendly <sessionId>').description('准备 Agent 友好能力，选择技能或连接器接入方式'),
  )
    .addOption(
      new Option('--method <method>', '展示所选方式的完整接入指令，不执行安装').choices([
        'skill',
        'connector',
      ]),
    )
    .option('--status', '只查询或等待已有接入任务，不触发生成')
    .option('--message-id <messageId>', '跟进已提交的接入生成消息')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const options = object(command.opts());
      const method = options.method as AgentFriendlyMethod | undefined;
      let messageId = text(options.messageId);
      if (
        !/^[A-Za-z0-9_-]+$/.test(sessionId) ||
        (messageId !== undefined && !/^[A-Za-z0-9_-]+$/.test(messageId))
      )
        throw new CliError('INVALID_ARGUMENT', '请明确一个作品和有效的本次生成消息ID');
      if (messageId && !options.status)
        throw new CliError('INVALID_ARGUMENT', '指定消息时须使用 --status，避免重新发起生成');
      const api = new AgentFriendlyApi(service.client);
      const view = await service.load(sessionId);
      await agentFriendlyAccess(service, view, sessionId);
      const publication = await agentFriendlyPublication(service, view);
      if (!publication.ready) {
        context.output.write(
          agentFriendlyGuidance(service, {
            ...agentFriendlyNotReady(sessionId, publication.reason),
            ...(messageId ? { messageId } : {}),
          }),
        );
        return;
      }
      if (messageId && agentFriendlyAnchor(view, messageId) === 'MISSING') {
        context.output.write(
          agentFriendlyGuidance(service, {
            ...agentFriendlyNotReady(
              sessionId,
              '指定生成消息尚未确认归属当前主线，请核对回执或稍后查询同一消息，不会返回其它指南。',
            ),
            messageId,
          }),
        );
        return;
      }
      const enabled = await api.enabled(sessionId);
      const busy =
        [0, 1, 2, 4, 10].includes(view.session.status) ||
        (await service.taskProgress.hasPendingSubagentWork(sessionId));
      const ownsTask = isAgentFriendlyRound(view);
      if (enabled && !messageId && (!ownsTask || !busy)) {
        const result = ownsTask
          ? await projectAgentFriendlyGeneration(service, api, view)
          : await readyAgentFriendly(service, api, view, method);
        context.output.write(
          result.agentFriendly.stage === 'READY' && method
            ? await readyAgentFriendly(service, api, view, method)
            : result,
        );
        return;
      }
      if (busy && !ownsTask && !messageId) {
        context.output.write(
          agentFriendlyGuidance(
            service,
            agentFriendlyNotReady(
              sessionId,
              '当前项目仍有其他任务或待回答问题，请先处理当前会话，再继续 Agent 友好接入。',
            ),
          ),
        );
        return;
      }
      if (!busy && !ownsTask && (options.status || method)) {
        context.output.write(
          agentFriendlyGuidance(
            service,
            agentFriendlyNotReady(
              sessionId,
              '当前项目尚未开启 Agent 友好，请先选择“Agent 友好”准备项目接入能力。',
            ),
          ),
        );
        return;
      }
      if (!enabled && !busy && !options.status && !method && !messageId) {
        const preflight = await agentFriendlyWritePreflight(service, sessionId);
        const response = object(
          await businessWrite(context, service, sessionId, async () => {
            const fresh = await agentFriendlyWritePreflight(
              service,
              sessionId,
              preflight.gate.sourceMessageId,
            );
            if (
              fresh.publication.publishUrl !== preflight.publication.publishUrl ||
              fresh.publication.supabaseUrl !== preflight.publication.supabaseUrl ||
              (await api.enabled(sessionId))
            )
              throw new CliError('STALE_INTERACTION', '接入状态或正式目标已变化，请重新查询，未重复生成');
            return service.command.chat(agentFriendlyChat(sessionId));
          }),
        );
        if (response.sessionId !== undefined && response.sessionId !== sessionId)
          throw new CliError('OUTCOME_UNKNOWN', '接入生成回执项目不一致，请核对原项目，勿重发', {
            sessionId,
            retryable: false,
          });
        messageId = text(response.messageId);
        if (!messageId || !/^[A-Za-z0-9_-]+$/.test(messageId) || messageId === preflight.gate.sourceMessageId)
          throw new CliError(
            'OUTCOME_UNKNOWN',
            '接入生成已提交但未取得消息标识，请查询当前会话，勿重复生成',
            { sessionId, retryable: false },
          );
      }
      if (options.wait === false && ownsTask && (options.status || method || enabled)) {
        const result = await projectAgentFriendlyGeneration(service, api, view, messageId);
        context.output.write(
          result.agentFriendly.stage === 'READY' && method
            ? await readyAgentFriendly(service, api, view, method)
            : result,
        );
        return;
      }
      if (options.wait === false && (busy || messageId)) {
        context.output.write(
          agentFriendlyGuidance(service, {
            state: 'RUNNING',
            sessionId,
            messageId,
            messages: [
              {
                id: `${sessionId}:agent-friendly:generating`,
                role: 'assistant',
                text: '正在为你的项目准备 AI 应用接入能力。',
              },
            ],
            interactions: [],
            progress: [],
            agentFriendly: { stage: 'GENERATING' },
          }),
        );
        return;
      }
      const waiter = new SessionWaiter({
        conversation: service.conversation,
        command: service.command,
        load: (id) => service.load(id),
        inspect: (value) => projectAgentFriendlyGeneration(service, api, value, messageId),
        onProgress: (result) => context.output.progress(result),
        signal: context.signal,
      });
      const result = await waiter.wait(sessionId, {
        ...waitOptions(command),
        messageId,
        // 已提交的生成始终固定消息锚点；无法确认来源时不降级为任意当前指南。
        requiredMessageId: messageId,
      });
      // 等待器会保留起始回合消息；就绪后只交付方式选择，避免展开生成时两种方式的长说明。
      if (object(object(result).agentFriendly).stage === 'READY') {
        context.output.write(await readyAgentFriendly(service, api, await service.load(sessionId), method));
      } else context.output.write(result);
    });
}

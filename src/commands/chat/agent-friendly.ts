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
      if (messageId && !options.status)
        throw new CliError('INVALID_ARGUMENT', '指定消息时须使用 --status，避免重新发起生成');
      const api = new AgentFriendlyApi(service.client);
      const view = await service.load(sessionId);
      const enabled = await api.enabled(sessionId);
      const busy =
        [0, 1, 2, 4, 10].includes(view.session.status) ||
        (await service.taskProgress.hasPendingSubagentWork(sessionId));
      const ownsTask = isAgentFriendlyRound(view);
      if (!busy && enabled) {
        context.output.write(await readyAgentFriendly(service, api, view, method));
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
      if (!busy && !options.status && !method && !messageId) {
        if (view.session.publicStatus !== 1)
          throw new CliError('INVALID_ARGUMENT', '请先完成上线运营，再准备 Agent 友好接入能力', {
            sessionId,
          });
        if (view.session.status !== 3)
          throw new CliError('INVALID_ARGUMENT', '请先处理当前任务或异常，再准备 Agent 友好接入能力', {
            sessionId,
          });
        const response = object(
          await businessWrite(context, service, sessionId, () =>
            service.command.chat(agentFriendlyChat(sessionId)),
          ),
        );
        messageId = text(response.messageId) ?? text(response.replyMessageId);
        if (!messageId)
          throw new CliError(
            'OUTCOME_UNKNOWN',
            '接入生成已提交但未取得消息标识，请查询当前会话，勿重复生成',
            { sessionId, retryable: false },
          );
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
        inspect: (value) => projectAgentFriendlyGeneration(service, api, value),
        onProgress: (result) => context.output.progress(result),
        signal: context.signal,
      });
      const result = await waiter.wait(sessionId, {
        ...waitOptions(command),
        messageId,
        // 恢复查询时起始消息可能已被折叠；只对新提交的生成请求等待消息入流。
        requiredMessageId: options.status ? undefined : messageId,
      });
      // 等待器会保留起始回合消息；就绪后只交付方式选择，避免展开生成时两种方式的长说明。
      if (object(object(result).agentFriendly).stage === 'READY') {
        context.output.write(await readyAgentFriendly(service, api, await service.load(sessionId), method));
      } else context.output.write(result);
    });
}

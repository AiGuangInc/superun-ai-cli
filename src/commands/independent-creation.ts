/** PPT 与智能体应用的独立新建、继续澄清入口，不修改通用 creation 流程。@author xiuyu.yi */
import type { Command } from 'commander';
import { z } from 'zod';
import type { CommandContext } from './shared.js';
import { businessWrite, readInput, runtime } from './shared.js';
import type { CreationRuntime } from '../runtime.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { requestChannel } from '../config/request-channel.js';
import { prepareUploadFiles } from '../api/upload-files.js';
import { uploadAttachment, type InputAttachment } from '../api/upload-api.js';
import { collectInteractions } from '../interactions/registry.js';
import { resolveAnswers } from '../interactions/questions.js';
import { hasPendingCreationWork } from '../conversation/state-resolver.js';
import { projectEditingState } from '../conversation/project-check-preflight.js';

type Flow = 'ppt' | 'agent-app';
const textInput = z.object({ content: z.string().optional(), message: z.string().optional() }).strict();
const refineInput = z.object({ answers: z.array(z.unknown()), content: z.string().optional() }).strict();

async function currentQuestionnaire(
  service: CreationRuntime,
  sessionId: string,
  interactionId: string,
  flow: Flow,
) {
  const view = await service.load(sessionId);
  const bindings = collectInteractions(view);
  const binding = bindings.find((item) => item.interaction.interactionId === interactionId);
  if (
    view.session.sessionId !== sessionId ||
    view.session.status !== 3 ||
    view.session.waiting !== false ||
    view.session.errorType ||
    view.session.pendingBranch ||
    view.extra.agentRuntime === 'shire' ||
    String(view.extra.hasClarifiedPrd) === '1' ||
    hasPendingCreationWork(view) ||
    (view.extra.cliIndependentCreation && view.extra.cliIndependentCreation !== flow) ||
    (flow === 'ppt' && String(view.extra.hasSlidesIntent) !== '1') ||
    (flow === 'agent-app' && String(view.extra.hasSlidesIntent) === '1') ||
    !binding ||
    !binding.current ||
    binding.round.sessionId !== sessionId ||
    binding.interaction.kind !== 'PRD_CLARIFICATION' ||
    bindings.some((item) => item.interaction.kind !== 'PRD_CLARIFICATION') ||
    (await service.taskProgress.hasPendingSubagentWork(sessionId))
  )
    throw new CliError('STALE_INTERACTION', '当前不是本次可继续澄清的需求问卷，请先查询原项目状态', {
      sessionId,
    });
  return binding;
}

export function registerIndependentCreation(parent: Command, context: CommandContext, flow: Flow): void {
  parent
    .command('create')
    .description('独立新建并提交需求，后续沿回执查询问卷')
    .option('--message <text>', '用户原始需求')
    .option('--input <file>', '仅含 content 或 message 的 JSON 文件，- 表示标准输入')
    .option(
      '--file <path>',
      '上传本地资料，可重复使用',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--model <model>', '选择模型')
    .option('--workspace-id <workspaceId>', '归属工作空间')
    .option('--no-wait', '仅提交，不自动推进后续阶段')
    .action(async (_options: unknown, command: Command) => {
      const options = command.opts<{
        message?: string;
        input?: string;
        file: string[];
        model?: string;
        workspaceId?: string;
      }>();
      if (options.message !== undefined && options.input !== undefined)
        throw new CliError('INVALID_ARGUMENT', '--message 与 --input 不能同时使用');
      const parsed = textInput.safeParse(
        options.input !== undefined ? await readInput(options.input) : { content: options.message },
      );
      if (!parsed.success || (parsed.data.content !== undefined && parsed.data.message !== undefined))
        throw new CliError(
          'INVALID_ARGUMENT',
          '需求 JSON 只接受 content 或 message 一个文本字段，附件使用 --file',
        );
      const content = parsed.data.content ?? parsed.data.message ?? '';
      if (!content.trim() && !options.file.length) throw new CliError('INVALID_ARGUMENT', '请提供需求或附件');
      const service = await runtime(context, command);
      const files = await prepareUploadFiles(service, options.file);
      const attachments: InputAttachment[] = [];
      for (const file of files) attachments.push(await uploadAttachment(service, file));
      const config = await service.config.creation(content);
      const response = object(
        await businessWrite(context, service, undefined, () =>
          service.command.chat({
            content,
            model: options.model,
            workspaceId: options.workspaceId,
            ...(attachments.length ? { attachments } : {}),
            sessionExtra: {
              agentRuntime: 'glow',
              hasSlidesIntent: flow === 'ppt' ? '1' : '0',
              hasClarifiedPrd: '0',
              generatedByBranch: '1',
              version: '6',
              source: requestChannel,
              cliIndependentCreation: flow,
            },
            businessParams: {
              business_type: 'stage1_action',
              action: flow === 'ppt' ? 'slides' : 'manageApp',
            },
            roundExtra: { ROUND_LANGUAGE: config.language },
          }),
        ),
      );
      context.output.write(await service.accepted(response, undefined, false, {}));
    });

  parent
    .command('refine <sessionId> <interactionId>')
    .description('独立保存当前问卷并继续澄清，不触发方案生成')
    .requiredOption('--input <file>', '包含 answers 与可选 content 的 JSON 文件，- 表示标准输入')
    .option('--no-wait', '仅提交，后续查询原任务')
    .action(async (sessionId: string, interactionId: string, _options: unknown, command: Command) => {
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new CliError('INVALID_ARGUMENT', '请明确一个项目 ID');
      const parsed = refineInput.safeParse(await readInput(command.opts<{ input: string }>().input));
      if (!parsed.success)
        throw new CliError('INVALID_ARGUMENT', '澄清输入只接受 answers 与可选 content 文本');
      const service = await runtime(context, command);
      const binding = await currentQuestionnaire(service, sessionId, interactionId, flow);
      const answers = resolveAnswers(binding.interaction.questions, parsed.data.answers, {
        allowEmpty: true,
      });
      const response = object(
        await businessWrite(context, service, sessionId, async () => {
          await projectEditingState(service, sessionId);
          const fresh = await currentQuestionnaire(service, sessionId, interactionId, flow);
          if (JSON.stringify(fresh.interaction.questions) !== JSON.stringify(binding.interaction.questions))
            throw new CliError('STALE_INTERACTION', '需求问题已经变化，请重新查询后作答');
          const { source } = fresh.interaction;
          const name = `internal/prd_answers__${source.messageId}__${source.contentId.replace('.', '_')}.json`;
          await service.command.saveAttachment(
            sessionId,
            name,
            answers.map((answer) => ({
              question: answer.question.question,
              selectedIndices: answer.selectedIndices,
              selectedOptions: answer.selectedOptions,
              otherSelected: !!answer.otherValue,
              otherValue: answer.otherValue,
            })),
            fresh.round.anchorUserMessageId,
          );
          await service.command.contentExtra({
            sessionId,
            messageId: source.messageId,
            contentId: source.contentId,
            extra: { ...object(fresh.item.payload.extra), prdAnswersAttachment: name },
          });
          const latest = await currentQuestionnaire(service, sessionId, interactionId, flow);
          if (JSON.stringify(latest.interaction.questions) !== JSON.stringify(fresh.interaction.questions))
            throw new CliError('STALE_INTERACTION', '需求问题已经变化，答案已保存，请查询当前状态');
          const questions = answers
            .filter((answer) => answer.selectedOptions.length || answer.otherValue)
            .map(
              (answer) =>
                `${answer.question.question}\n${[...answer.selectedOptions, answer.otherValue].filter(Boolean).join('\n')}`,
            )
            .join('\n');
          return service.command.chat({
            sessionId,
            content: parsed.data.content?.trim() || '还没想好',
            businessParams: { business_type: 'expand_questionnaire', ...(questions ? { questions } : {}) },
          });
        }),
      );
      context.output.write(await service.accepted(response, sessionId, false, {}));
    });
}

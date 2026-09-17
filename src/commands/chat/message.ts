/** 创建与续写共用的消息输入、附件上传和发送流程。@author xiuyu.yi */
import type { Command } from 'commander';
import { z } from 'zod';
import { object, text } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import { prepareUploadFiles } from '../../api/upload-files.js';
import { uploadAttachment } from '../../api/upload-api.js';
import type { InputAttachment } from '../../api/upload-api.js';
import { currentRound, roundMessage } from '../../conversation/round-selector.js';
import {
  AUTO_TEST_DEFAULT_MESSAGE,
  AUTO_TEST_OPERATION_KEY,
  AUTO_TEST_SOURCE_KEY,
} from '../../conversation/auto-test.js';
import { hasCompletedCreationResult } from '../../conversation/next-actions.js';
import {
  CODE_REVIEW_DEFAULT_MESSAGE,
  CODE_REVIEW_OPERATION_KEY,
  CODE_REVIEW_SOURCE_KEY,
} from '../../conversation/code-review.js';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, businessWrite } from '../shared.js';

const inputSchema = z
  .object({
    content: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export const appendValue = (value: string, previous: Array<string>): Array<string> => [...previous, value];
export function messageOptions(command: Command): Command {
  return withWait(
    command
      .option('--message <text>', '需求文本')
      .option('--input <file>', '仅含 content 或 message 文本字段的 JSON 文件，- 表示标准输入')
      .option('--file <path>', '上传本地附件，可重复使用；格式和大小以服务端限制为准', appendValue, []),
  );
}
export async function sendMessage(
  context: CommandContext,
  sessionId: string | undefined,
  command: Command,
  check?: 'test' | 'review',
): Promise<void> {
  const options = object(command.opts());
  const files = z.array(z.string()).parse(options.file ?? []);
  const testFollowup = text(options.testFollowup),
    reviewFollowup = text(options.reviewFollowup);
  if (testFollowup && reviewFollowup)
    throw new CliError('INVALID_ARGUMENT', '不能同时回复自动测试和代码审查报告');
  const followup = reviewFollowup ?? testFollowup;
  const checkKind = check ?? (reviewFollowup ? 'review' : testFollowup ? 'test' : undefined);
  const label = checkKind === 'review' ? '代码审查' : '自动测试';
  const operationKey = checkKind === 'review' ? CODE_REVIEW_OPERATION_KEY : AUTO_TEST_OPERATION_KEY;
  const sourceKey = checkKind === 'review' ? CODE_REVIEW_SOURCE_KEY : AUTO_TEST_SOURCE_KEY;
  const hasMessage = typeof options.message === 'string',
    hasInput = typeof options.input === 'string';
  if ((hasMessage && hasInput) || (!check && !hasMessage && !hasInput && !files.length))
    throw new CliError(
      'INVALID_ARGUMENT',
      '请指定 --message、--input 或 --file；--message 与 --input 不能同时使用',
    );
  const raw =
    typeof options.input === 'string'
      ? await readInput(options.input)
      : {
          content:
            options.message ??
            (check === 'review'
              ? CODE_REVIEW_DEFAULT_MESSAGE
              : check === 'test'
                ? AUTO_TEST_DEFAULT_MESSAGE
                : undefined),
        };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.content !== undefined && parsed.data.message !== undefined))
    throw new CliError(
      'INVALID_ARGUMENT',
      'JSON 只接受 content 或 message 文本字段，不能同时提供；附件请使用 --file，不接受内联内容或附件 URL',
    );
  const input = parsed.data,
    content = input.content ?? input.message ?? '';
  if (!content.trim() && (check || !files.length))
    throw new CliError(
      'INVALID_ARGUMENT',
      check ? `${label}范围不能为空；省略 --message 可检查刚才完成的内容` : '需求文本不能为空',
    );
  const service = await runtime(context, command);
  const preparedFiles = await prepareUploadFiles(service, files);
  const previous =
    sessionId && (options.wait !== false || checkKind) ? await service.load(sessionId) : undefined;
  let operation: 'test' | 'review' | 'repair' | undefined;
  if (checkKind && previous) {
    if (previous.extra.agentRuntime === 'shire')
      throw new CliError('INVALID_ARGUMENT', `当前处于探索阶段，请先完成研发，再对已有功能执行${label}`);
    const current = await service.inspect(previous);
    const currentCheck = checkKind === 'review' ? current.codeReview : current.autoTest;
    if (followup && (!currentCheck || currentCheck.sourceMessageId !== followup))
      throw new CliError('STALE_INTERACTION', `${label}报告已被后续对话替换，请重新查询当前状态`);
    if (
      (await service.taskProgress.hasPendingSubagentWork(previous.session.sessionId)) ||
      current.interactions.some((item) => item.kind !== 'SELECT_FEATURES') ||
      !(
        ['FAILED', 'INTERRUPTED', 'CANCELLED', 'PAUSED'].includes(current.state) ||
        hasCompletedCreationResult(current)
      )
    )
      throw new CliError('INVALID_ARGUMENT', `请先等待当前任务结束或回答当前问题，再发起${label}或后续修复`, {
        sessionId,
        observedState: service.withGuidance(current),
      });
    operation = check ?? 'repair';
  }
  const attachments: InputAttachment[] = [];
  for (const file of preparedFiles) attachments.push(await uploadAttachment(service, file));
  const previousMessageId = previous ? roundMessage(previous, currentRound(previous))?.messageId : undefined;
  const create = sessionId ? undefined : await service.config.creation(content);
  const response = await businessWrite(context, service, sessionId, () =>
    service.command.chat({
      sessionId,
      content,
      ...(attachments.length ? { attachments } : {}),
      model: text(options.model),
      workspaceId: text(options.workspaceId),
      ...(operation
        ? {
            roundExtra: {
              [operationKey]: operation,
              ...(followup ? { [sourceKey]: followup } : {}),
            },
            businessParams: {
              business_type:
                check === 'review' ? 'issue_review' : check === 'test' ? 'auto_test' : 'casual_chat',
            },
          }
        : {}),
      ...(create
        ? {
            sessionExtra: {
              // 新建项目直接进入 Stage 1（构想阶段）。
              agentRuntime: 'glow',
              hasSlidesIntent: '0',
              hasClarifiedPrd: '0',
              generatedByBranch: '1',
              version: '6',
            },
            roundExtra: {
              ROUND_LANGUAGE: create.language,
            },
          }
        : {}),
    }),
  );
  context.output.write(
    await service.accepted(
      {
        ...object(response),
        progressTitle: content,
        ...(operation
          ? checkKind === 'review'
            ? { codeReviewPhase: operation }
            : { autoTestPhase: operation }
          : {}),
      },
      sessionId,
      options.wait !== false,
      {
        ...waitOptions(command),
        previousMessageId,
      },
    ),
  );
}

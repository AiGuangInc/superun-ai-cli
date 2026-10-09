/** 发布后委托高级设计师调整页面，不进入风格候选生成流程。@author xiuyu.yi */
import type { Command } from 'commander';
import { z } from 'zod';
import { prepareUploadFiles } from '../../api/upload-files.js';
import { uploadAttachment } from '../../api/upload-api.js';
import type { InputAttachment } from '../../api/upload-api.js';
import { enabled, object } from '../../contracts/value.js';
import { hasCompletedCreationResult } from '../../conversation/next-actions.js';
import { currentRound, roundMessage } from '../../conversation/round-selector.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { businessWrite, readInput, runtime, waitOptions } from '../shared.js';
import { messageOptions } from './message.js';

export const ADVANCED_DESIGNER_PROMPT = '请告诉我想调整哪些页面、具体想怎么改；也可以重新设计方案。';

const inputSchema = z.object({ content: z.string().optional(), message: z.string().optional() }).strict();
const designerPrefix =
  /^@(?:高级设计师|高級設計師|Senior designer|シニアデザイナー|시니어 디자이너)(?=\s|$)\s*/i;

export function registerDesign(chat: Command, context: CommandContext): void {
  messageOptions(
    chat.command('design <sessionId>').description('委托高级设计师调整页面或重新设计方案'),
  ).action(async (sessionId: string, _options: unknown, command: Command) => {
    const options = object(command.opts());
    const hasMessage = typeof options.message === 'string';
    const hasInput = typeof options.input === 'string';
    if (hasMessage === hasInput)
      throw new CliError(
        'INVALID_ARGUMENT',
        '请指定 --message 或 --input，二者不能同时使用；' + ADVANCED_DESIGNER_PROMPT,
      );
    const parsed = inputSchema.safeParse(
      hasInput ? await readInput(String(options.input)) : { content: options.message },
    );
    if (!parsed.success || (parsed.data.content !== undefined && parsed.data.message !== undefined))
      throw new CliError(
        'INVALID_ARGUMENT',
        'JSON 只接受 content 或 message 文本字段，不能同时提供；附件请使用 --file',
      );
    let directive = (parsed.data.content ?? parsed.data.message ?? '').trim();
    // 明确命令承担选择设计师的语义；已有前缀只保留一次，正文不扩写。
    while (designerPrefix.test(directive)) directive = directive.replace(designerPrefix, '').trim();
    if (
      !directive ||
      /^(?:高级设计师|高級設計師|Senior designer|シニアデザイナー|시니어 디자이너)$/i.test(directive)
    )
      throw new CliError('INVALID_ARGUMENT', ADVANCED_DESIGNER_PROMPT);

    const service = await runtime(context, command);
    const previous = await service.load(sessionId);
    const previousMessage = roundMessage(previous, currentRound(previous));
    if (
      previous.extra.agentRuntime === 'shire' ||
      !enabled(previousMessage?.roundExtra?.hasSelectedStyle) ||
      !enabled(previousMessage?.roundExtra?.startDevelopment)
    )
      throw new CliError('INVALID_ARGUMENT', '请先完成风格选择并进入研发，再使用此高级设计师调整页面', {
        sessionId,
      });
    const current = await service.inspect(previous);
    if (
      !hasCompletedCreationResult(current) ||
      current.interactions.some((item) => item.kind !== 'SELECT_FEATURES') ||
      (await service.taskProgress.hasPendingSubagentWork(sessionId))
    )
      throw new CliError('INVALID_ARGUMENT', '请先处理当前任务或问题，再委托高级设计师', {
        sessionId,
        observedState: service.withGuidance(current),
      });

    const files = z.array(z.string()).parse(options.file ?? []);
    const prepared = await prepareUploadFiles(service, files);
    const attachments: InputAttachment[] = [];
    for (const file of prepared) attachments.push(await uploadAttachment(service, file));
    const content = `@高级设计师 ${directive}`;
    const response = object(
      await businessWrite(context, service, sessionId, () =>
        service.command.chat({
          sessionId,
          previewVersionId: 0,
          content,
          businessParams: { business_type: 'advanced_designer_polish' },
          ...(attachments.length ? { attachments } : {}),
        }),
      ),
    );
    context.output.write(
      await service.accepted({ ...response, progressTitle: content }, sessionId, options.wait !== false, {
        ...waitOptions(command),
        previousMessageId: previousMessage?.messageId,
      }),
    );
  });
}

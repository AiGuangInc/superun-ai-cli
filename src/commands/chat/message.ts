/** 创建与续写共用的消息输入、附件上传和发送流程。@author xiuyu.yi */
import type { Command } from 'commander';
import { z } from 'zod';
import { object, text } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import { uploadAttachment } from '../../api/upload-api.js';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, businessWrite } from '../shared.js';

const inputSchema = z
  .object({
    content: z.string().optional(),
    message: z.string().optional(),
    attachments: z
      .array(
        z
          .object({
            name: z.string(),
            mediaType: z.string().optional(),
            content: z.string().optional(),
            url: z.string().url().optional(),
            meta: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const appendValue = (value: string, previous: Array<string>): Array<string> => [...previous, value];
export function messageOptions(command: Command): Command {
  return withWait(
    command
      .option('--message <text>', '需求文本')
      .option('--input <file>', 'JSON 输入文件，- 表示标准输入')
      .option('--file <path>', '附加本地文件，可重复使用', appendValue, []),
  );
}
export async function sendMessage(
  context: CommandContext,
  sessionId: string | undefined,
  command: Command,
): Promise<void> {
  const options = object(command.opts());
  const hasMessage = typeof options.message === 'string',
    hasInput = typeof options.input === 'string';
  if (hasMessage === hasInput) throw new CliError('INVALID_ARGUMENT', '必须且只能指定 --message 或 --input');
  const raw =
    typeof options.input === 'string' ? await readInput(options.input) : { content: options.message };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.content !== undefined && parsed.data.message !== undefined))
    throw new CliError('INVALID_ARGUMENT', '输入只接受 content/message 与 attachments，且内容字段不能重复');
  const input = parsed.data,
    content = input.content ?? input.message ?? '';
  const files = z.array(z.string()).parse(options.file);
  if (!content.trim() && !files.length && !input.attachments.length)
    throw new CliError('INVALID_ARGUMENT', '需求或附件不能为空');
  const service = await runtime(context, command);
  const attachments = [...input.attachments];
  for (const file of files) attachments.push(await uploadAttachment(service, file));
  const create = sessionId ? undefined : await service.config.creation(content);
  const response = await businessWrite(context, service, sessionId, () =>
    service.command.chat({
      sessionId,
      content,
      attachments,
      model: text(options.model),
      workspaceId: text(options.workspaceId),
      ...(create
        ? {
            sessionExtra: {
              agentRuntime: create.runtime,
              hasSlidesIntent: create.slides ? '1' : '0',
              hasClarifiedPrd: '0',
              generatedByBranch: '1',
              version: '6',
            },
            roundExtra: {
              ROUND_LANGUAGE: create.language,
              ...(create.runtime === 'shire' ? { stage0Intro: 'true' } : {}),
            },
          }
        : {}),
    }),
  );
  context.output.write(
    await service.accepted(object(response), sessionId, options.wait !== false, waitOptions(command)),
  );
}

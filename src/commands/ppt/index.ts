/** PPT 生成、现有任务查询和双锚点交付校验。@author xiuyu.yi */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { PptApi, requirePlayablePpt } from '../../api/ppt-api.js';
import type { CommandContext } from '../shared.js';
import { runtime } from '../shared.js';
import { CliError } from '../../output/exit-codes.js';
import { pptHead, pptPreflight, slidesIntent } from '../../conversation/ppt-preflight.js';

function singleId(value: string): string {
  if (!value || /[\s,\/\\?#]/.test(value))
    throw new InvalidArgumentError('请传入本次明确的单个标识，不能是链接或多个目标');
  return value;
}
async function readContext(context: CommandContext, command: Command, sessionId: string) {
  const service = await runtime(context, command);
  const view = await service.load(sessionId);
  if (view.session.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', 'PPT 查询返回了不同作品');
  return {
    service,
    api: new PptApi(service.client),
    output: {
      sessionId,
      hasSlidesIntent: slidesIntent(view.extra.hasSlidesIntent),
      sessionStatus: view.session.status,
      currentSourceMessageId: pptHead(view)?.messageId ?? null,
    },
  };
}

export function registerPpt(program: Command, context: CommandContext): void {
  const ppt = program.command('ppt').description('生成并核验项目级网页幻灯片，不导出原生PPTX');
  ppt
    .command('generate')
    .argument('<sessionId>', '本次明确的单个PPT作品ID', singleId)
    .description('检查PPT前置并生成或复用任务，不自动重试写请求')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const first = await pptPreflight(service, sessionId);
      const api = new PptApi(service.client);
      const existing = await api.query(sessionId);
      const observedId = existing.deck?.generationId;
      if (existing.status === 'generating') {
        if (!observedId)
          throw new CliError('PROTOCOL_ERROR', '已有PPT任务生成中但缺少generationId，不能重复提交');
        context.output.write({
          state: 'ACCEPTED',
          sessionId,
          hasSlidesIntent: true,
          sourceMessageId: first.sourceMessageId,
          generationId: observedId,
          status: 'generating',
          reused: true,
          deliveryVerified: false,
        });
        return;
      }
      if (existing.status === 'ready') {
        const fresh = await api.ensure(sessionId, first.sourceMessageId, true);
        if (
          fresh.status === 'ready' &&
          fresh.changed === false &&
          fresh.mode === 'unchanged' &&
          fresh.generationId !== observedId
        )
          throw new CliError('STALE_INTERACTION', 'PPT新鲜度探测期间任务已被替换，请重新查询当前任务');
        if (
          (fresh.status === 'ready' &&
            fresh.changed === false &&
            fresh.mode === 'unchanged' &&
            fresh.generationId === observedId) ||
          fresh.status === 'generating'
        ) {
          context.output.write({
            state: 'ACCEPTED',
            sessionId,
            hasSlidesIntent: true,
            sourceMessageId: first.sourceMessageId,
            ...fresh,
            reused: true,
            deliveryVerified: false,
          });
          return;
        }
        if (fresh.changed !== true)
          throw new CliError('PROTOCOL_ERROR', '未取得明确的PPT新鲜度结论，不能继续生成');
      } else if (!['none', 'stale', 'failed'].includes(existing.status)) {
        throw new CliError('PROTOCOL_ERROR', 'PPT任务状态未知，不能继续提交');
      }
      await pptPreflight(service, sessionId, first.sourceMessageId);
      const ack = await api.ensure(sessionId, first.sourceMessageId, false);
      context.output.write({
        state: ack.status === 'failed' ? 'FAILED' : 'ACCEPTED',
        sessionId,
        hasSlidesIntent: true,
        sourceMessageId: first.sourceMessageId,
        ...ack,
        reused: ack.mode === 'unchanged' || ack.generationId === observedId,
        deliveryVerified: false,
      });
    });

  ppt
    .command('status')
    .argument('<sessionId>', '本次明确的单个作品ID', singleId)
    .description('只读发现现有PPT任务或核对指定generationId')
    .option('--generation-id <id>', '本次生成回执ID；不传时仅观察既有状态', singleId)
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const { generationId } = command.opts<{ generationId?: string }>();
      const current = await readContext(context, command, sessionId);
      const status = await current.api.status(sessionId);
      context.output.write({
        state: 'COMPLETED',
        operation: 'READ_ONLY',
        ...current.output,
        ...status,
        expectedGenerationId: generationId ?? null,
        matchesExpectedGeneration: generationId ? status.generationId === generationId : null,
        deliveryVerified: false,
      });
    });

  ppt
    .command('get')
    .argument('<sessionId>', '本次明确的单个作品ID', singleId)
    .description('读取既有deck；同时提供生成ID和主线锚点才核验本次交付')
    .option('--generation-id <id>', '本次生成回执ID', singleId)
    .option('--source-message-id <id>', 'generate返回的主线来源锚点', singleId)
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const { generationId, sourceMessageId } = command.opts<{
        generationId?: string;
        sourceMessageId?: string;
      }>();
      if (sourceMessageId && !generationId)
        throw new CliError('INVALID_ARGUMENT', '--source-message-id必须同时配合--generation-id');
      const current = await readContext(context, command, sessionId);
      let result = await current.api.query(sessionId);
      let verified = false;
      if (generationId && sourceMessageId) {
        await pptPreflight(current.service, sessionId, sourceMessageId);
        requirePlayablePpt(result, generationId);
        const fresh = await current.api.ensure(sessionId, sourceMessageId, true);
        if (
          fresh.generationId !== generationId ||
          fresh.status !== 'ready' ||
          fresh.changed !== false ||
          fresh.mode !== 'unchanged'
        )
          throw new CliError(
            'STALE_INTERACTION',
            'PPT附件已变化或新鲜度结果与本次任务不一致，不能确认交付；不会自动重新生成',
            { sessionId, generationId, sourceMessageId },
          );
        result = await current.api.query(sessionId);
        requirePlayablePpt(result, generationId);
        await pptPreflight(current.service, sessionId, sourceMessageId);
        verified = true;
      }
      context.output.write({
        state: 'COMPLETED',
        operation: verified ? 'VERIFIED_DELIVERY' : 'READ_ONLY',
        ...current.output,
        status: result.status,
        generationId: result.deck?.generationId ?? null,
        expectedGenerationId: generationId ?? null,
        sourceMessageId: sourceMessageId ?? null,
        matchesExpectedGeneration: generationId ? result.deck?.generationId === generationId : null,
        deliveryVerified: verified,
        slideCount: result.deck?.slides?.length ?? 0,
        deck: result.deck ?? null,
      });
    });
}

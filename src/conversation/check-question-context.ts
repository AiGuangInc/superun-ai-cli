/** 恢复审查或测试确认卡前被展示管线省略的用户可见说明。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import type { CreationResult, Interaction } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import { parseWire } from '../contracts/node-wire.js';
import { text } from '../contracts/value.js';
import { visibleText } from './text-projector.js';
import { CliError } from '../output/exit-codes.js';

const snapshotSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  parsedContents: z.array(z.string()),
});

export async function readCheckQuestionContext(
  client: ApiClient,
  view: SessionView,
  interactions: Array<Interaction>,
): Promise<CreationResult['messages']> {
  const messages = new Map<string, CreationResult['messages'][number]>();
  const snapshots = new Map<string, Array<Record<string, unknown>>>();
  for (const interaction of interactions) {
    if (interaction.kind !== 'ASK_USER_TOOL' || interaction.source.variant === 'managed_agent_wizard')
      continue;
    const { messageId, contentId } = interaction.source;
    let contents = snapshots.get(messageId);
    if (!contents) {
      const snapshot = parseWire(
        snapshotSchema,
        await client.call('/api/uxa-center/agent/AgentQuery/fetchMessageSnapshot', {
          sessionId: view.session.sessionId,
          messageId,
          previewVersionId: 0,
          preferParsedContent: true,
          preferHumanizedContent: true,
          slimUserInputContent: true,
        }),
      );
      if (snapshot.sessionId !== view.session.sessionId || snapshot.messageId !== messageId)
        throw new CliError('PROTOCOL_ERROR', '确认问题的说明来源不一致，请重新查询');
      contents = snapshot.parsedContents.map((value) => parseWire(z.record(z.unknown()), JSON.parse(value)));
      snapshots.set(messageId, contents);
    }
    const questionIndex = contents.findIndex((item) => item.contentId === contentId);
    if (questionIndex < 0) throw new CliError('STALE_INTERACTION', '当前确认问题已变化，请重新查询');
    // 只取这个提问工具所属生成块的可见正文，不读取工具输出或模型推理。
    const narrative = contents
      .slice(0, questionIndex)
      .reverse()
      .find((item) => item.type === 'model_generation_item');
    if (!narrative) continue;
    const narrativeId = text(narrative.contentId),
      content = visibleText(narrative);
    if (!narrativeId || !content.trim()) continue;
    const rendered = view.pipeline.render?.rounds.some((round) =>
      round.agentItems.some(
        (item) =>
          item.kind === 'bubble' &&
          item.source?.messageId === messageId &&
          item.source?.contentId === narrativeId,
      ),
    );
    if (rendered) continue;
    const id = `${messageId}:${narrativeId}`;
    messages.set(id, { id, role: 'assistant', text: content });
  }
  return [...messages.values()];
}

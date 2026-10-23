/** 项目级网页幻灯片协议，生成与新鲜度探测严格区分读写。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const PREFIX = '/api/uxa-center/agent/SlideDeck';
const optionalText = z.string().nullish();
const locatorSchema = z.object({
  superunId: optionalText,
  selector: optionalText,
  xpath: optionalText,
  textHint: optionalText,
  tagName: optionalText,
});
const slideSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  order: z.number().int().nonnegative().safe(),
  routePath: optionalText,
  displayMode: z.string(),
  locator: locatorSchema.nullish(),
});
const deckSchema = z.object({
  deckId: optionalText,
  routePath: z.literal('__project__'),
  viewport: optionalText,
  status: z.string().min(1),
  generationId: optionalText,
  type: optionalText,
  playback: z.object({ kind: z.string() }).nullish(),
  updatedAt: z.number().int().safe().nullish(),
  slides: z.array(slideSchema).nullish(),
});
const querySchema = z.object({
  routePath: z.literal('__project__'),
  status: z.string().min(1),
  deck: deckSchema.nullish(),
});
const statusSchema = z.object({
  routePath: z.literal('__project__'),
  status: z.string().min(1),
  deckId: optionalText,
  generationId: optionalText,
  updatedAt: z.number().int().safe().nullish(),
});
const ackSchema = z.object({
  generationId: z.string().min(1),
  status: z.string().min(1),
  mode: optionalText,
  changed: z.boolean().nullish(),
});
export type PptDeckQuery = z.infer<typeof querySchema>;

export function requirePlayablePpt(result: PptDeckQuery, generationId: string) {
  const deck = result.deck;
  if (
    result.status !== 'ready' ||
    !deck ||
    deck.status !== 'ready' ||
    deck.generationId !== generationId ||
    !deck.deckId ||
    deck.viewport !== 'desktop' ||
    deck.type !== 'ppt' ||
    !deck.slides?.length ||
    !['web-node-present', 'ppt-node-present', 'ppt-native-controls'].includes(deck.playback?.kind ?? '')
  )
    throw new CliError('STALE_INTERACTION', '尚未取得本次 generationId 对应的可播放 PPT，请继续查询原任务', {
      generationId,
      observedGenerationId: deck?.generationId ?? null,
      status: result.status,
    });
  const ids = new Set<string>();
  for (const [index, slide] of deck.slides.entries()) {
    const locator = slide.locator;
    if (
      ids.has(slide.id) ||
      slide.order !== index ||
      slide.displayMode !== 'present' ||
      !locator ||
      !Object.values(locator).some((value) => typeof value === 'string' && value.trim())
    )
      throw new CliError('PROTOCOL_ERROR', 'PPT 幻灯片顺序或定位信息不完整，不能确认可播放');
    ids.add(slide.id);
  }
  return deck;
}

export class PptApi {
  constructor(private readonly client: ApiClient) {}
  async query(sessionId: string) {
    return parseWire(querySchema, await this.client.call(`${PREFIX}/querySlideDeck`, { sessionId }));
  }
  async status(sessionId: string) {
    return parseWire(statusSchema, await this.client.call(`${PREFIX}/querySlideDeckStatus`, { sessionId }));
  }
  async ensure(sessionId: string, sourceMessageId: string, checkOnly: boolean) {
    const raw = await this.client.call(
      `${PREFIX}/triggerSlideDeckGeneration`,
      {
        sessionId,
        messageId: sourceMessageId,
        type: 'ppt',
        ...(checkOnly ? { checkOnly: true } : {}),
      },
      !checkOnly,
    );
    try {
      const ack = parseWire(ackSchema, raw);
      if (!checkOnly && !['ready', 'generating', 'failed'].includes(ack.status))
        throw new CliError('PROTOCOL_ERROR', 'PPT生成写请求返回了未知状态');
      return ack;
    } catch (error) {
      if (!checkOnly)
        throw new CliError(
          'OUTCOME_UNKNOWN',
          'PPT 生成请求已发出，但未取得完整回执；请先查询原作品，勿重复生成',
          { sessionId, sourceMessageId, retryable: false },
        );
      throw error;
    }
  }
}

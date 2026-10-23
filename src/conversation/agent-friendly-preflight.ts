/** AI应用接入的公开环境、主线来源与生成门禁。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import type { SessionView, NodeRound } from '../contracts/node-wire.js';
import { parseWire } from '../contracts/node-wire.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import {
  projectCheckPreflight,
  projectEditingState,
  projectMainlineHead,
} from './project-check-preflight.js';
import { roundContainingMessage } from './round-selector.js';
import { AGENT_FRIENDLY_SKILL_ID, LEGACY_AGENT_FRIENDLY_SKILL_ID } from '../api/agent-friendly-api.js';

export async function agentFriendlyAccess(service: CreationRuntime, view: SessionView, sessionId: string) {
  if (view.session.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '接入查询返回了不同作品');
  await projectEditingState(service, sessionId);
}
export async function agentFriendlyPublication(service: CreationRuntime, view: SessionView) {
  const sessionId = view.session.sessionId;
  if (view.session.publicStatus !== 0 && view.session.publicStatus !== 1)
    throw new CliError('PROTOCOL_ERROR', '站点公开状态未知，无法确认接入前置');
  if (view.session.publicStatus !== 1)
    return {
      ready: false as const,
      reason: '当前站点未公开，请先按本次意图完成上线，再准备AI应用接入；不会自动发布。',
    };
  const value = parseWire(
    z.object({
      publishedVersions: z.array(z.object({ deployStatus: z.number().int() })),
      unPublishedVersion: z.object({ deployStatus: z.number().int() }).nullish(),
      publishUrl: z.string().nullish(),
      supabaseUrl: z.string().nullish(),
    }),
    await service.publish.status(sessionId),
  );
  if (!value.publishedVersions.some((item) => item.deployStatus === 1))
    return { ready: false as const, reason: '尚未确认该项目存在成功部署的正式版本，请先完成发布前置。' };
  let valid = false;
  try {
    const url = new URL(value.publishUrl ?? '');
    valid =
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/^(?:id--|snapshot--)/.test(url.hostname);
  } catch {}
  if (!valid)
    return { ready: false as const, reason: '正式访问地址尚未核验，不能用预览或猜测地址准备正式接入。' };
  return {
    ready: true as const,
    publishUrl: value.publishUrl!,
    supabaseUrl: value.supabaseUrl ?? undefined,
    publishing: value.unPublishedVersion?.deployStatus === 2,
  };
}
function officialRound(round: NodeRound) {
  return round.userItems.some((item) =>
    [AGENT_FRIENDLY_SKILL_ID, LEGACY_AGENT_FRIENDLY_SKILL_ID].includes(
      text(object(item.payload.skillDisplay).skillId) ?? '',
    ),
  );
}
export function agentFriendlyAnchor(view: SessionView, messageId: string): 'CURRENT' | 'MISSING' {
  const source = roundContainingMessage(view, messageId);
  if (!source) return 'MISSING';
  const head = projectMainlineHead(view),
    current = head ? roundContainingMessage(view, head.messageId) : undefined;
  if (
    source.sessionId !== view.session.sessionId ||
    !officialRound(source) ||
    !current ||
    current.roundId !== source.roundId
  )
    throw new CliError(
      'STALE_INTERACTION',
      '指定生成来源不属于当前作品主线接入任务，或已被后续操作替换；未返回任意旧指南',
      { sessionId: view.session.sessionId, messageId },
    );
  return 'CURRENT';
}
export async function agentFriendlyWritePreflight(
  service: CreationRuntime,
  sessionId: string,
  expectedSource?: string,
) {
  const view = await service.load(sessionId),
    gate = await projectCheckPreflight(service, view, sessionId, '准备AI应用接入');
  if (gate.stage !== 'development')
    throw new CliError('INVALID_ARGUMENT', '当前仍是演示阶段，接入工具尚未开放；不会自动进入研发', {
      sessionId,
    });
  if (gate.hasStaging)
    throw new CliError('INVALID_ARGUMENT', '当前有未合并源码暂存，请先处理后再准备接入；不会自动合并', {
      sessionId,
    });
  if (expectedSource && gate.sourceMessageId !== expectedSource)
    throw new CliError('STALE_INTERACTION', '接入生成提交前主线已变化，请重新确认', { sessionId });
  const publication = await agentFriendlyPublication(service, view);
  if (!publication.ready) throw new CliError('INVALID_ARGUMENT', publication.reason, { sessionId });
  if (publication.publishing)
    throw new CliError('INVALID_ARGUMENT', '当前正式部署仍在进行，先跟踪其结果再生成接入能力', { sessionId });
  return { view, gate, publication };
}

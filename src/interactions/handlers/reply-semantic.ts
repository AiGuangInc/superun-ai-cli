/** Stage0、架构确认、功能选择与执行动作的请求构造。@author xiuyu.yi */
import { list, object, text, enabled } from '../../contracts/value.js';
import type { JsonObject } from '../../contracts/value.js';
import { visibleText } from '../../conversation/text-projector.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';

export const replySemantic: ReplyHandler = async ({ runtime, binding, input }) => {
  const sessionId = binding.round.sessionId,
    kind = binding.interaction.kind;
  if (kind === 'ENTER_IDEATION')
    return runtime.command.chat({
      sessionId,
      content: '[superun:handoff]',
      businessParams: { business_type: 'stage0_handoff_generate' },
    });
  if (kind === 'APPROVE_ARCHITECTURE_PLAN')
    return runtime.command.chat({
      sessionId,
      content: '确认研发规划',
      businessParams: { business_type: 'architecture_plan_approve' },
    });
  const selected = list(input.featureIds);
  if (selected.length && new Set(selected.map(String)).size !== selected.length)
    throw new CliError('INVALID_ARGUMENT', 'featureIds 不能重复');
  if (kind === 'SELECT_FEATURES') {
    const features = list(binding.interaction.details?.features).map(object);
    if (
      !selected.length ||
      selected.some((id) => !features.some((feature) => String(feature.id) === String(id)))
    )
      throw new CliError('INVALID_ARGUMENT', '请选择当前列表中的功能 ID');
    const chosen = features
      .filter((feature) => selected.some((id) => String(feature.id) === String(id)))
      .map<JsonObject>((feature) => ({ ...feature, checked: true }));
    const saved = features.map((feature) =>
      chosen.some((item) => item.id === feature.id) ? { ...feature, checked: true } : feature,
    );
    const source = binding.interaction.source;
    const name = `internal/fl__${source.messageId}.json`;
    await runtime.command.saveAttachment(sessionId, name, saved, binding.round.anchorUserMessageId);
    await runtime.command.messageExtra(sessionId, source.messageId, {
      ...object(binding.message?.extra),
      featureListMessageAttachment: name,
      featureListConfirmed: '1',
    });
    const response = await runtime.command.chat({
      sessionId,
      content: `开始实现以下功能：\n${chosen.map((feature) => feature.title).join('\n')}`,
      businessParams: { business_type: 'feature_manage', features: chosen },
    });
    const fullFeatures = binding.view.features ?? features;
    await runtime.command.saveAttachment(
      sessionId,
      'internal/features.json',
      fullFeatures.map((feature) =>
        chosen.some((item) => String(item.id) === String(feature.id))
          ? { ...feature, checked: true }
          : feature,
      ),
      binding.round.anchorUserMessageId,
    );
    return response;
  }
  const message = binding.message;
  if (!message) throw new CliError('UNSUPPORTED_INTERACTION', '执行动作缺少源消息');
  if (
    Number(message.mode ?? object(message.extra).mode) === 6 &&
    !enabled(message.roundExtra?.startDevelopment)
  ) {
    const content = binding.round.agentItems
      .filter((item) => item.kind === 'bubble')
      .map((item) => visibleText(item.payload))
      .join('\n')
      .replace(/<superun-action\s+type=["']start-executing["']\s*\/?>/g, '')
      .trim();
    if (!content) throw new CliError('UNSUPPORTED_INTERACTION', '当前执行动作缺少可转发的内容');
    return runtime.command.chat({
      sessionId,
      content: '立即执行',
      businessParams: {
        business_type: 'casual_chat',
        forwarded_consultation: true,
        consultation_message_count: 1,
        consultation_messages: [{ role: 'system', text: content }],
      },
    });
  }
  const planBatch = text(message.roundExtra?.plan_batch_id) ?? message.replyMessageId;
  if (!planBatch) throw new CliError('UNSUPPORTED_INTERACTION', '执行动作缺少计划来源锚点');
  if (selected.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0))
    throw new CliError('INVALID_ARGUMENT', '规划功能 ID 必须为正整数');
  return runtime.command.chat({
    sessionId,
    content: '立即执行',
    businessParams: {
      business_type: 'plan_execution',
      plan_batch_id: planBatch,
      ...(text(message.consultId ?? message.meta?.consultId)
        ? { consultId: message.consultId ?? message.meta?.consultId }
        : {}),
      ...(selected.length ? { selected_feature_ids: selected } : {}),
    },
  });
};

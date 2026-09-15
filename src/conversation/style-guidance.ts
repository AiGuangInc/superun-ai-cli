/** 风格生成结果与用户已确认的后置引导。@author xiuyu.yi */
import type { GuidanceResult } from './next-actions.js';
import type { NextAction } from '../contracts/cli-output.js';
import { readyStyleChoices, styleChoiceLabel } from '../interactions/parsers/style-selection.js';
import { APPEND_STYLE_NOTICE, APPEND_STYLE_OPTION, existingStyleLinks } from './style-generation.js';

export function styleResultNotice(result: GuidanceResult): string | undefined {
  if (!result.styleGeneration || !result.cursor?.branchAnchor || result.stylePlanning) return undefined;
  const choices = result.choices ?? [];
  const batch = choices.filter((choice) => result.styleGeneration!.choiceIds.includes(choice.choiceId));
  const ready = readyStyleChoices(choices).sort((a, b) => a.index - b.index);
  const failed = choices.filter((choice) => choice.status === 'failed');
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state)) {
    const notice =
      result.styleGeneration.notice ??
      (result.styleGeneration.phase === 'append'
        ? batch.length && batch.every((choice) => choice.tokenFree === true)
          ? '高级设计师已接受委托，正在根据你的需求定制一版新方案；本次为免费委托，不扣算力值，这可能需要一些时间。'
          : APPEND_STYLE_NOTICE
        : result.styleGeneration.phase === 'retry'
          ? '正在重新生成失败的方案。'
          : '需求已确认，正在为你免费生成第一个方案。');
    return [notice, result.styleGeneration.notice ? '' : existingStyleLinks(ready)]
      .filter(Boolean)
      .join('\n\n');
  }
  if (choices.some((choice) => choice.selected)) return undefined;
  const lines = batch.map((choice) =>
    choice.status === 'failed'
      ? `${styleChoiceLabel(choice)} 生成失败：${choice.errorType ?? '服务端任务执行失败，请查看详情'}。`
      : choice.status === 'success' && choice.previewUrl
        ? `**${styleChoiceLabel(choice)} 已生成**：[查看${styleChoiceLabel(choice)}](${choice.previewUrl})`
        : '方案状态待同步。',
  );
  if (!ready.length && failed.length) lines.push('需求答案已保存。处理失败原因后，回复 **“重试生成”**。');
  if (ready.length > 1)
    lines.push(
      '你可以对比现有方案：',
      ...ready.map(
        (choice) =>
          `- **${styleChoiceLabel(choice)}**：[查看${styleChoiceLabel(choice)}](${choice.previewUrl})`,
      ),
    );
  else if (ready.length && !batch.some((choice) => choice.choiceId === ready[0]!.choiceId))
    lines.push(existingStyleLinks(ready));
  const actions = [
    ...ready.map(
      (choice) =>
        `- **采用 ${styleChoiceLabel(choice).replace('方案 ', '')}**：根据这个方案整理开发功能清单。`,
    ),
    ...failed.map(
      (choice) => `- **重试 ${styleChoiceLabel(choice).replace('方案 ', '')}**：重新尝试生成失败的方案。`,
    ),
    ...(ready.length && !failed.length ? [`- ${APPEND_STYLE_OPTION}`] : []),
  ];
  return [...lines, ...(actions.length ? ['下一步你可以：', ...actions] : [])].join('\n\n');
}

export function styleNextActions(
  result: GuidanceResult,
  command: Array<string>,
): Array<NextAction> | undefined {
  const anchor = result.cursor?.branchAnchor;
  if (!anchor || !result.styleGeneration || result.stylePlanning) return undefined;
  const choices = result.choices ?? [];
  if (choices.some((choice) => choice.selected)) return [];
  const prefix =
    '原样展示 styleGeneration.notice 中的实际结果和链接，不展示截图或内部字段，同一结果不重复提示。';
  const actions: Array<NextAction> = [];
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state)) {
    actions.push({
      action: 'QUERY_STYLES',
      requiresUserInput: false,
      instruction: `${prefix} 继续查询本轮状态，不重复生成；用户已主动选择就绪方案时可采用该方案，否则继续等待。`,
      command: [...command, 'style', 'list', '--anchor', anchor, '--', result.sessionId],
    });
    // 追加时可以先选择之前已完成的方案，但不自动选中。
  }
  for (const choice of readyStyleChoices(choices))
    actions.push({
      action: 'SELECT_STYLE',
      choiceId: choice.choiceId,
      requiresUserInput: true,
      instruction: `${prefix} 用户回复“采用 ${styleChoiceLabel(choice).replace('方案 ', '')}”后执行。提示“已采用${styleChoiceLabel(choice)}，正在整理开发功能清单。”静默衔接演示和规划，清单出来后展示真实内容并等待用户选择功能。`,
      command: [...command, 'style', 'select', '--', result.sessionId, choice.choiceId],
    });
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state)) return actions;
  for (const choice of choices.filter((choice) => choice.status === 'failed' && choice.messageId))
    actions.push({
      action: 'RETRY_STYLE',
      choiceId: choice.choiceId,
      requiresUserInput: true,
      instruction: `${prefix} 用户回复“重试 ${styleChoiceLabel(choice).replace('方案 ', '')}”后执行原任务重试。只有一个失败方案时“重试生成”对应它；多个失败方案时让用户指定编号。余额、权限等问题先处理，不无限自动重试。`,
      command: [...command, 'style', 'retry', '--', result.sessionId, choice.choiceId],
    });
  if (readyStyleChoices(choices).length && !choices.some((choice) => choice.status === 'failed'))
    actions.push({
      action: 'APPEND_STYLE',
      requiresUserInput: true,
      instruction: `${prefix} 用户选择“再设计一版”后直接执行，不重复确认费用；若用户此前没看到费用说明，先展示该选项并等待确认。直接基于本轮已有需求生成，每次只追加一个方案，不引导填写调整要求或上传参考文件。`,
      command: [...command, 'style', 'append', '--anchor', anchor, '--', result.sessionId],
    });
  return actions;
}

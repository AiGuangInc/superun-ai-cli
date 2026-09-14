/** 自动测试的来源识别和结果展示契约。@author xiuyu.yi */
import type { CreationResult } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import { currentRound } from './round-selector.js';
import { projectText } from './text-projector.js';
import { text } from '../contracts/value.js';

export const AUTO_TEST_OPERATION_KEY = 'cliAutoTestOperation';
export const AUTO_TEST_SOURCE_KEY = 'cliAutoTestSource';
export const AUTO_TEST_DEFAULT_MESSAGE = '帮我测一下刚才完成的功能。';

export function autoTestContext(view: SessionView, anchorMessageId?: string): CreationResult['autoTest'] {
  const round = anchorMessageId
    ? view.pipeline.render?.rounds.find((item) => item.anchorUserMessageId === anchorMessageId)
    : currentRound(view);
  if (!round) return undefined;
  const ids = new Set([round.anchorUserMessageId, ...round.agentItems.map((item) => item.source?.messageId)]);
  const messages = view.pipeline.messages
    .filter((message) => ids.has(message.messageId))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const message of messages) {
    const extra = message.roundExtra ?? {};
    const phase = extra[AUTO_TEST_OPERATION_KEY];
    if (phase === 'none') return undefined;
    if (phase === 'test' || phase === 'repair' || extra.business_type === 'auto_test')
      return {
        phase: phase === 'repair' ? 'repair' : 'test',
        sourceMessageId: round.anchorUserMessageId,
        reportMessages: projectText([round]).messages.filter((item) => item.role === 'assistant'),
        previousSourceMessageId: text(extra[AUTO_TEST_SOURCE_KEY]),
      };
  }
  return undefined;
}

export const AUTO_TEST_RESULT_INSTRUCTION = `依据 autoTest.reportMessages 中本次最新报告展示结果，messages 可补充本次过程和上下文。autoTest.previousReportMessages 仅用于追溯上一份报告的问题与编号，不能把旧结论当成本次结果。报告未返回完整清单时说明缺失，不补造计数。不得从 taskProgress 完成、工具成功或没有错误推断测试通过。
没有发现问题且测试有效完成：说明实际测试范围和结论。
发现问题：统一展示“本次自动测试发现 N 个问题，已修复 M 个，未修复 K 个”，下面按编号逐项列出问题、具体修复内容或未修复原因。后续修复沿用源报告的问题编号，不重新编号；数字、原因和复测结论必须有报告依据，未知就明确说明，不补零、不将疑似问题计为确认缺陷。修复结果同样列出具体修复的功能。保留报告中的实际未覆盖范围、截图及报告链接，不编造链接。
只展示 nextActions 中 when 条件满足的动作，不能把所有候选命令直接列成用户菜单。后置引导按以下规则选择：
1. 测试有效完成、无问题，或问题全部修复且复测通过：先说明实际验证状态，再说“接下来，你可以继续完善项目，或上线运营。”，展示“继续创作 / 上线运营”。
2. 全部修复、尚未复测：说“以上问题已全部修复，尚未复测。接下来，你可以验证修复结果、继续完善项目，或上线运营。”，展示“自动测试 / 继续创作 / 上线运营”。不得把已修复说成复测通过。
3. 仍有未修复问题（包括一个都没修复）：只说“还有 K 个问题未修复。回复‘修复剩余问题’或‘修复第 X 项’继续处理，也可以直接告诉我修改要求。”，不展示“继续创作 / 上线运营”。
4. 需要确认业务规则或补充信息：只提出报告中具体待回答的问题，等待用户；疑似问题先核实，测试环境问题不算产品缺陷。
5. 测试异常、没有有效结论：说明实际原因，只引导解决阻碍或在可重试时回复“重试自动测试”。
6. 本次承诺的测试范围只完成一部分：列出已测和未测范围，只引导用户指定剩余流程继续测试；范围之外的功能只说明未覆盖，不据此阻止正常完成引导。
结论不清楚时保留原始结果并说明缺少什么信息，不猜测已经全部修复，不展示上线入口。运行中只展示实际范围、发现的问题和正在修复的进度，不展示操作菜单。`;

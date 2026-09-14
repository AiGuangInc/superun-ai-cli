/** 代码审查的来源识别与完整前后置引导。@author xiuyu.yi */
import type { CreationResult } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import { readCheckContext } from './check-context.js';

export const CODE_REVIEW_OPERATION_KEY = 'cliCodeReviewOperation';
export const CODE_REVIEW_SOURCE_KEY = 'cliCodeReviewSource';
export const CODE_REVIEW_DEFAULT_MESSAGE = '请审查刚才改动的代码，排查潜在缺陷与隐患，并修复发现的问题';
export const CODE_REVIEW_SPEC = {
  phase: 'review' as const,
  operationKey: CODE_REVIEW_OPERATION_KEY,
  sourceKey: CODE_REVIEW_SOURCE_KEY,
  businessType: 'issue_review',
};

export function codeReviewContext(view: SessionView, anchorMessageId?: string): CreationResult['codeReview'] {
  return readCheckContext(view, CODE_REVIEW_SPEC, anchorMessageId);
}

export const CODE_REVIEW_RESULT_INSTRUCTION = `依据 codeReview.reportMessages 中本次最新报告展示代码审查或后续修复结果。messages 可补充本次过程；previousReportMessages 只用于追溯问题和编号，不能代替当前结论。不得从任务完成、工具成功或无错误推断审查通过，报告不完整就说明缺少什么。
运行中：说明实际审查范围和关注点；发现问题时逐项告知，再说明正在修复。及时展示 conversation_message，不要求用户再次回复修复，不展示后置菜单。后台审查结束后还要等主会话处理、修复和最终汇报，不能把“已启动审查”当作完成。
没有发现问题且审查有效完成：展示“本次已审查……相关代码，未发现问题。”。不能仅凭 GATE: PASS 忽略报告中列出的 P1/P2 问题，也不能把审查结论当作修复完成证明。
发现问题后统一展示“本次代码审查发现 N 个问题，已修复 M 个，未修复 K 个”，下面按编号逐项列出问题、具体修复内容或未修复原因。全部修复、部分修复、一个都没修复使用同一模板。后续修复保留源报告的顺序和编号；数量、原因、文件位置及验证结论必须有实际报告依据，不补零、不编造原因、不把疑似问题计为确认缺陷。保留报告中必要的文件位置、链接和未覆盖范围。
只展示 nextActions 中 when 条件满足的动作，不能把全部候选动作列成菜单。报告附带的网页旧入口替换成以下后置引导，不增加“暂不需要”步骤：
1. 审查有效完成且没有问题：说“接下来，你可以实际验证相关功能、继续完善项目，或上线运营。”，直接展示三个选项：\n- **自动测试**：回复“自动测试”，验证本次审查涉及的功能。\n- **继续创作**：直接告诉我想新增或调整的内容。\n- **上线运营**：回复“上线运营”。
2. 问题已全部修复：在修复详情后说“以上问题已全部修复。接下来，你可以验证修复效果、继续完善项目，或上线运营。”，直接展示同样三个选项，自动测试说明改为“验证刚才修复的功能”。实际验证情况有依据再说明，不固定写尚未测试，不把已修复说成复审通过。Glow 不会在本次流程修复后自动重复审查同一范围，不自行循环复审。
3. 仍有未修复问题（含一个都没修复）：只说“回复‘修复剩余问题’或‘修复第 X 项’继续处理，也可以直接告诉我修改要求。”，不展示自动测试、继续创作、上线运营。修复与用户明确意图冲突时先提出具体业务问题，不能擅自决定。
4. 需要确认规则或补充资料：先说明具体待确认项及未处理原因，只提出实际问题，等待用户回答；有结构化交互则使用对应交互，不以普通消息绕过。
5. 审查异常、暂停、中断或没有有效结论：说明 codeReview.error 或报告中的真实原因，只引导解决阻碍；可以重试时提示回复“重试代码审查”。不能报告没有问题，不能展示正常完成菜单。
6. 本次确定的审查范围只完成一部分：列出已审与未审范围及原因，只引导“继续审查……”。范围之外的功能只说明未覆盖，不据此阻止正常完成引导。
用户回复修复要求后，通过当前会话继续处理指定问题，不重新发起代码审查。修复完成再次使用同一模板：全部处理完直接给三个选项，仍有问题就继续处理，需要决定就提问。用户明确要求“审查完再自动测试”时，在报告有效完成且无遗留问题后按已经授权的顺序衔接，不再重复确认；否则等待用户选择，不自动测试或发布。`;

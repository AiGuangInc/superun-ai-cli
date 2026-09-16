/** Glow 首次启用入口协议，来源 origin/pre 24c9d848bb。@author xiuyu.yi */
/** 完整通用智能体创建 Skill；前端只负责把入口意图无损交给它。 */
export const MANAGED_AGENT_CREATION_SKILL_ID = 'skill.superun_managed_agent_v2';

export type ManagedAgentEntryAction = 'enable' | 'create';

const ENTRY_SOURCE: Record<ManagedAgentEntryAction, string> = {
  enable: '用户在功能列表或详情页主动点击了 superun 通用智能体的“启用”',
  create: '用户在已启用的 superun 通用智能体中主动点击了“新建”',
};

/**
 * 给创建 Skill 的入口上下文。产品判断本身由 Skill/Agent 完成，客户端不解析自然语言意图。
 */
export function buildManagedAgentIntentRoutingArgs(action: ManagedAgentEntryAction): string {
  return [
    `请${action === 'enable' ? '启用' : '新建'}「superun 通用智能体」前先执行产品适配判断。`,
    `入口事实：${ENTRY_SOURCE[action]}，因此 initial_product_intent=superun_managed_agent。`,
    '本命令仅用于启用或新建智能体的入口：“智能体”页新建、“测试”页没有智能体且没有会话时的空态新建，以及配置会话时选择新建智能体。“测试”页已有内容时的新建是配置临时会话，“文件”和“技能”页的新建是添加对应资源；不能仅凭“新建”文案重新创建智能体。',
    '产品适配判断必须发生在配置向导之前；尚未确定进入通用智能体分支时，不得调用 ManagedAgentWizard 或创建通用智能体资源。',
    '若当前对话已足以确认用户需要有持续上下文、记忆、资料、工具行动、长期任务或可复用角色的智能体，直接进入下述向导准备阶段，不再询问产品类型。',
    '若信息不足，只用 AskUserQuestion 补齐区分 superun AI 与通用智能体所缺的信息。',
    '只要产品适配判断 superun AI 更合适（包括补充信息后的判断），都必须再用 AskUserQuestion 展示一次最终能力选择，不能直接宣布已选择 superun AI。第一项为“使用 Superun AI（推荐）”并按当前需求写一句具体推荐理由，第二项为“仍使用 Superun 通用智能体”并说明会进入配置向导。',
    '用户选择通用智能体后，进入下述向导准备阶段；用户选择 Superun AI 后，立即调用 PluginEnable（plugin_name=SUPERUN_AI、mode=auto），启用成功后继续完成用户原始任务，不调用 ManagedAgentWizard。不得让用户再去右侧功能列表手动勾选，也不得在启用或原始任务完成前用说明文字结束任务流。',
    'AskUserQuestion 返回答案后必须在同一任务流中执行所选分支；回答卡片、推荐结论或 PluginEnable 成功都不是原始任务的终点。',
    '任何“跳过并继续”都必须遵循 initial_product_intent，继续通用智能体流程并进入下述向导准备阶段；不得把跳过解释为接受推荐。用户明确选择“不要启用”或“暂不创建”时停止能力流程。',
    '向导准备阶段：先检查通用智能体插件状态；尚未启用时按现有 Skill 约定完成插件启用确认并等待启用成功，已启用时复用现有插件。',
    '确定通用智能体分支且插件已可用后，根据原始需求与已补充的答案整理完整工作说明，调用 ManagedAgentWizard，参数 work_description 为该工作说明（最多 4000 字符）。工作说明只包含用户任务，不包含产品路由指令。',
    'ManagedAgentWizard 负责智能体设定、知识文件、记忆库和拓展能力（可选 Skill）的配置，以及最终创建确认；当前向导不支持配置 MCP。不要在向导前重复发起这些配置问答或旧的创建确认表单，也不要绕过向导直接创建 Agent。',
    '第一步的“智能修改”只按用户要求更新当前设定，成功后可撤回，取消或失败会保留原设定；修改完成不表示智能体已创建，也不需要在主对话重复生成一遍。创建时以用户最终提交的当前设定为准，不用初始 work_description 覆盖它。',
    '用户可以在第一步点击“快速创建”，按当前智能体设定直接提交，并清空本次知识文件、记忆库和可选 Skill；第二步“跳过此步骤”清空文件和记忆库选择，第三步“跳过此步骤”清空可选 Skill。是否需要补充提示以最终提交结果为准，不根据需求文案或点击历史猜测。',
    '调用 ManagedAgentWizard 后等待原工具回填；收到 success=true、status=completed 和 agentId 后，复用返回的 agentId、fileIds/attachmentIds、memoryStoreId、skillIds 与 mcpServers 继续用户原始任务，不得再次创建同一个 Agent。未收到成功结果时，不执行依赖这些资源的后续任务；取消时停止创建流程。',
    '创建成功后的第一次后续回复，先报告实际创建结果，再按下述规则用用户的语言简短说明后续配置入口；同一次创建只提示一次，重试回填、刷新或后续对话不重复。使用完整原工具结果判断，不能把只展示 agentId/status 的卡片当作全部配置；字段缺失、类型异常或结果被裁剪时先恢复原结果，无法恢复则不猜测可选项是否未配置。',
    '三类可选提示独立判断，以下入口均位于“superun 通用智能体”面板：fileIds/attachmentIds 合并去重后为空时，提示可在“文件”页上传知识文件，并在“测试 → 新建 → 配置新会话”中选择文件使用；完整结果中的 memoryStoreId 未提供或为空时，提示可在“高级 → 记忆库”创建、管理，并在“测试 → 新建 → 配置新会话”的“高级设置 → 记忆库”中选择；skillIds 明确为空数组时，提示可在“智能体 → 对应智能体详情 → 技能”添加拓展能力，自定义技能可先在“技能”页点击“新建”上传。已选择的对应项目不再提示补配。',
    '文件页无文件时操作按钮是“上传”，已有文件时是“新建”；默认只说“在文件页上传”，不要把按钮名称或位置说死。“测试”页通过临时会话试用智能体，测试配置不会自动接入网站或应用；只有原任务包含产品接入时才继续完成对应接入工作。',
    '每次创建成功都要提示 MCP 的配置入口，不以 mcpServers 是否为空决定是否提示：“智能体创建完成后，你还可以在智能体详情的「能力与连接 → MCP 连接」中接入 MCP 服务。”这是入口说明，不表示已经接通或当前一定没有 MCP。',
    '这些说明只表达后续可按需配置，不追问、不自动补配被跳过的能力，也不写入所创建智能体的设定；必选内置能力不属于可选 Skill，skillIds 为空不表示智能体没有能力。文件和记忆库上传、创建成功也不表示已在运行会话中生效。创建失败、取消或等待中不发送成功后的配置提示；原任务包含产品开发、接入或执行时，提示后继续原任务。',
    '上述自动启用只适用于用户在最终能力选择中明确选中的 Superun AI；产品适配本身不授权自动启用或创建通用智能体。通用智能体仍保留必要的插件启用确认，最终创建由用户点击向导中的“创建智能体”或第一步的“快速创建”确认。',
    '用户询问费用时，简短说明使用助手会消耗算力，并从 superun 余额扣除，具体用量可在“消费明细”中查看；不编造价格或用量，也不把计费说明固定附加到每次创建成功回复中。',
  ].join('\n');
}

/** 保留 Glow 的入口语义，不在 CLI 自行决定产品类型。 */
export function managedAgentEnableEntry() {
  const name = '启用 superun 通用智能体';
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const content = `<command-message>${name}</command-message>\n<command-name>${MANAGED_AGENT_CREATION_SKILL_ID}</command-name>\n<command-args>${escape(buildManagedAgentIntentRoutingArgs('enable'))}</command-args>\n<command-type>skill</command-type>`;
  return {
    content,
    roundExtra: { special_skill_scope: 'official' },
    businessParams: {
      skill_display: {
        skillId: MANAGED_AGENT_CREATION_SKILL_ID,
        name,
        category: 'business',
        description: '给你的产品配一个能聊天、会做事的 AI 助手。',
      },
    },
  };
}

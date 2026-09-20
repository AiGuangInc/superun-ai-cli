/** Agent 友好的独立结果与引导，不改变普通会话的状态判断。@author xiuyu.yi */
import type { CreationResult, NextAction } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import type { CreationRuntime } from '../runtime.js';
import {
  AGENT_FRIENDLY_SKILL_ID,
  LEGACY_AGENT_FRIENDLY_SKILL_ID,
  AgentFriendlyApi,
} from '../api/agent-friendly-api.js';
import { currentRound, roundMessage } from './round-selector.js';
import { resolveState } from './state-resolver.js';
import { collectInteractions } from '../interactions/registry.js';
import { object, text } from '../contracts/value.js';
import { COMMAND_NAME } from '../config/constants.js';
import { agentFriendlyPrompt, type AgentFriendlyMethod } from './agent-friendly-prompts.js';

export type AgentFriendlyResult = CreationResult & {
  agentFriendly: {
    stage: 'GENERATING' | 'NOT_READY' | 'READY' | 'INSTRUCTIONS';
    method?: AgentFriendlyMethod;
    prompt?: string;
    methods?: Array<{ value: AgentFriendlyMethod; label: string; description: string }>;
  };
};

export function isAgentFriendlyRound(view: SessionView): boolean {
  return !!currentRound(view)?.userItems.some((item) =>
    [AGENT_FRIENDLY_SKILL_ID, LEGACY_AGENT_FRIENDLY_SKILL_ID].includes(
      text(object(item.payload.skillDisplay).skillId) ?? '',
    ),
  );
}

export function agentFriendlyGuidance(
  service: CreationRuntime,
  result: AgentFriendlyResult,
): AgentFriendlyResult {
  const command = [
    COMMAND_NAME,
    '--endpoint',
    service.client.config.endpoint,
    '--locale',
    service.client.config.locale,
    'chat',
    'agent-friendly',
  ];
  const { stage, method } = result.agentFriendly;
  let actions: NextAction[];
  if (result.interactions.length) {
    // 沿用真实服务端提问和回复命令；回答后回到只读接入查询，不再发生成消息。
    actions = service.withGuidance(result).nextActions.map((action) => ({
      ...action,
      instruction: `${action.instruction} 当前仍在准备 Agent 友好接入能力。回答并处理当前问题后，执行 ${[...command, '--status', '--', result.sessionId].join(' ')} 继续本次流程，不重新生成。`,
    }));
  } else if (stage === 'READY') {
    actions = (result.agentFriendly.methods ?? []).map((option) => ({
      action: option.value === 'skill' ? 'SELECT_AGENT_FRIENDLY_SKILL' : 'SELECT_AGENT_FRIENDLY_CONNECTOR',
      requiresUserInput: true,
      instruction:
        '只询问一次“你希望通过哪种方式接入？”，展示 messages 中的两个选项及说明，支持原生选择题的宿主也可使用 agentFriendly.methods。等待用户选择，选择后执行对应命令。不要自动选择，不安装，不生成文件，不创建新会话。',
      command: [...command, '--method', option.value, '--', result.sessionId],
    }));
  } else if (stage === 'INSTRUCTIONS' && method) {
    const display =
      '先展示 messages：在一个文本代码块中完整展示所选方式的接入原文，不摘要、不截断、不把命令中的 URL 改成 Markdown 链接、不生成文件。展示指令不等于执行安装，指令准备完成不等于已接入。随后原样展示以下引导，不改写标题、选项和说明：\n接下来，你可以直接回复我：\n\n- **接入当前会话**：我在当前会话中完成配置和查询验证。\n- **接入到新会话**：我新开一个会话，将完整指令交给它执行。\n- **接入其他 AI 应用**：复制上述完整指令，到目标应用中发送。';
    const read = [...command, '--method', method, '--', result.sessionId];
    actions = [
      {
        action: 'CONNECT_CURRENT_APP',
        requiresUserInput: true,
        command: read,
        instruction: `${display} 用户明确选择“接入当前会话”后，由当前宿主 Agent 执行 messages 代码块中的完整指令（与 agentFriendly.prompt 相同），无需用户再复制发送；先检查宿主能力，浏览器登录由用户完成，拿到真实只读查询结果才可宣布成功。不要将安装指令发回 Superun 项目 chat。command 仅重新读取指令，不执行安装。`,
      },
      {
        action: 'CONNECT_NEW_CONVERSATION',
        requiresUserInput: true,
        command: read,
        instruction: `${display} 用户明确选择“接入到新会话”且宿主提供真实的新会话工具时，才把 messages 代码块中的所选完整指令交给新会话；不传当前研发历史或 PAT。没有该工具就说明不支持，让用户选择当前会话继续或自行复制。不能用 Superun 新建项目冒充宿主新会话。command 仅重新读取指令。`,
      },
      {
        action: 'CONNECT_OTHER_AI_APP',
        requiresUserInput: true,
        command: read,
        instruction: `${display} 用户选择“接入其他 AI 应用”后，提示复制当前完整指令，到目标应用发送；不自动在本机执行或创建会话。command 仅重新读取指令。`,
      },
    ];
  } else {
    actions = [
      {
        action: stage === 'GENERATING' ? 'WAIT_AGENT_FRIENDLY' : 'QUERY_AGENT_FRIENDLY',
        requiresUserInput: stage !== 'GENERATING',
        instruction:
          stage === 'GENERATING'
            ? '展示当前任务的实际进度，继续等待生成及后台任务收尾；不要重复发送生成消息，不提前询问接入方式或输出两套指令。'
            : '如实展示当前未就绪的原因；此命令只查询状态，不重复生成，不声称已经开启或接入。',
        command: [
          ...command,
          '--status',
          ...(result.messageId ? ['--message-id', result.messageId] : []),
          '--',
          result.sessionId,
        ],
      },
    ];
  }
  return { ...result, nextActions: actions };
}

export function agentFriendlyNotReady(sessionId: string, notice: string): AgentFriendlyResult {
  return {
    state: 'NEEDS_INPUT',
    sessionId,
    messages: [{ id: `${sessionId}:agent-friendly:notice`, role: 'assistant', text: notice }],
    interactions: [],
    progress: [],
    agentFriendly: { stage: 'NOT_READY' },
  };
}

export async function readyAgentFriendly(
  service: CreationRuntime,
  api: AgentFriendlyApi,
  view: SessionView,
  method?: AgentFriendlyMethod,
): Promise<AgentFriendlyResult> {
  const sessionId = view.session.sessionId;
  const connection = await api.connection(sessionId, text(view.session.sessionKey) ?? '');
  const base = { sessionId, topic: view.session.topic, interactions: [], progress: [] };
  if (!method)
    return agentFriendlyGuidance(service, {
      ...base,
      state: 'NEEDS_SELECTION',
      messages: [
        {
          id: `${sessionId}:agent-friendly:select`,
          role: 'assistant',
          text: '项目接入能力已准备好，你希望通过哪种方式接入？\n\n- **通过技能接入**：适合支持安装 Skill 的 AI 应用。\n- **通过连接器接入**：适合支持本地 MCP 的 AI 应用。',
        },
      ],
      agentFriendly: {
        stage: 'READY',
        methods: [
          { value: 'skill', label: '通过技能接入', description: '适合支持安装 Skill 的 AI 应用。' },
          { value: 'connector', label: '通过连接器接入', description: '适合支持本地 MCP 的 AI 应用。' },
        ],
      },
    });
  const prompt = agentFriendlyPrompt(method, connection);
  return agentFriendlyGuidance(service, {
    ...base,
    state: 'COMPLETED',
    messages: [
      {
        id: `${sessionId}:agent-friendly:${method}`,
        role: 'assistant',
        text: `复制下面整段内容，发送到你要接入的 AI 应用。\n\n\`\`\`text\n${prompt}\n\`\`\``,
      },
    ],
    agentFriendly: { stage: 'INSTRUCTIONS', method, prompt },
  });
}

/** 只包装新命令的等待结果，普通 chat state/wait 保持原有行为。 */
export async function projectAgentFriendlyGeneration(
  service: CreationRuntime,
  api: AgentFriendlyApi,
  view: SessionView,
): Promise<AgentFriendlyResult> {
  const activeSubagentWork = await service.taskProgress.hasPendingSubagentWork(view.session.sessionId);
  // 主会话和子任务都已结束且技能已开启时，直接交付；末尾回执无需再回溯审查/测试来源。
  if (view.session.status === 3 && !activeSubagentWork && (await api.enabled(view.session.sessionId)))
    return readyAgentFriendly(service, api, view);
  const round = currentRound(view);
  const businessType = roundMessage(view, round)?.roundExtra?.business_type;
  const isReceipt =
    round?.meta?.subAgentReport ||
    ['sub_agent_report', 'background_task_report'].includes(String(businessType));
  let result: CreationResult;
  if (isReceipt) {
    // 本入口已确定是能力生成，回执只参与生命周期和真实提问，不触发审查/测试来源回溯。
    const current = { ...view, activeSubagentWork };
    result = resolveState(current, collectInteractions(current));
    result.taskProgress = await service.taskProgress.read(current, [], result.interactions);
  } else result = await service.inspect(view);
  const featureSelection =
    result.state === 'NEEDS_INPUT' &&
    result.interactions.length > 0 &&
    result.interactions.every((item) => item.kind === 'SELECT_FEATURES') &&
    result.taskProgress?.activeCount === 0;
  if (result.state === 'COMPLETED' || featureSelection) {
    if (await api.enabled(view.session.sessionId)) return readyAgentFriendly(service, api, view);
    return agentFriendlyGuidance(
      service,
      agentFriendlyNotReady(
        view.session.sessionId,
        '本轮执行已结束，但尚未确认 Agent 友好技能已开启，请查询状态或查看本轮执行结果。',
      ),
    );
  }
  return agentFriendlyGuidance(service, {
    ...result,
    messages:
      result.interactions.length || !['RUNNING', 'QUEUED'].includes(result.state) ? result.messages : [],
    agentFriendly: {
      stage: ['RUNNING', 'QUEUED', 'NEEDS_INPUT'].includes(result.state) ? 'GENERATING' : 'NOT_READY',
    },
  });
}

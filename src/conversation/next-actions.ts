/** 根据当前结果提供操作引导，不替用户作答或执行操作。@author xiuyu.yi */
import { styleNextActions } from './style-guidance.js';
import { COMMAND_NAME } from '../config/constants.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { CreationResult, InteractionKind, NextAction } from '../contracts/cli-output.js';
import { AUTO_TEST_RESULT_INSTRUCTION } from './auto-test.js';
import { CODE_REVIEW_RESULT_INSTRUCTION } from './code-review.js';
import { routingInstruction } from './project-routing.js';

export type GuidanceResult = Pick<CreationResult, 'state' | 'sessionId'> &
  Partial<
    Pick<
      CreationResult,
      | 'interactions'
      | 'choices'
      | 'messageId'
      | 'cursor'
      | 'demo'
      | 'development'
      | 'stylePlanning'
      | 'styleGeneration'
      | 'taskProgress'
      | 'toolUsage'
      | 'autoTest'
      | 'codeReview'
      | 'replyMessageId'
    >
  >;

/** 只静默确认风格选择后这一轮规划；实际业务问题仍交给用户。 */
export function pendingStylePlanApproval(result: GuidanceResult) {
  const interaction = result.interactions?.[0];
  return result.stylePlanning &&
    result.state === 'NEEDS_INPUT' &&
    result.interactions?.length === 1 &&
    interaction?.kind === 'APPROVE_ARCHITECTURE_PLAN' &&
    interaction.actions.includes('APPROVE')
    ? interaction
    : undefined;
}

/** 研发结束后选择后续功能仍是本轮完成结果，不能退回过程卡或漏掉工具统计。 */
export function hasCompletedCreationResult(result: GuidanceResult): boolean {
  return (
    result.state === 'COMPLETED' ||
    (result.state === 'NEEDS_INPUT' &&
      result.development?.stage === 'FEATURE_SELECTION' &&
      (result.interactions ?? []).every((item) => item.kind === 'SELECT_FEATURES') &&
      !!result.development.previewUrl)
  );
}

const QUESTIONNAIRE_INSTRUCTION =
  '先展示 messages 中本轮需要阅读的说明，再完整展示当前 questions 的问题、选项标签和说明，保留单选/多选与自定义回答能力。可按宿主工具容量分批收答；本次问题答齐后按原 question.id 和 options.index 一次提交 answers，不代选、不追加提交确认。提交后读取新结果，有新交互 ID 就继续提问，不能把一页回答当作整个任务完成。';

const PLAN_REVIEW_INSTRUCTION =
  '请按 messages 顺序展示原始规划对话，与产品页面保持一致，不自行摘要、改写或追加 attachments 中的完整研发规划。然后展示：\n- **确认规划**：回复 **“确认规划”** 继续。\n- **调整功能**：直接告诉我需要增加或修改的内容。\n每次调整后都要等待并展示更新方案，再次给出这两个入口；如果服务端再次提问，先回答问题再等待方案。补充要求不等于确认，不能确认旧方案。';

const FEATURE_SELECTION_INSTRUCTION =
  '请按 messages 顺序展示原始对话和功能清单，保留展示编号与 details.features 中真实 id 的对应关系；无需额外生成或链接功能清单文档，也不追加勾选状态提示。此时功能尚待选择开发，不展示“继续创作”或“上线运营”入口。最后只提示：“请回复要开发的功能编号或具体需求。”';

const INTERACTION_INSTRUCTIONS: Record<InteractionKind, string> = {
  MANAGED_AGENT_WIZARD: QUESTIONNAIRE_INSTRUCTION,
  UNSUPPORTED: '当前 CLI 无法处理该交互，请到 superun 网页完成后再查询，不自动跳过。',
  PRD_CLARIFICATION: `${QUESTIONNAIRE_INSTRUCTION}；整组答齐提交后直接生成风格并默认等待风格预览页面供用户选择，不再额外询问是否生成`,
  ASK_USER_TOOL: `${QUESTIONNAIRE_INSTRUCTION}；提交后等待实际返回的问题或方案，不自动确认规划`,
  ASK_USER_MESSAGE: `${QUESTIONNAIRE_INSTRUCTION}；提交后等待实际返回的问题或方案，不自动确认规划`,
  SECRET_INPUT: '请用户安全提供当前要求的密钥，不要回显密钥内容',
  PLUGIN_SECRET_INPUT:
    '先展示 details 中的权限清单和安全设置提示，再通过安全输入收集插件所需配置；不要在普通聊天中索取或回显密钥，不替用户完成外部授权。',
  PLUGIN_ACTION:
    '展示当前插件的说明、权限清单和安全设置提示；引导用户处理必要的外部授权，再按当前允许的动作确认或跳过。无需密钥的托管模式不索取密钥，可选密钥不作为必填项；不得声称已经替用户完成外部授权。',
  DDL_CONFIRMATION: '请用户阅读并确认数据库变更',
  STYLE_SELECTION: '请用户打开风格预览页面并选择候选，只展示页面链接',
  ENTER_IDEATION: '请用户确认进入构想阶段',
  APPROVE_ARCHITECTURE_PLAN: `${PLAN_REVIEW_INSTRUCTION} 只有用户明确确认当前规划时才执行 APPROVE；包含新增或修改要求时先按调整功能处理，不自动确认`,
  SELECT_FEATURES: `${FEATURE_SELECTION_INSTRUCTION} 只有用户明确从清单中选择时才将对应真实 id 填入 featureIds。支持明确多选或全选，不默认勾选，不用展示序号代替真实 id；用户直接提出新需求时应继续对话，不强制选择推荐功能`,
  START_EXECUTION: '请用户确认开始执行当前计划',
};

export function buildNextActions(
  result: GuidanceResult,
  config: Pick<RuntimeConfig, 'endpoint' | 'locale'>,
): Array<NextAction> {
  const completed = hasCompletedCreationResult(result);
  return nextActionsForState(result, config).map((action) => {
    const silentPlanning =
      result.stylePlanning && (!result.interactions?.length || pendingStylePlanApproval(result));
    const progressInstruction = silentPlanning
      ? '只展示一次“已采用所选方案，正在整理开发功能清单”（使用实际方案编号），随后静默等待结果；不展示 taskProgress 进度卡、内部步骤或中间演示和规划正文。每 5 分钟的任务提醒照常展示。'
      : result.codeReview
        ? CODE_REVIEW_RESULT_INSTRUCTION
        : result.autoTest
          ? AUTO_TEST_RESULT_INSTRUCTION
          : completed
            ? '整轮已结束，按 messages 顺序原样展示本轮完成说明，保留服务端返回的内容、预览链接和后续引导。不改写为步骤表或结束卡片，不以 taskProgress.markdown 替代原始回复。'
            : result.taskProgress
              ? '每次查询都展示 taskProgress.markdown 进度卡，即使 changed 为 false 也展示。按 Glow 开发中列表展示当前返回的功能和步骤，不从历史消息补回已完成的功能或旧步骤；等待中的功能只展示标题与状态。不追加执行详情或工具次数。界面支持原位更新时按 taskProgress.id 更新同一张卡，否则每次展示当前快照。保留状态待同步提示，不虚构阶段或百分比。'
              : '';
    const waitInstruction = action.requiresUserInput
      ? result.codeReview
        ? '后续动作需要用户明确授权；若用户已明确要求审查后接着测试，满足当前结果条件后沿用该授权，无需重复确认。否则等待用户选择，不自动修复未确认的业务规则或发布。'
        : '等待用户明确响应，不设置答题倒计时；未收到响应时保持当前步骤，不自动选择、提交、跳过或继续。'
      : '';
    return {
      ...action,
      instruction: [
        'command、input 和动作标识供接入 Agent 内部执行，不是用户菜单，不逐项向用户解释或要求用户执行 Shell。只展示面向用户的状态、结果和需要回答的选项；用户主动询问命令或技术细节时再解释。已授权的内部衔接步骤静默执行，不增加确认；实际业务问题、错误和充值引导必须展示。',
        progressInstruction,
        action.instruction,
        waitInstruction,
        ...(completed && result.toolUsage
          ? [
              '只在原始完成说明之后补充 toolUsage.markdown，继续保留原有预览链接及后续操作引导；不展示读取、修改或部署次数。',
            ]
          : []),
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
}

function nextActionsForState(
  result: GuidanceResult,
  config: Pick<RuntimeConfig, 'endpoint' | 'locale'>,
): Array<NextAction> {
  // 显式保留连接地址，避免调用方执行下一步时切回默认环境；凭据不进入命令。
  const command = [COMMAND_NAME, '--endpoint', config.endpoint, '--locale', config.locale, 'chat'];
  const styleActions = styleNextActions(result, command);
  if (styleActions) return styleActions;
  const progressRevision = result.taskProgress?.revision ?? result.cursor?.progressRevision;
  const progressOptions = progressRevision ? ['--progress-revision', progressRevision] : [];
  if ((result.autoTest || result.codeReview) && !result.interactions?.length) {
    if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state))
      return [
        {
          action: 'WAIT',
          instruction: result.codeReview
            ? '代码审查或后续修复仍在进行。及时展示 conversation_message 中的实际范围、发现的问题与正在修复的说明。后台审查结束后继续等待主会话修复和最终汇报，不重复触发审查，不展示后置菜单。'
            : '自动测试或后续修复仍在进行。及时展示新的 conversation_message 事件及实际测试、发现问题、修复进度。继续等待最终汇报；不重复触发、不自动开始下一次测试、不展示操作菜单。',
          requiresUserInput: false,
          command: [
            ...command,
            'wait',
            ...progressOptions,
            ...(result.messageId ? ['--message-id', result.messageId] : []),
            '--',
            result.sessionId,
          ],
        },
      ];
    return result.codeReview ? codeReviewActions(result, command) : autoTestActions(result, command);
  }
  if (
    result.stylePlanning &&
    (['ACCEPTED', 'RUNNING', 'QUEUED', 'COMPLETED'].includes(result.state) ||
      pendingStylePlanApproval(result))
  )
    return [
      {
        action: 'CONTINUE_STYLE_PLANNING',
        instruction:
          '用户已选定风格，提示“已采用方案 B，正在整理开发功能清单”，方案名称使用实际选择。继续执行返回的 chat wait，CLI 会内部按 Glow 的接口和参数完成查看演示、保留演示版本、进入研发、生成并确认规划，直到返回开发功能清单；这些步骤全部静默，不展示演示或规划正文，不询问查看演示、开始研发、确认规划或调整功能。网页已完成的步骤直接衔接，不重复提交。不要声称用户已实际查看演示或亲自确认规划。遇到实际业务问题或错误时如实展示并等待处理；功能清单出来后原样展示，提示“请回复要开发的功能编号或具体需求”，等待用户选择，不自动选择或开发功能。',
        requiresUserInput: false,
        command: [...command, 'wait', ...progressOptions, '--', result.sessionId],
      },
    ];
  if (result.state === 'NEEDS_INPUT' || result.state === 'NEEDS_SELECTION') {
    const interactions = result.interactions ?? [];
    if (interactions.length) {
      const nextActions = interactions.flatMap((interaction) =>
        !interaction.actions.length
          ? [
              {
                action: 'QUERY_STATE',
                instruction: String(interaction.details?.notice ?? '请查询服务端当前状态，不重复提交。'),
                requiresUserInput: true,
                interactionId: interaction.interactionId,
                command: [...command, 'state', '--', result.sessionId],
              },
            ]
          : interaction.actions.map((action): NextAction => {
              if (action === 'SKIP' && interaction.kind !== 'MANAGED_AGENT_WIZARD') {
                return {
                  action,
                  instruction: ['PRD_CLARIFICATION', 'ASK_USER_TOOL', 'ASK_USER_MESSAGE'].includes(
                    interaction.kind,
                  )
                    ? '仅在用户明确要求跳过当前整组问题后执行此命令，不是跳过单题。'
                    : '仅在用户明确要求跳过当前交互后执行此命令。',
                  requiresUserInput: true,
                  interactionId: interaction.interactionId,
                  command: [
                    ...command,
                    'interaction',
                    'skip',
                    '--',
                    result.sessionId,
                    interaction.interactionId,
                  ],
                };
              }
              const instruction =
                interaction.source.variant === 'managed_agent_wizard'
                  ? action === 'SUBMIT'
                    ? String(interaction.details?.instruction ?? QUESTIONNAIRE_INSTRUCTION)
                    : `仅在用户主动要求此操作时执行 ${action}；这是可选导航，不新增题目，不追加单选或二次确认。`
                  : interaction.kind === 'PLUGIN_ACTION'
                    ? [
                        INTERACTION_INSTRUCTIONS[interaction.kind],
                        interaction.details?.notice,
                        interaction.details?.instruction,
                      ]
                        .filter(Boolean)
                        .join(' ')
                    : INTERACTION_INSTRUCTIONS[interaction.kind];
              return {
                action,
                instruction: `${instruction}。使用此 interactionId 对应的 questions、details 和 answerSchema，补齐 input 后通过 --input - 提交 JSON；不要替用户填写或选择。`,
                requiresUserInput: true,
                interactionId: interaction.interactionId,
                command: [
                  ...command,
                  'interaction',
                  'reply',
                  '--input',
                  '-',
                  '--',
                  result.sessionId,
                  interaction.interactionId,
                ],
                input: { action, ...(interaction.page ? { pageRevision: interaction.page.revision } : {}) },
              };
            }),
      );
      if (
        result.development?.stage === 'PLAN_REVIEW' &&
        interactions.every((interaction) => interaction.kind === 'APPROVE_ARCHITECTURE_PLAN')
      )
        nextActions.push({
          action: 'CONTINUE_CHAT',
          instruction: `${PLAN_REVIEW_INSTRUCTION} 用户直接提出调整要求时，将原始要求放入 content，通过 --input - 提交 JSON；不要把修改内容塞进 APPROVE。若只说调整功能，则先询问具体要求；提交后等待更新方案或问题，不自动进入研发。`,
          requiresUserInput: true,
          command: [...command, 'send', '--input', '-', '--', result.sessionId],
        });
      if (
        result.state === 'NEEDS_INPUT' &&
        result.development?.planApproved &&
        result.development.stage === 'FEATURE_SELECTION' &&
        interactions.every((interaction) => interaction.kind === 'SELECT_FEATURES')
      ) {
        // 已有本轮研发结果时保留完成后的引导；首次功能清单只引导选择开发内容。
        if (result.development.previewUrl) return developmentActions(result, command);
        nextActions.push({
          action: 'CONTINUE_CHAT',
          instruction: `${FEATURE_SELECTION_INSTRUCTION} 用户直接给出开发需求时，将用户原文不经改写或扩充地放入 content，通过 --input - 提交 JSON；用户明确选择清单条目时使用 SELECT 和对应的真实 featureIds，不把确认规划当作全选。`,
          requiresUserInput: true,
          command: [...command, 'send', '--input', '-', '--', result.sessionId],
        });
      }
      return nextActions;
    }
  }
  if (result.state === 'COMPLETED' && (result.demo || result.development?.stage === 'READY')) {
    if (result.demo?.viewed || result.development?.stage === 'READY') {
      const previewInstruction = result.demo
        ? '请先以可点击链接展示 demo.url，链接文字为“查看「项目名称」网站演示”（项目名称使用当前项目名称），使用当前返回的地址，不使用旧演示地址。'
        : '请如实说明本轮演示链接暂未就绪，可稍后查询；不使用旧演示地址代替。';
      const instruction = `${previewInstruction} 再原样展示以下引导：\n- **修改演示**：直接告诉我修改要求，比如“把主题换成绿色”。\n- **进入研发**：回复 **“开始研发”**，我会先生成研发规划供你确认。\n等待用户响应；查看记录不代表用户已满意，不额外增加确认步骤。`;
      return [
        {
          action: 'CONTINUE_CHAT',
          instruction: `${instruction} 用户直接给出修改要求时，将用户原文不经改写或扩充地放入 content 字段，通过 --input - 提交 JSON，无需先让用户回复“修改演示”；如果用户只选择修改演示而未说明要求，再询问具体修改内容。不自动追加需求或进入研发。`,
          requiresUserInput: true,
          command: [...command, 'send', '--input', '-', '--', result.sessionId],
        },
        {
          action: 'ENTER_DEVELOPMENT',
          instruction: `${instruction} 仅在用户回复“开始研发”或明确选择进入研发后执行此命令，保留演示并等待研发规划或业务提问；不自动确认规划或选择功能。`,
          requiresUserInput: true,
          command: [...command, 'develop', '--', result.sessionId],
        },
      ];
    }
    const selectedStyle = result.choices?.find((choice) => choice.selected);
    const demoReadyText = selectedStyle
      ? `已采用方案 ${selectedStyle.index + 1}，简易演示生成完毕。`
      : '简易演示生成完毕。';
    return [
      {
        action: 'VIEW_DEMO',
        instruction: `请按以下顺序展示：先告知用户“${demoReadyText}”；在这句话下面完整展示 messages 中“简版使用场景的演示”说明，保留全部条目及括号内说明，未返回说明时不编造；最后询问“现在要查看演示，确认一下效果吗？”此时只引导查看演示，不提前询问修改或进入研发。只有用户明确要求查看后才执行此命令；已取得 demo.url 不代表用户已经查看。`,
        requiresUserInput: true,
        command: [...command, 'demo', '--', result.sessionId],
      },
    ];
  }
  if (result.state === 'COMPLETED' && result.development?.stage === 'COMPLETED') {
    return developmentActions(result, command);
  }
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state)) {
    return [
      {
        action: 'WAIT',
        instruction: '任务尚未结束，继续等待下一步问题或结果；不要重复提交。',
        requiresUserInput: false,
        command: [
          ...command,
          'wait',
          ...progressOptions,
          ...(result.messageId ? ['--message-id', result.messageId] : []),
          '--',
          result.sessionId,
        ],
      },
    ];
  }
  return [];
}

function developmentActions(result: GuidanceResult, command: Array<string>): Array<NextAction> {
  const previewInstruction = result.development?.previewUrl
    ? `先展示本轮原始结果。${routingInstruction('preview')} 单端使用“本轮创作已完成，点击〔查看预览〕查看效果。”；多端使用“本轮创作已完成，可以分别查看以下入口：”，随后逐端列出链接，并说明“点击对应链接查看各端效果。以上为预览链接，本次改动尚未正式发布。”；只有可确认本次改动尚未发布时才使用后一状态说明，否则仅说明预览不代表发布。〔链接〕必须替换为真实可点击链接。`
    : '先按 messages 顺序展示原始对话，不把规划确认当作研发完成。';
  const multiple = result.development?.routing?.hasMultipleSides === true;
  const instruction = `${previewInstruction} 接着说明“接下来，你可以：”，然后按以下四条独立列表原样展示，不合并或改名：\n- **代码审查**：检查本轮改动。\n- **自动测试**：${multiple ? '告诉我需要验证哪个端的什么功能。' : '验证指定功能。'}\n- **继续创作**：${multiple ? '告诉我想调整哪个端、什么功能。' : '告诉我想新增或调整的内容。'}\n- **上线运营**：将本次成果发布为正式版本。`;
  return [
    {
      action: 'CODE_REVIEW',
      instruction: `${instruction} 用户明确要求“代码审查”或指定审查范围后直接执行，无需二次确认；指定内容时使用 --input - 原样提交 content，不扩大范围、不混入新增功能。仅讨论是否需要审查不触发。不默认审查或承诺免费。`,
      requiresUserInput: true,
      command: [...command, 'review', '--', result.sessionId],
    },
    {
      action: 'AUTO_TEST',
      instruction: `${instruction} 用户明确要求“自动测试”或“测一下刚才的功能”后直接执行，无需二次确认。用户指定测试范围时使用 --input - 提交原始 content，不扩大范围。不默认测试，不宣称免费。`,
      requiresUserInput: true,
      command: [...command, 'test', '--', result.sessionId],
    },
    {
      action: 'CONTINUE_CHAT',
      instruction: `${instruction} 用户直接提出需求后，将原文放入 content，通过 --input - 继续当前会话；不强制先回复继续研发或选择推荐功能。如果有 details.features，保留真实 id、标题和说明供参考；只有用户明确选择其中条目时，才使用对应 interactionId 的 SELECT 和 featureIds 提交，不默认全选。`,
      requiresUserInput: true,
      command: [...command, 'send', '--input', '-', '--', result.sessionId],
    },
    {
      action: 'REVIEW_PUBLISH',
      instruction: `${instruction} 用户回复“上线运营”即已授权发布：查询 Glow 发布面板的最新待发布版本，按后续动作原样展示该版本 changeLog 并发布，无需再次确认。版本正在发布时只等待，不重复提交；没有可发布版本时如实说明。发布完成且站点公开后再告知已上线并返回正式链接。`,
      requiresUserInput: true,
      command: [...command, 'publish', 'status', '--for-launch', '--', result.sessionId],
    },
  ];
}

function autoTestActions(result: GuidanceResult, command: Array<string>): Array<NextAction> {
  const retry: NextAction = {
    action: 'AUTO_TEST',
    when: '全部问题已修复但尚未复测；或本次范围有未测流程；或测试受阻且障碍已排除、可以重试。仅展示符合当前结果的测试或重试提示。',
    instruction:
      '全部修复但未复测时展示“- **自动测试**：回复‘自动测试’，验证刚才修复的功能。”；有未测流程时仅引导用户指定剩余流程；异常时说明原因并仅在可重试时引导“重试自动测试”。用户同意后按其实际指定的范围填写 content，通过 --input - 提交，不默认为全项目测试。缺少账号或业务信息时先提问，不重试。',
    requiresUserInput: true,
    command: [...command, 'test', '--input', '-', '--', result.sessionId],
  };
  const followup: NextAction = {
    action: 'AUTO_TEST_FOLLOW_UP',
    when: '存在未修复问题、待确认规则或需要补充的信息；或者报告结论不足，需要继续核实。',
    instruction:
      '展示问题详情和未修复原因，只引导“修复剩余问题”“修复第 X 项”或提出具体待回答问题，不展示继续创作、上线运营。用户回复后把原文放入 content，不扩充需求；按当前报告编号理解目标，通过普通对话继续修复，不重新触发 auto_test。完成后继续按同一结果模板和条件引导。',
    requiresUserInput: true,
    command: [
      ...command,
      'send',
      '--test-followup',
      result.autoTest!.sourceMessageId,
      '--input',
      '-',
      '--',
      result.sessionId,
    ],
  };
  if (result.state !== 'COMPLETED' || result.autoTest?.error) {
    return [
      { ...retry, when: '任务失败、暂停或中断，已说明原因且可以重试；没有取得有效测试结论，不能提示通过。' },
      ...(result.autoTest?.sourceMessageId ? [followup] : []),
    ];
  }
  const ready =
    '仅在本次测试有效完成、没有未修复或待确认问题、没有缺失信息或承诺范围内的未测流程时展示；全部修复但尚未复测也可展示。报告缺失或结论不明时不展示。';
  return [
    followup,
    retry,
    {
      action: 'CONTINUE_CHAT',
      when: ready,
      instruction:
        '按结果先展示过渡句，再展示“- **继续创作**：直接告诉我想新增或调整的内容。”。用户提出新需求后原样提交 content，使用普通 send 进入创作，不带 --test-followup，不沿用测试修复引导。',
      requiresUserInput: true,
      command: [...command, 'send', '--input', '-', '--', result.sessionId],
    },
    {
      action: 'REVIEW_PUBLISH',
      when: ready,
      instruction:
        '按结果先展示过渡句，再展示“- **上线运营**：回复‘上线运营’。”。仅用户明确要求上线后执行此命令，原样展示最新待发布版本的 changeLog 并按现有发布动作继续，无需二次确认；完成且站点公开后返回正式链接。',
      requiresUserInput: true,
      command: [...command, 'publish', 'status', '--for-launch', '--', result.sessionId],
    },
  ];
}

function codeReviewActions(result: GuidanceResult, command: Array<string>): Array<NextAction> {
  const followup: NextAction = {
    action: 'CODE_REVIEW_FOLLOW_UP',
    when: '存在未修复问题、待确认规则或缺失资料，需要继续处理；或者报告不足以得出有效结论。',
    instruction:
      '先展示发现、已修复、未修复数量及逐项详情与原因，再只引导“修复剩余问题”“修复第 X 项”或提出具体问题，不展示三个完成选项。用户回复后按当前报告编号理解问题，content 使用用户原文，不扩充需求；通过普通对话继续处理，不重新启动审查。修复后仍按相同模板及状态引导。',
    requiresUserInput: true,
    command: [
      ...command,
      'send',
      '--review-followup',
      result.codeReview!.sourceMessageId,
      '--input',
      '-',
      '--',
      result.sessionId,
    ],
  };
  const retry: NextAction = {
    action: 'CODE_REVIEW',
    when: '审查异常、暂停或中断，且障碍已排除、可以重试；或者本次确定的审查范围有尚未检查的部分。无效结论不能当作审查通过。',
    instruction:
      '异常时先说明实际原因，只在可重试时引导“重试代码审查”；范围只完成一部分时列出已审与未审范围，只引导“继续审查……”明确剩余目标。收到用户要求后原样提交 content。不自动重复审查已经处理完的同一范围，不展示正常完成菜单。',
    requiresUserInput: true,
    command: [...command, 'review', '--input', '-', '--', result.sessionId],
  };
  if (result.state !== 'COMPLETED' || result.codeReview?.error) return [followup, retry];
  const ready =
    '仅在本次审查有效完成且无未修复或待确认问题、无缺失资料、无本次确定范围内的未审部分时展示。包括未发现问题和发现的问题已全部修复；报告缺失、结论不明或仅后台审查结束时不展示。';
  return [
    followup,
    retry,
    {
      action: 'AUTO_TEST',
      when: ready,
      instruction:
        '展示结果、逐项修复详情与下一步过渡句后，直接展示三个选项中的“- **自动测试**：回复‘自动测试’，验证本次审查涉及的功能。”；有修复时改为“验证刚才修复的功能”。不增加暂不需要步骤。用户选择或此前明确授权审查后测试时，按原文或已授权范围填写 content 后执行，随后沿用自动测试的结果引导。',
      requiresUserInput: true,
      command: [...command, 'test', '--input', '-', '--', result.sessionId],
    },
    {
      action: 'CONTINUE_CHAT',
      when: ready,
      instruction:
        '完成结果和过渡句后直接展示“- **继续创作**：直接告诉我想新增或调整的内容。”。收到需求就原样提交 content，用普通 send 进入创作，不带 --review-followup，也不要求先回复继续创作。',
      requiresUserInput: true,
      command: [...command, 'send', '--input', '-', '--', result.sessionId],
    },
    {
      action: 'REVIEW_PUBLISH',
      when: ready,
      instruction:
        '完成结果和过渡句后直接展示“- **上线运营**：回复‘上线运营’。”。仅用户明确要求上线后执行此命令，沿用最新版本 changeLog 展示与发布流程，无需二次确认；发布完成且站点公开后返回正式链接。审查完成不代表项目已经上线。',
      requiresUserInput: true,
      command: [...command, 'publish', 'status', '--for-launch', '--', result.sessionId],
    },
  ];
}

/** 根据当前结果提供操作引导，不替用户作答或执行操作。@author xiuyu.yi */
import { COMMAND_NAME } from '../config/constants.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { CreationResult, InteractionKind, NextAction } from '../contracts/cli-output.js';
import { latestStyleChoices } from '../interactions/parsers/style-selection.js';

export type GuidanceResult = Pick<CreationResult, 'state' | 'sessionId'> &
  Partial<Pick<CreationResult, 'interactions' | 'choices' | 'messageId' | 'cursor' | 'demo' | 'development'>>;

const QUESTIONNAIRE_INSTRUCTION =
  '请一次性向用户完整展示当前交互 questions 中的全部问题和选项：保留原始问题、选项标签及说明，标明题号、选项编号、multiSelect 单选/多选规则和 allowOther 自定义回答能力；展示编号须与 question.id、options.index 对应，不要只概括问题、逐题提问或省略选项。收集整份问卷的回答；若用户仅回答部分题目，保留已答内容并一次性展示剩余问题及选项，不要替用户选择推荐项，答案齐全后再统一提交';

const INTERACTION_INSTRUCTIONS: Record<InteractionKind, string> = {
  PRD_CLARIFICATION: `${QUESTIONNAIRE_INSTRUCTION}；提交后直接生成风格并默认等待风格截图供用户选择，不再额外询问是否生成`,
  ASK_USER_TOOL: QUESTIONNAIRE_INSTRUCTION,
  ASK_USER_MESSAGE: QUESTIONNAIRE_INSTRUCTION,
  SECRET_INPUT: '请用户安全提供当前要求的密钥，不要回显密钥内容',
  PLUGIN_SECRET_INPUT: '请用户安全提供插件所需配置，不要回显密钥内容',
  PLUGIN_ACTION: '请用户确认是否启用当前插件及相关配置',
  DDL_CONFIRMATION: '请用户阅读并确认数据库变更',
  STYLE_SELECTION: '请用户查看风格截图并选择候选',
  ENTER_IDEATION: '请用户确认进入构想阶段',
  APPROVE_ARCHITECTURE_PLAN:
    '请按 messages 顺序展示原始对话，与产品页面保持一致，不要自行摘要、改写或追加 attachments 中的完整研发规划。展示原始对话后请用户确认当前规划，不要自动确认',
  SELECT_FEATURES:
    '实现推荐的产品功能：请先按 messages 顺序展示原始对话，与产品页面保持一致，不要自行摘要或改写，并提醒用户选择 nextActions 提供的下一步入口；用户选择实现功能后，再将当前交互 details.features 中的全部功能按原顺序展示为多选列表，保留 id、title、description 和 checked 状态，不要只说功能已放入问卷。支持用户选择多项或明确全选，不要默认勾选；用户确认选择后，将对应的真实 id 一次性填入 featureIds，不能用展示序号代替真实 id；全选仅包含当前列表中的功能，不要补充或代选其他功能',
  START_EXECUTION: '请用户确认开始执行当前计划',
};

export function buildNextActions(
  result: GuidanceResult,
  config: Pick<RuntimeConfig, 'endpoint' | 'locale'>,
): Array<NextAction> {
  return nextActionsForState(result, config).map((action) =>
    action.requiresUserInput
      ? {
          ...action,
          instruction: `${action.instruction} 等待用户明确响应，不设置答题倒计时；未收到响应时保持当前步骤，不自动选择、提交、跳过或继续。`,
        }
      : action,
  );
}

function nextActionsForState(
  result: GuidanceResult,
  config: Pick<RuntimeConfig, 'endpoint' | 'locale'>,
): Array<NextAction> {
  // 显式保留连接地址，避免调用方执行下一步时切回默认环境；凭据不进入命令。
  const command = [COMMAND_NAME, '--endpoint', config.endpoint, '--locale', config.locale, 'chat'];
  if (result.state === 'NEEDS_INPUT' || result.state === 'NEEDS_SELECTION') {
    const interactions = result.interactions ?? [];
    if (interactions.length) {
      const nextActions = interactions.flatMap((interaction) =>
        interaction.actions.map((action): NextAction => {
          if (action === 'SKIP') {
            return {
              action,
              instruction: '仅在用户明确要求跳过当前交互后执行此命令。',
              requiresUserInput: true,
              interactionId: interaction.interactionId,
              command: [...command, 'interaction', 'skip', '--', result.sessionId, interaction.interactionId],
            };
          }
          const instruction = INTERACTION_INSTRUCTIONS[interaction.kind];
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
            input: { action },
          };
        }),
      );
      if (
        result.state === 'NEEDS_INPUT' &&
        result.development?.planApproved &&
        result.development.stage === 'FEATURE_SELECTION' &&
        interactions.every((interaction) => interaction.kind === 'SELECT_FEATURES')
      )
        nextActions.push({
          action: 'REVIEW_PUBLISH',
          instruction:
            '上线运营：与“实现推荐的产品功能”一起提示用户选择。用户选择上线运营后，先执行此命令查询可发布版本与部署状态；没有可发布版本时说明现状，不要宣称可以直接上线。核对目标版本并取得用户发布确认后再执行发布，不要把进入运营流程当成已经发布',
          requiresUserInput: true,
          command: [...command, 'publish', 'status', '--', result.sessionId],
        });
      return nextActions;
    }
  }
  if (result.state === 'NEEDS_SELECTION' || result.state === 'FAILED') {
    if (latestStyleChoices(result.choices ?? []).some((choice) => choice.selected)) return [];
    return latestStyleChoices(result.choices ?? []).flatMap((choice): Array<NextAction> => {
      if (choice.selected) return [];
      const retry = choice.status === 'failed';
      if (result.state === 'FAILED' && !retry) return [];
      if (!retry && (choice.status !== 'success' || !choice.screenshotUrl || choice.errorType)) return [];
      return [
        {
          action: retry ? 'RETRY_STYLE' : 'SELECT_STYLE',
          instruction: retry
            ? `风格 ${choice.index + 1} 生成失败；请用户确认是否重试。`
            : `请向用户展示 choices 中的 screenshotUrl；仅在用户选择风格 ${choice.index + 1} 后执行此命令，继续创作。`,
          requiresUserInput: true,
          choiceId: choice.choiceId,
          command: [...command, 'style', retry ? 'retry' : 'select', '--', result.sessionId, choice.choiceId],
        },
      ];
    });
  }
  if (result.state === 'COMPLETED' && result.demo) {
    if (result.demo.viewed) {
      const instruction =
        '请先向用户展示 demo.url，再原样展示以下引导：\n- **修改演示**：直接告诉我修改要求，比如“把主题换成绿色”。\n- **进入研发**：回复 **“开始研发”**，我会先生成研发规划供你确认。\n等待用户响应；查看记录不代表用户已满意，不额外增加确认步骤。';
      return [
        {
          action: 'CONTINUE_CHAT',
          instruction: `${instruction} 用户直接给出修改要求时，将其放入 content 字段，通过 --input - 提交 JSON，无需先让用户回复“修改演示”；如果用户只选择修改演示而未说明要求，再询问具体修改内容。不自动追加需求或进入研发。`,
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
    return [
      {
        action: 'VIEW_DEMO',
        instruction:
          '请告知用户“简易演示生成完毕”，询问是否查看演示以确认效果；此时只引导查看演示，不提前询问修改或进入研发。只有用户明确要求查看后才执行此命令；已取得 demo.url 不代表用户已经查看。',
        requiresUserInput: true,
        command: [...command, 'demo', '--', result.sessionId],
      },
    ];
  }
  if (result.state === 'COMPLETED' && result.development?.stage === 'COMPLETED') {
    return [
      {
        action: 'REVIEW_PUBLISH',
        instruction: '本轮研发已完成，查询可发布版本并核对结果，再决定发布；不要将演示快照当成研发发布版本。',
        requiresUserInput: true,
        command: [...command, 'publish', 'status', '--', result.sessionId],
      },
    ];
  }
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state)) {
    const anchor = result.cursor?.branchAnchor;
    return [
      {
        action: anchor ? 'QUERY_STYLES' : 'WAIT',
        instruction: anchor
          ? '风格仍在生成，继续查询本批候选直到截图就绪，再交给用户选择；不要重复生成。'
          : '任务尚未结束，继续等待下一步问题或结果；不要重复提交。',
        requiresUserInput: false,
        command: anchor
          ? [...command, 'style', 'list', '--anchor', anchor, '--', result.sessionId]
          : [
              ...command,
              'wait',
              ...(result.messageId ? ['--message-id', result.messageId] : []),
              '--',
              result.sessionId,
            ],
      },
    ];
  }
  return [];
}

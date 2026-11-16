/** 为宿主生成完整分页，并将分页回答还原为服务端原题答案。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Interaction, Question } from '../contracts/cli-output.js';
import { CliError } from '../output/exit-codes.js';
import { list, object } from '../contracts/value.js';
import { resolveAnswers } from './questions.js';

const NONE = 'page:none';

function displayedQuestions(interaction: Interaction): Question[] {
  if (interaction.kind !== 'SELECT_FEATURES') return interaction.questions;
  const features = z
    .array(
      z.object({
        id: z.union([z.string().min(1), z.number().int()]),
        title: z.string().min(1),
        description: z.string().nullish(),
      }),
    )
    .safeParse(interaction.details?.features);
  if (!features.success || !features.data.length)
    throw new CliError('UNSUPPORTED_INTERACTION', '当前功能清单为空或格式无效');
  return [
    {
      id: 'features',
      question: '请选择要开发的功能',
      multiSelect: true,
      allowOther: false,
      options: features.data.map((feature, index) => ({
        index,
        label: feature.title,
        description: feature.description ?? undefined,
      })),
    },
  ];
}
export function questionPages(interaction: Interaction, maxOptions: number) {
  if (!Number.isSafeInteger(maxOptions) || maxOptions < 2 || maxOptions > 50)
    throw new CliError('INVALID_ARGUMENT', '每页容量须为 2 至 50，包含本页都不选');
  const questions = displayedQuestions(interaction);
  if (!questions.length) throw new CliError('UNSUPPORTED_INTERACTION', '当前交互没有可分页的问题');
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        interactionId: interaction.interactionId,
        questions,
        features: interaction.kind === 'SELECT_FEATURES' ? interaction.details?.features : undefined,
        maxOptions,
      }),
    )
    .digest('hex');
  const pages = questions.flatMap((question) => {
    const count = Math.max(1, Math.ceil(question.options.length / (maxOptions - 1)));
    return Array.from({ length: count }, (_, index) => ({
      pageId: `${revision}:${encodeURIComponent(question.id)}:${index}`,
      questionId: question.id,
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect,
      allowOther: question.allowOther,
      pageNumber: index + 1,
      pageCount: count,
      options: [
        ...question.options.slice(index * (maxOptions - 1), (index + 1) * (maxOptions - 1)).map((option) => ({
          optionId: `option:${option.index}`,
          originalIndex: option.index,
          label: option.label,
          description: option.description,
          preview: option.preview,
          localOnly: false,
        })),
        {
          optionId: NONE,
          label: '本页都不选',
          description: '本页没有选择，继续查看其余选项。',
          localOnly: true,
        },
      ],
    }));
  });
  return { interactionId: interaction.interactionId, revision, maxOptions, pages };
}

const pagedAnswers = z
  .object({
    presentation: z.object({ revision: z.string(), maxOptions: z.number().int() }).strict(),
    pageAnswers: z.array(
      z
        .object({
          pageId: z.string(),
          selectedOptionIds: z.array(z.string()).min(1),
        })
        .strict(),
    ),
    otherAnswers: z.array(z.object({ questionId: z.string(), otherValue: z.string() }).strict()).default([]),
    action: z.string().optional(),
  })
  .strict();

export function resolvePageAnswers(interaction: Interaction, value: unknown) {
  const parsed = pagedAnswers.safeParse(value);
  if (!parsed.success) throw new CliError('INVALID_ARGUMENT', '分页回答格式无效');
  const input = parsed.data;
  const presentation = questionPages(interaction, input.presentation.maxOptions);
  if (presentation.revision !== input.presentation.revision)
    throw new CliError('STALE_INTERACTION', '题目或分页容量已经变化，请重新展示');
  const answersByPage = new Map(input.pageAnswers.map((answer) => [answer.pageId, answer]));
  if (answersByPage.size !== input.pageAnswers.length || answersByPage.size !== presentation.pages.length)
    throw new CliError('INVALID_ARGUMENT', '请完整读取并回答每一页，页标识不能重复');
  const questions = displayedQuestions(interaction);
  const selected = new Map(questions.map((question) => [question.id, [] as number[]]));
  for (const page of presentation.pages) {
    const answer = answersByPage.get(page.pageId);
    if (!answer) throw new CliError('INVALID_ARGUMENT', '分页回答缺少当前页面');
    if (new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length)
      throw new CliError('INVALID_ARGUMENT', '同一页面的选项不能重复');
    if (answer.selectedOptionIds.includes(NONE)) {
      if (answer.selectedOptionIds.length !== 1)
        throw new CliError('INVALID_ARGUMENT', '本页都不选与真实选项互斥');
      continue;
    }
    for (const id of answer.selectedOptionIds) {
      const option = page.options.find((item) => item.optionId === id);
      if (!option || !('originalIndex' in option))
        throw new CliError('INVALID_ARGUMENT', '选项不属于当前页面');
      selected.get(page.questionId)!.push(option.originalIndex);
    }
  }
  const others = new Map(input.otherAnswers.map((answer) => [answer.questionId, answer.otherValue]));
  if (others.size !== input.otherAnswers.length || [...others.keys()].some((id) => !selected.has(id)))
    throw new CliError('INVALID_ARGUMENT', '自定义回答的问题标识无效');
  const answers = questions.map((question) => ({
    questionId: question.id,
    selectedIndices: selected.get(question.id)!,
    otherValue: others.get(question.id) ?? '',
  }));
  // 空答案保留未决问题；单选、多选和自定义内容统一使用原有合同校验。
  resolveAnswers(questions, answers);
  if (interaction.kind === 'SELECT_FEATURES') {
    if (input.action && input.action !== 'SELECT')
      throw new CliError('INVALID_ARGUMENT', '功能分页仅支持选择功能');
    const features = list(interaction.details?.features).map(object);
    return { action: 'SELECT', featureIds: answers[0]!.selectedIndices.map((index) => features[index]!.id) };
  }
  return { ...(input.action ? { action: input.action } : {}), answers };
}

/** 无条件的后续业务菜单直接生成分页，宿主按原动作映射执行。 */
export function nextActionPages(actions: import('../contracts/cli-output.js').NextAction[]) {
  const choices = actions.filter((action) => action.requiresUserInput);
  // 报告型条件动作仍由报告规则判定，避免将有条件的上线或重试提前展示。
  if (!choices.length || choices.some((action) => action.when)) return undefined;
  const labels: Record<string, string> = {
    EDIT_APPEARANCE: '修改网站样式和内容',
    START_DEVELOPMENT: '进入研发',
    CONTINUE_EDITING: '继续修改样式和内容',
    CODE_REVIEW: '代码审查',
    AUTO_TEST: '自动测试',
    SECURITY_SCAN: '安全扫描',
    CONTINUE_CHAT: '继续创作',
    REVIEW_PUBLISH: '上线运营',
    AGENT_FRIENDLY: 'Agent 友好',
    ADVANCED_DESIGNER_POLISH: '高级设计师',
  };
  // 仅为已定义业务文案的菜单生成分页，其余动作沿用原引导。
  if (choices.some((action) => !labels[action.action])) return undefined;
  const descriptions: Record<string, string> = {
    EDIT_APPEARANCE: '调整网站的布局、文字、图片和配色。',
    START_DEVELOPMENT: '根据当前网站整理并开发真实功能。',
    CONTINUE_EDITING: '继续调整当前网站的样式和内容。',
    CODE_REVIEW: '检查本轮改动。',
    AUTO_TEST: '验证指定功能。',
    SECURITY_SCAN: '检查项目安全风险并处理发现的问题。',
    CONTINUE_CHAT: '新增或调整网站内容和功能。',
    REVIEW_PUBLISH: '将本次成果发布为正式版本。',
    AGENT_FRIENDLY: '将项目接入 AI 应用。',
    ADVANCED_DESIGNER_POLISH: '调整页面设计，也可以重新设计方案。',
  };
  const id = createHash('sha256').update(JSON.stringify(choices)).digest('hex');
  const interaction: Interaction = {
    interactionId: `local-actions:${id}`,
    kind: 'UNSUPPORTED',
    source: { roundId: 'local-actions', messageId: 'local-actions', contentId: id, variant: 'local-actions' },
    actions: [],
    answerSchema: {},
    questions: [
      {
        id: 'next-actions',
        question: '接下来你想做什么？',
        multiSelect: false,
        allowOther: true,
        options: choices.map((action, index) => ({
          index,
          label: action.instruction.startsWith('继续修改 → ')
            ? action.instruction.split(' → ')[1]!
            : (labels[action.action] ?? action.action),
          description: descriptions[action.action],
        })),
      },
    ],
  };
  return { ...questionPages(interaction, 3), kind: 'local-actions', actions: choices };
}

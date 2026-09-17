/** 托管向导的持久化状态与单题页面，与 Glow 的配置语义保持一致。@author xiuyu.yi */
import { z } from 'zod';
import type { Interaction, Question } from '../contracts/cli-output.js';
import type { WizardCatalog } from '../api/managed-agent-api.js';
import { fingerprint } from './draft-store.js';
import { CliError } from '../output/exit-codes.js';
import { object, text, type JsonObject } from '../contracts/value.js';
import { resolveAnswers, ANSWER_JSON_SCHEMA } from './questions.js';
export const wizardStage = z.enum([
  'description',
  'rewrite',
  'memory',
  'memory_name',
  'memory_existing',
  'skills',
  'confirm',
  'terminate',
]);
export const wizardDraftSchema = z.object({
  revision: z.number().int().nonnegative(),
  stage: wizardStage,
  previousStage: wizardStage.optional(),
  description: z.string(),
  undoDescription: z.string().optional(),
  builtinFileSelected: z.boolean().default(true),
  builtinWebSelected: z.boolean().default(true),
  memoryMode: z.enum(['new', 'existing', 'none']).default('new'),
  memoryName: z.string().default(''),
  existingMemory: z.object({ id: z.string(), label: z.string() }).optional(),
  skills: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['builtin', 'custom']),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  agentId: z.string().optional(),
  memoryStoreId: z.string().optional(),
  checkpoint: z
    .enum([
      'editing',
      'agent_pending',
      'memory_pending',
      'reply_pending',
      'complete',
      'stop_pending',
      'stopped',
    ])
    .default('editing'),
  confirmed: z.boolean().default(false),
  quick: z.boolean().default(false),
});
export type WizardDraft = z.infer<typeof wizardDraftSchema>;
export function inferAgentName(description: string): string {
  const normalized = description.trim();
  return (
    normalized.match(
      /(?:^|[\n。；;])\s*(?:智能体名称|智能体名字|名称|名字|agent name)\s*[:：]\s*[「“『"]?([^」”』"\n，。；;:：]{1,40})(?:[」”』"]|(?=[\n，。；;]|$))/iu,
    )?.[1] ||
    normalized.match(
      /(?:^|[\n。；;])\s*(?:你是(?:一位|一个)?|you are(?: an?| the)?)\s*[「“『"]([^」”』"\n]{1,40})[」”』"]/iu,
    )?.[1] ||
    normalized.match(
      /(?:^|[\n。；;])\s*你是(?:一位|一个)?\s*([^「“『"\n，。；;:：]{1,36}(?:助手|助理|顾问|专家|智能体))(?=[\s，。；;]|$)/u,
    )?.[1] ||
    ''
  ).trim();
}
export function suggestedMemoryName(description: string) {
  const name = inferAgentName(description)
    .replace(/(?:智能体|agent)$/iu, '')
    .trim();
  return name ? `${name}智能体记忆库` : '项目知识与记忆库';
}
const titles: Record<WizardDraft['stage'], string> = {
  description: '第一步，智能体设定',
  rewrite: '智能修改设定',
  memory: '第二步，知识和记忆',
  memory_name: '第二步，记忆库名称',
  memory_existing: '第二步，选择记忆库',
  skills: '第三步，扩展能力',
  confirm: '确认信息并创建',
  terminate: '终止创建智能体',
};
export function wizardPage(
  interaction: Interaction,
  draft: WizardDraft,
  catalog: WizardCatalog,
): Interaction {
  const question: Question = {
    id: draft.stage,
    question: '',
    multiSelect: false,
    allowOther: false,
    options: [],
  };
  const labels = (values: string[]) => values.map((label, index) => ({ index, label }));
  const actions = ['SUBMIT', 'TERMINATE'];
  const details: Record<string, unknown> = {
    actionLabels: { SKIP: '跳过此步骤' },
    actionDescriptions: { SKIP: '本次不配置知识文件和记忆库。' },
    workDescription: draft.description,
    knowledgeNotice: '知识文件可在创建后到 superun 网页端补充，本次不配置。',
    builtinCapabilities: ['读写文件、编辑代码', '联网搜索、抓取网页信息'],
    memory: {
      mode: draft.memoryMode,
      name:
        draft.memoryMode === 'new'
          ? draft.memoryName || suggestedMemoryName(draft.description)
          : draft.existingMemory?.label,
      id: draft.existingMemory?.id,
    },
    skills: draft.skills,
    creation: { checkpoint: draft.checkpoint, agentId: draft.agentId, memoryStoreId: draft.memoryStoreId },
    warnings: catalog.warnings,
  };
  if (draft.stage !== 'description') actions.push('BACK');
  switch (draft.stage) {
    case 'description':
      question.question = '是否使用这份智能体设定？';
      question.allowOther = true;
      question.options = labels(['继续', '智能修改', '快速创建']);
      question.options = question.options.map((option) =>
        option.index === 2
          ? { ...option, description: '按当前设定创建，本次不配置知识文件、记忆库和可选技能。' }
          : option,
      );
      details.instruction = '完整展示当前设定。可直接填写新的完整设定，或选择智能修改后输入修改要求。';
      if (draft.undoDescription !== undefined) actions.push('UNDO');
      break;
    case 'rewrite':
      question.question = '你希望如何修改智能体设定？';
      question.allowOther = true;
      break;
    case 'memory':
      question.question = '如何配置记忆库？';
      question.allowOther = true;
      question.options = labels([
        '新建记忆库并使用',
        ...(catalog.memories.length ? ['使用已有记忆库'] : []),
        '不使用记忆库',
      ]);
      question.options[0]!.description = `默认名称：${draft.memoryName || suggestedMemoryName(draft.description)}。如需其他名称，可直接在自定义输入中填写新名称。`;
      question.recommendedIndices = [0];
      actions.push('SKIP');
      break;
    case 'memory_name':
      question.question = '新记忆库叫什么？';
      question.allowOther = true;
      question.options = labels([`使用建议名称：${suggestedMemoryName(draft.description)}`]);
      actions.push('SKIP');
      break;
    case 'memory_existing':
      question.question = '使用哪个记忆库？';
      question.options = labels(catalog.memories.map((item) => item.label));
      actions.push('SKIP');
      break;
    case 'skills':
      details.actionDescriptions = { SKIP: '清空本次可选技能。' };
      question.question = '需要添加哪些扩展能力？';
      question.multiSelect = true;
      question.options = [
        ...labels(['读写文件、编辑代码（推荐）', '联网搜索、抓取网页信息（推荐）']),
        ...catalog.skills.map((item, index) => ({
          index: index + 2,
          label: item.label,
          description: item.description,
        })),
      ];
      question.recommendedIndices = [0, 1];
      details.instruction =
        '扩展能力是同一道可多选题，所有能力都可不选。按 questions 已给出的页序和选项顺序原样展示，每页都是多选，不再拆成单选或追问是否暂不添加。每页可提交空选择，控件不支持空选时使用该页现有的“本页不选”。本页不选只清空本页，不影响其他页；未勾选不是漏答。收齐所有页的明确答案后，一次提交 answers；不能逐页提交、追加逐页确认或漏掉其他页。';
      details.capabilityNotice =
        '内置能力的勾选与 Glow 一致；当前创建接口统一提供内置工具集，取消勾选不等于关闭对应工具权限。';
      actions.push('SKIP');
      break;
    case 'confirm':
      question.question = '是否确认创建这个智能体？';
      question.options = labels(['确认创建', '修改设定', '修改记忆库', '修改技能']);
      details.instruction =
        '完整展示当前设定、记忆库和所选技能，再等待用户明确确认；不能用之前的确认授权提交修改后的配置。';
      break;
    case 'terminate':
      question.question = '终止创建智能体？';
      question.options = labels(['确认终止', '继续编辑']);
      break;
  }
  if (draft.stage === 'terminate') actions.splice(0, actions.length, 'SUBMIT');
  if (['agent_pending', 'memory_pending', 'complete', 'stop_pending', 'stopped'].includes(draft.checkpoint)) {
    actions.length = 0;
    details.notice = ['agent_pending', 'memory_pending'].includes(draft.checkpoint)
      ? '资源创建结果尚未确认，请到网页核对，勿重复创建。'
      : '操作已提交，请查询服务端状态。';
  } else if (draft.confirmed || draft.agentId || draft.checkpoint === 'reply_pending') {
    actions.splice(0, actions.length, 'RESUME');
    details.notice = '创建已确认，只能继续尚未完成的步骤；已有资源会复用，不再重复创建。';
  }
  // 设定、能力和确认摘要与原页面共用数据，适配器不再按步骤重写一份。
  details.content = [draft.description, details.knowledgeNotice];
  if (draft.stage === 'skills') (details.content as unknown[]).push(details.capabilityNotice);
  if (draft.stage === 'confirm')
    (details.content as unknown[]).push(
      `记忆库：${draft.memoryMode === 'none' ? '不使用' : `${draft.memoryMode === 'new' ? '新建' : '使用已有'}「${draft.memoryMode === 'new' ? draft.memoryName : draft.existingMemory?.label}」`}\n能力勾选：${[draft.builtinFileSelected ? '读写文件、编辑代码' : '', draft.builtinWebSelected ? '联网搜索、抓取网页信息' : ''].filter(Boolean).join('、') || '未勾选内置能力'}\n可选技能：${draft.skills.map((skill) => skill.label).join('、') || '无'}\n知识文件：本次不配置\n内置工具集按 Glow 的现有创建接口提供，未勾选不表示工具权限已关闭。`,
    );
  const revision = fingerprint([interaction.interactionId, draft, question, catalog]);
  return {
    ...interaction,
    questions: actions.includes('SUBMIT') ? [question] : [],
    actions,
    page: { id: draft.stage, revision, title: titles[draft.stage] },
    details,
    answerSchema: {
      ...ANSWER_JSON_SCHEMA,
      required: ['action', 'pageRevision'],
      allOf: [{ if: { properties: { action: { const: 'SUBMIT' } } }, then: { required: ['answers'] } }],
      properties: {
        ...ANSWER_JSON_SCHEMA.properties,
        action: { enum: actions },
        pageRevision: { const: revision },
      },
    },
  };
}

/** 只对外暴露专家团已支持的普通问答；每次步骤变化都会生成新的不透明 ID。 */
export function wizardQuestion(page: Interaction): {
  interaction: Interaction;
  input: (answer: JsonObject) => JsonObject;
} {
  const revision = page.page?.revision;
  if (!revision) throw new CliError('PROTOCOL_ERROR', '向导缺少当前步骤标识');
  const original = page.questions[0];
  const controls = new Map<number, string>();
  const labels: Record<string, string> = {
    BACK: '上一步',
    SKIP: '跳过此步骤',
    TERMINATE: '终止创建',
    UNDO: '撤回设定修改',
    RESUME: '继续未完成的步骤',
    QUERY_STATE: '重新查询状态',
  };
  const actions = page.actions.length ? page.actions : ['QUERY_STATE'];
  const paginated = page.page?.id === 'skills' && !!original;
  const pageSize = 3;
  const questions: Question[] = [];
  if (paginated) {
    // 同一道多选题按控件容量展示；每页的空选入口只影响该页。
    const total = Math.ceil(original.options.length / pageSize);
    for (let start = 0; start < original.options.length; start += pageSize) {
      const number = start / pageSize + 1;
      const options = original.options.slice(start, start + pageSize);
      questions.push({
        ...original,
        id: `${original.id}_${number}`,
        header: `扩展 ${number}/${total}`,
        question: `${original.question} 第 ${number}/${total} 页（可多选，也可本页不选；不会影响其他页的选择）`,
        options: [
          ...options.map((option, index) => ({ ...option, index })),
          {
            index: options.length,
            label: '本页不选',
            description: '仅本页选择为空，不清空其他页，也不表示跳过整个步骤；请勿与本页能力同时选择。',
          },
        ],
        recommendedIndices: original.recommendedIndices
          ?.filter((index) => index >= start && index < start + options.length)
          .map((index) => index - start),
      });
    }
  } else if (original) {
    questions.push(original);
  } else {
    questions.push({
      id: 'operation',
      question: text(page.details?.notice) || '请选择下一步操作',
      multiSelect: false,
      allowOther: false,
      options: actions.map((action, index) => {
        controls.set(index, action);
        return { index, label: labels[action] ?? action };
      }),
    });
  }
  const instruction = [
    '只按当前 questions 展示问题，严格保持问题、分页和选项的原有顺序、单选/多选属性；答齐直接提交，不增加“是否继续”“是否修改”“是否暂不添加”等问题，不组合或重排选项。',
    '返回、跳过、撤回、终止是可选操作，只需在正文提示入口，用户主动要求时按 action 执行；不要把这些操作追加进问题选项或变成必答题。最终确认页只问当前确认题一次。',
    text(page.details?.instruction),
  ]
    .filter(Boolean)
    .join(' ');
  const interaction: Interaction = {
    interactionId: `wizard_${fingerprint([page.interactionId, revision, questions])}`,
    kind: 'ASK_USER_TOOL',
    source: page.source,
    questions,
    actions: original ? actions : ['SUBMIT'],
    answerSchema: {
      ...ANSWER_JSON_SCHEMA,
      required: [],
      allOf: [
        {
          if: { properties: { action: { const: 'SUBMIT' } } },
          then: { required: ['answers'] },
          else: { not: { required: ['answers'] } },
        },
      ],
      properties: {
        ...ANSWER_JSON_SCHEMA.properties,
        action: { enum: original ? actions : ['SUBMIT'], default: 'SUBMIT' },
        ...(paginated
          ? {
              answers: {
                ...ANSWER_JSON_SCHEMA.properties.answers,
                minItems: questions.length,
                maxItems: questions.length,
                items: {
                  ...ANSWER_JSON_SCHEMA.properties.answers.items,
                  required: ['questionId', 'selectedIndices'],
                },
              },
            }
          : {}),
      },
    },
    details: {
      title: page.page?.title,
      instruction,
      navigation: original
        ? actions
            .filter((action) => action !== 'SUBMIT')
            .map((action) => ({ action, label: labels[action] ?? action }))
        : [],
    },
  };
  return {
    interaction,
    input: (input) => {
      if (Object.keys(input).some((key) => !['action', 'answers'].includes(key)))
        throw new CliError('INVALID_ARGUMENT', '请使用当前问答的 action 和 answers');
      const action = input.action ?? 'SUBMIT';
      if (typeof action !== 'string' || !interaction.actions.includes(action))
        throw new CliError('INVALID_ARGUMENT', '当前问答不支持该操作');
      if (action !== 'SUBMIT') {
        if (input.answers !== undefined)
          throw new CliError('INVALID_ARGUMENT', '导航操作不接受问题答案；请单独提交当前 action');
        return { action, pageRevision: revision };
      }
      if (
        paginated &&
        Array.isArray(input.answers) &&
        input.answers.some((answer) => !Array.isArray(object(answer).selectedIndices))
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          '每页须明确提交所选索引；本页不选可提交 selectedIndices: []，不能省略答案',
        );
      const answers = resolveAnswers(questions, input.answers, { allowEmpty: paginated });
      if (!original) return { action: controls.get(answers[0]!.selectedIndices[0]!), pageRevision: revision };
      if (paginated) {
        const selectedIndices = answers.flatMap((answer, pageIndex) => {
          const emptyIndex = answer.question.options.length - 1;
          if (answer.selectedIndices.includes(emptyIndex)) {
            if (answer.selectedIndices.length !== 1)
              throw new CliError('INVALID_ARGUMENT', '“本页不选”不能与同页能力同时选择；其他页的选择不冲突');
            return [];
          }
          return answer.selectedIndices.map((index) => pageIndex * pageSize + index);
        });
        return {
          action: 'SUBMIT',
          pageRevision: revision,
          answers: [{ questionId: original.id, selectedIndices }],
        };
      }
      return { action: 'SUBMIT', pageRevision: revision, answers: input.answers };
    },
  };
}

/** 托管向导的持久化状态与单题页面，与 Glow 的配置语义保持一致。@author xiuyu.yi */
import { z } from 'zod';
import type { Interaction, Question } from '../contracts/cli-output.js';
import type { WizardCatalog } from '../api/managed-agent-api.js';
import { fingerprint } from './draft-store.js';
import { ANSWER_JSON_SCHEMA } from './questions.js';
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
  confirm: '第四步，确认信息并创建',
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
    knowledgeNotice: '知识文件可在创建后到 Superun 网页端补充，本次不配置。',
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
      question.options = labels([
        '新建记忆库并使用',
        ...(catalog.memories.length ? ['使用已有记忆库'] : []),
        '不使用记忆库',
      ]);
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
        ...catalog.skills.map((item, index) => ({ index, label: item.label, description: item.description })),
        { index: catalog.skills.length, label: '暂不添加' },
      ];
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
  details.content = [draft.description, details.knowledgeNotice, details.instruction];
  if (draft.stage === 'skills')
    (details.content as unknown[]).push(`内置能力：${(details.builtinCapabilities as string[]).join('、')}`);
  if (draft.stage === 'confirm')
    (details.content as unknown[]).push(
      `记忆库：${draft.memoryMode === 'none' ? '不使用' : `${draft.memoryMode === 'new' ? '新建' : '使用已有'}「${draft.memoryMode === 'new' ? draft.memoryName : draft.existingMemory?.label}」`}\n可选技能：${draft.skills.map((skill) => skill.label).join('、') || '无'}\n知识文件：本次不配置`,
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

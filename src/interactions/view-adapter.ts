/** 将已知业务交互投影为通用视图；只有 CLI 负责字段到原业务参数的映射。@author xiuyu.yi */
import { z } from 'zod';
import type { Interaction, Question, Choice } from '../contracts/cli-output.js';
import type {
  FieldValue,
  InteractionField,
  InteractionView,
  InteractionViewAction,
} from '../contracts/interaction-view.js';
import { list, object, text, type JsonObject } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { fingerprint } from './draft-store.js';

type Context = { questions?: Question[]; messages?: string[]; choices?: Choice[] };
type Binding = { action: InteractionViewAction; lower: (values: Record<string, FieldValue>) => JsonObject };
const responseSchema = z
  .object({
    response: z
      .object({
        version: z.literal('1'),
        revision: z.string().min(1),
        actionId: z.string().min(1),
        values: z
          .record(
            z.object({ optionIds: z.array(z.string()).optional(), text: z.string().optional() }).strict(),
          )
          .default({}),
      })
      .strict(),
  })
  .strict();
const labels: Record<string, string> = {
  SUBMIT: '提交回答',
  GENERATE_STYLES: '提交回答并继续',
  SAVE: '保存当前答案',
  BACK: '上一步',
  SKIP: '跳过',
  ENABLE: '启用',
  APPROVE: '确认',
  ENTER: '继续',
  EXECUTE: '开始执行',
  SELECT: '确认选择',
  TERMINATE: '终止创建',
  UNDO: '撤回修改',
  RESUME: '继续未完成的步骤',
};
const titles: Record<string, string> = {
  PRD_CLARIFICATION: '需求确认',
  ASK_USER_TOOL: '请回答以下问题',
  ASK_USER_MESSAGE: '请回答以下问题',
  SECRET_INPUT: '安全配置',
  PLUGIN_SECRET_INPUT: '插件安全配置',
  PLUGIN_ACTION: '插件配置',
  DDL_CONFIRMATION: '确认数据库变更',
  APPROVE_ARCHITECTURE_PLAN: '确认研发规划',
  SELECT_FEATURES: '选择需要实现的功能',
  STYLE_SELECTION: '选择风格',
  ENTER_IDEATION: '进入构想',
  START_EXECUTION: '开始执行',
  UNSUPPORTED: '需要到网页处理',
};
const validUrl = (value: string | undefined): value is string => {
  try {
    return !!value && ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
function field(question: Question): InteractionField {
  return {
    id: question.id,
    type: question.options.length ? (question.multiSelect ? 'multi' : 'single') : 'text',
    label: question.question,
    header: question.header,
    required: true,
    allowOther: question.allowOther,
    options: question.options.map((option) => ({
      id: `option:${option.index}`,
      label: option.label,
      description: option.description,
      preview: option.preview,
      ...(question.recommendedIndices?.includes(option.index) ? { recommended: true } : {}),
    })),
  };
}
function answer(question: Question, value: FieldValue) {
  return {
    questionId: question.id,
    selectedIndices: (value.optionIds ?? []).map((id) => {
      const option = question.options.find((o) => `option:${o.index}` === id);
      if (!option) throw new CliError('INVALID_ARGUMENT', '选项不属于当前问题');
      return option.index;
    }),
    otherValue: value.text ?? '',
  };
}

export function interactionView(
  interaction: Interaction,
  context: Context = {},
): { view: InteractionView; bindings: Binding[] } {
  const details = interaction.details ?? {};
  const fields: InteractionField[] = [],
    bindings: Binding[] = [];
  const content: InteractionView['content'] = [];
  const links: InteractionView['links'] = [];
  let supported = interaction.supported !== false && interaction.kind !== 'UNSUPPORTED';
  const addText = (value: unknown, type: 'markdown' | 'notice' = 'markdown') => {
    if (typeof value === 'string' && value.trim() && !content.some((item) => item.text === value))
      content.push({ type, text: value });
  };
  const add = (
    id: string,
    label: string,
    ids: string[],
    lower: Binding['lower'],
    validation: InteractionViewAction['validation'] = ids.length ? 'complete' : 'none',
    description?: string,
  ) => {
    bindings.push({
      action: { id, label, description, fieldIds: ids, validation, requiresUserInput: true },
      lower,
    });
  };
  const fixed = (action: string, label = labels[action] ?? action, description?: string) =>
    add(
      action,
      label,
      [],
      () => ({ action, ...(interaction.page ? { pageRevision: interaction.page.revision } : {}) }),
      'none',
      description,
    );
  const questions = context.questions ?? interaction.questions;
  const questionnaire = ['PRD_CLARIFICATION', 'ASK_USER_TOOL', 'ASK_USER_MESSAGE'].includes(interaction.kind);
  if (questionnaire) {
    fields.push(...questions.map(field));
    for (const saved of list(details.savedAnswers).map(object)) {
      const target = fields.find((f) => f.id === saved.questionId);
      if (target)
        target.value = {
          optionIds: list(saved.selectedIndices).map((index) => `option:${index}`),
          text: text(saved.otherValue) ?? '',
        };
    }
    const submit = interaction.actions.find((action) => action === 'SUBMIT' || action === 'GENERATE_STYLES');
    if (submit) {
      const lower = (values: Record<string, FieldValue>) => ({
        action: submit,
        pageRevision: interaction.page?.revision,
        answers: questions.filter((q) => values[q.id]).map((q) => answer(q, values[q.id]!)),
      });
      add(
        submit,
        labels[submit]!,
        fields.map((f) => f.id),
        lower,
      );
      add(
        'SAVE',
        labels.SAVE!,
        fields.map((f) => f.id),
        (values) => ({ ...lower(values), saveOnly: true }),
        'partial',
        '只保存已回答内容，不启动后续任务；整组确认后再提交。',
      );
    }
    if (interaction.actions.includes('SKIP'))
      fixed('SKIP', '跳过本组问题', '跳过整组，不是仅跳过当前显示页。');
    if (interaction.actions.includes('BACK')) fixed('BACK');
    for (const message of context.messages ?? []) addText(message);
  } else if (interaction.kind === 'MANAGED_AGENT_WIZARD') {
    addText(details.workDescription);
    addText(details.knowledgeNotice, 'notice');
    addText(details.instruction, 'notice');
    const stage = interaction.page?.id;
    const question = interaction.questions[0];
    const submitOption = (index: number): JsonObject => ({
      action: 'SUBMIT',
      pageRevision: interaction.page?.revision,
      answers: [{ questionId: question?.id, selectedIndices: [index], otherValue: '' }],
    });
    if (interaction.actions.includes('SUBMIT') && question) {
      if (stage === 'description') {
        fields.push({
          id: 'workDescription',
          type: 'text',
          label: '修改后的完整智能体设定',
          required: true,
          allowOther: true,
          options: [],
        });
        add('CONTINUE', '继续', [], () => submitOption(0));
        add('EDIT_DESCRIPTION', '保存修改后的设定', ['workDescription'], (values) => ({
          action: 'SUBMIT',
          pageRevision: interaction.page?.revision,
          answers: [
            { questionId: question.id, selectedIndices: [], otherValue: values.workDescription!.text },
          ],
        }));
        add('SMART_EDIT', '智能修改', [], () => submitOption(1));
        add(
          'QUICK_CREATE',
          '快速创建',
          [],
          () => submitOption(2),
          'none',
          '按当前设定创建，本次不配置知识文件、记忆库和可选技能。',
        );
      } else if (stage === 'confirm' || stage === 'terminate') {
        const ids =
          stage === 'confirm'
            ? ['CREATE', 'EDIT_DESCRIPTION', 'EDIT_MEMORY', 'EDIT_SKILLS']
            : ['STOP', 'KEEP_EDITING'];
        question.options.forEach((option, index) =>
          add(ids[index] ?? `choice:${option.index}`, option.label, [], () => submitOption(option.index)),
        );
      } else {
        fields.push(field(question));
        add('SUBMIT', stage === 'rewrite' ? '提交并重新生成' : '继续', [question.id], (values) => ({
          action: 'SUBMIT',
          pageRevision: interaction.page?.revision,
          answers: [answer(question, values[question.id]!)],
        }));
      }
    }
    for (const action of interaction.actions.filter((a) => a !== 'SUBMIT'))
      fixed(
        action,
        labels[action],
        action === 'SKIP'
          ? stage === 'skills'
            ? '清空本次可选技能。'
            : '本次不配置知识文件和记忆库。'
          : undefined,
      );
    if (stage === 'skills')
      addText(
        `内置能力：${list(details.builtinCapabilities)
          .filter((x) => typeof x === 'string')
          .join('、')}`,
        'notice',
      );
    if (stage === 'confirm') {
      const memory = object(details.memory);
      addText(
        `记忆库：${memory.mode === 'none' ? '不使用' : `${memory.mode === 'new' ? '新建' : '使用已有'}「${text(memory.name) ?? ''}」`}\n可选技能：${
          list(details.skills)
            .map((s) => text(object(s).label))
            .filter(Boolean)
            .join('、') || '无'
        }\n知识文件：本次不配置`,
      );
    }
  } else if (['SECRET_INPUT', 'PLUGIN_SECRET_INPUT'].includes(interaction.kind)) {
    const keys = list(details.keys).filter((key): key is string => typeof key === 'string');
    fields.push(
      ...keys.map((key, index): InteractionField => ({
        id: `secret:${index}`,
        type: 'secret',
        label: key,
        required: true,
        allowOther: false,
        options: [],
      })),
    );
    if (!keys.length) supported = false;
    for (const action of interaction.actions) {
      if (action === 'SUBMIT')
        add(
          action,
          '安全提交配置',
          fields.map((f) => f.id),
          (values) => ({
            values: Object.fromEntries(keys.map((key, index) => [key, values[`secret:${index}`]!.text])),
          }),
        );
      else fixed(action);
    }
    addText('仅通过安全输入渠道填写，不在普通聊天、草稿或交接记录中保存密钥。', 'notice');
  } else if (interaction.kind === 'SELECT_FEATURES') {
    const features = list(details.features).map(object);
    if (!features.length) supported = false;
    fields.push({
      id: 'features',
      label: '请选择要实现的功能（可多选）',
      type: 'multi',
      required: true,
      allowOther: false,
      options: features.map((feature, index) => ({
        id: `feature:${index}`,
        label: `${String(feature.id)} ${text(feature.title) ?? ''}`,
        description: text(feature.description),
      })),
    });
    if (interaction.actions.includes('SELECT'))
      add('SELECT', '开始实现所选功能', ['features'], (values) => ({
        action: 'SELECT',
        featureIds: (values.features!.optionIds ?? []).map(
          (id) => features[Number(id.slice('feature:'.length))]!.id,
        ),
      }));
    fields.push({
      id: 'requirement',
      label: '具体需求',
      type: 'text',
      required: true,
      allowOther: true,
      options: [],
    });
    add('SEND_REQUIREMENT', '提出具体需求', ['requirement'], (values) => ({
      genericMessage: values.requirement!.text,
    }));
  } else if (interaction.kind === 'STYLE_SELECTION') {
    const choices = (context.choices ?? []).filter(
      (choice) =>
        choice.status === 'success' && validUrl(choice.previewUrl) && !choice.selected && !choice.errorType,
    );
    if (!choices.length) supported = false;
    fields.push({
      id: 'style',
      label: '请选择风格方案',
      type: 'single',
      required: true,
      allowOther: false,
      options: choices.map((choice) => ({
        id: choice.choiceId,
        label: `方案 ${String.fromCharCode(65 + choice.index)}`,
      })),
    });
    links.push(
      ...choices.map((choice) => ({
        label: `方案 ${String.fromCharCode(65 + choice.index)}`,
        url: choice.previewUrl!,
      })),
    );
    add('SELECT', '采用所选方案', ['style'], (values) => ({
      action: 'SELECT',
      choiceId: values.style!.optionIds?.[0],
    }));
  } else if (
    [
      'PLUGIN_ACTION',
      'DDL_CONFIRMATION',
      'APPROVE_ARCHITECTURE_PLAN',
      'ENTER_IDEATION',
      'START_EXECUTION',
    ].includes(interaction.kind)
  ) {
    addText(details.summary);
    addText(details.statusText);
    if (interaction.kind === 'PLUGIN_ACTION') addText(`插件：${text(details.pluginName) ?? ''}`);
    for (const message of context.messages ?? []) addText(message);
    interaction.actions.forEach((action) =>
      fixed(
        action,
        action === 'APPROVE'
          ? interaction.kind === 'DDL_CONFIRMATION'
            ? '确认数据库变更'
            : '确认规划'
          : labels[action],
      ),
    );
    if (interaction.kind === 'APPROVE_ARCHITECTURE_PLAN') {
      fields.push({
        id: 'changes',
        label: '需要调整的功能或要求',
        type: 'text',
        required: true,
        allowOther: true,
        options: [],
      });
      add('ADJUST_PLAN', '调整功能', ['changes'], (values) => ({ genericMessage: values.changes!.text }));
    }
  } else supported = false;
  addText(details.notice, 'notice');
  for (const warning of list(details.warnings)) addText(warning, 'notice');
  if (
    new Set(fields.map((field) => field.id)).size !== fields.length ||
    fields.some((field) => new Set(field.options.map((option) => option.id)).size !== field.options.length) ||
    new Set(bindings.map((binding) => binding.action.id)).size !== bindings.length
  )
    supported = false;
  if (!supported) {
    bindings.length = 0;
    addText('当前交互缺少可执行契约，请按原状态指引处理，不猜测或自动跳过。', 'notice');
  }
  const base = {
    version: '1' as const,
    interactionId: interaction.interactionId,
    stepId: questionnaire ? 'questions' : (interaction.page?.id ?? interaction.source.variant),
    title: questionnaire
      ? titles[interaction.kind]!
      : (interaction.page?.title ?? titles[interaction.kind] ?? '需要处理的交互'),
    supported,
    content,
    fields,
    actions: bindings.map((binding) => binding.action),
    links,
    capabilities: [
      ...new Set([
        'content',
        ...(bindings.length ? ['actions'] : []),
        ...fields.map((f) => f.type),
        ...(links.length ? ['links'] : []),
      ]),
    ],
  };
  return {
    view: { ...base, revision: fingerprint([base, interaction.page?.revision, interaction.source]) },
    bindings,
  };
}

/** 通用输入在 CLI 内翻译；不允许把回复中的字段名直接拼成业务请求。 */
export function translateResponse(
  interaction: Interaction,
  input: JsonObject,
  context: Context = {},
): JsonObject {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success)
    throw new CliError('INVALID_ARGUMENT', 'response 格式无效，只接受 version、revision、actionId 和 values');
  const { view, bindings } = interactionView(interaction, context);
  const response = parsed.data.response;
  if (!view.supported) throw new CliError('UNSUPPORTED_INTERACTION', '当前交互不支持通用回答');
  if (response.revision !== view.revision)
    throw new CliError('STALE_INTERACTION', '交互内容已变化，请读取最新视图');
  const binding = bindings.find((item) => item.action.id === response.actionId);
  if (!binding) throw new CliError('INVALID_ARGUMENT', '当前交互不允许这个操作');
  if (Object.keys(response.values).some((id) => !binding.action.fieldIds.includes(id)))
    throw new CliError('INVALID_ARGUMENT', '回答包含当前操作未要求的字段');
  const values: Record<string, FieldValue> = Object.create(null);
  for (const id of binding.action.fieldIds) {
    const f = view.fields.find((item) => item.id === id)!;
    const value =
      response.values[id] ??
      (binding.action.validation === 'complete' && f.type !== 'secret' ? f.value : undefined);
    if (!value) {
      if (binding.action.validation === 'complete' && f.required)
        throw new CliError('INVALID_ARGUMENT', `请回答：${f.label}`);
      continue;
    }
    const options = value.optionIds ?? [],
      rawText = value.text ?? '';
    if (
      new Set(options).size !== options.length ||
      options.some((option) => !f.options.some((item) => item.id === option))
    )
      throw new CliError('INVALID_ARGUMENT', '选项无效或重复');
    if (
      (f.type === 'single' || f.type === 'text' || f.type === 'secret') &&
      options.length + (rawText ? 1 : 0) > 1
    )
      throw new CliError('INVALID_ARGUMENT', '当前字段只允许一个答案');
    if (rawText && !f.allowOther && !['text', 'secret'].includes(f.type))
      throw new CliError('INVALID_ARGUMENT', '当前字段不允许自由输入');
    if (f.required && !options.length && !rawText.trim())
      throw new CliError('INVALID_ARGUMENT', `请回答：${f.label}`);
    values[id] = value;
  }
  if (binding.action.validation === 'partial' && !Object.keys(values).length)
    throw new CliError('INVALID_ARGUMENT', '请先回答至少一个问题');
  return binding.lower(values);
}

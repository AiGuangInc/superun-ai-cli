/** 题目投影与按索引校验回答。@author xiuyu.yi */
import { z } from 'zod';
import type { Question } from '../contracts/cli-output.js';
import { list, object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';

export function projectQuestions(raw: unknown, preserveIds = false): Array<Question> {
  return list(raw).map((value, index) => {
    const question = object(value);
    const label = text(question.question);
    if (!label?.trim()) throw new CliError('UNSUPPORTED_INTERACTION', '交互缺少有效问题文本');
    const options = list(question.options).map((entry, optionIndex) => {
      const fields = object(entry);
      const optionLabel = text(entry) ?? text(fields.label);
      if (!optionLabel?.trim()) throw new CliError('UNSUPPORTED_INTERACTION', '交互包含无法识别的选项');
      return {
        index: optionIndex,
        label: optionLabel,
        description: text(fields.description),
        preview: text(fields.preview),
      };
    });
    const recommended = question.recommended_index;
    return {
      id: preserveIds ? (text(question.id) ?? `q${index}`) : `q${index}`,
      question: label,
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      allowOther: true,
      options,
      ...(typeof recommended === 'number' &&
      Number.isInteger(recommended) &&
      recommended >= 0 &&
      recommended < options.length
        ? { recommendedIndices: [recommended] }
        : {}),
    };
  });
}

const answerSchema = z
  .object({
    questionId: z.string(),
    selectedIndices: z.array(z.number().int().nonnegative()).default([]),
    otherValue: z.string().default(''),
  })
  .strict();
export function resolveAnswers(
  questions: Array<Question>,
  input: unknown,
): Array<{
  question: Question;
  selectedIndices: Array<number>;
  selectedOptions: Array<string>;
  otherValue: string;
}> {
  const parsed = z.array(answerSchema).safeParse(input);
  if (!parsed.success)
    throw new CliError('INVALID_ARGUMENT', 'answers 必须包含 questionId、selectedIndices 和可选 otherValue');
  if (
    parsed.data.length !== questions.length ||
    new Set(parsed.data.map((a) => a.questionId)).size !== questions.length
  ) {
    throw new CliError('INVALID_ARGUMENT', '每道问题必须且只能回答一次');
  }
  return questions.map((question) => {
    const answer = parsed.data.find((item) => item.questionId === question.id);
    if (!answer || new Set(answer.selectedIndices).size !== answer.selectedIndices.length)
      throw new CliError('INVALID_ARGUMENT', '问题 ID 或选项下标重复/无效');
    const otherValue = answer.otherValue.trim();
    if (!answer.selectedIndices.length && !otherValue)
      throw new CliError('INVALID_ARGUMENT', `请回答：${question.question}`);
    if (!question.multiSelect && answer.selectedIndices.length + (otherValue ? 1 : 0) > 1)
      throw new CliError('INVALID_ARGUMENT', `该题只允许单选：${question.question}`);
    const selectedOptions = answer.selectedIndices.map((index) => {
      const option = question.options[index];
      if (!option) throw new CliError('INVALID_ARGUMENT', '选项下标超出当前问题范围');
      return option.label;
    });
    return { question, selectedIndices: answer.selectedIndices, selectedOptions, otherValue };
  });
}

export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  required: ['answers'],
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    styleCount: { type: 'integer', minimum: 1, maximum: 4 },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId'],
        additionalProperties: false,
        properties: {
          questionId: { type: 'string' },
          selectedIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
          otherValue: { type: 'string' },
        },
      },
    },
  },
};

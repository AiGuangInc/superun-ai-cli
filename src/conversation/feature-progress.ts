/** 读取 Glow 同源功能与 Todo，以真实功能 ID 组装步骤进度。@author xiuyu.yi */
import { z } from 'zod';
import type { TaskProgressItem } from '../contracts/cli-output.js';
import { parseWire } from '../contracts/node-wire.js';
import { object } from '../contracts/value.js';

const featureId = z.number().int().positive().safe();
const status = z.enum(['pending', 'in_progress', 'completed']);
const featureSchema = z.object({
  id: featureId,
  title: z.string().trim().min(1),
  checked: z.boolean(),
  status,
});
const stepSchema = z.object({
  featureId,
  content: z.string().trim().min(1),
  status,
});

function attachmentArray(raw: unknown): Array<unknown> {
  // 尚未生成附件时可以为空；损坏的 JSON 必须交由调用方显示读取失败。
  if (raw === null || raw === undefined || raw === '') return [];
  return parseWire(z.array(z.unknown()), typeof raw === 'string' ? JSON.parse(raw) : raw);
}

export function projectFeatureTasks(
  sessionId: string,
  rawFeatures: unknown,
  rawTodos: unknown,
): Array<TaskProgressItem> {
  const features = attachmentArray(rawFeatures)
    .filter((item) => object(item).checked === true || object(item).status === 'completed')
    .map((item) => parseWire(featureSchema, item));
  const ids = new Set(features.map((feature) => feature.id));
  // 功能 ID 冲突时不能凭标题或数组下标猜关联。
  if (ids.size !== features.length) throw new Error('功能 ID 重复');
  const stepsByFeature = new Map<number, NonNullable<TaskProgressItem['steps']>>();
  for (const raw of attachmentArray(rawTodos)) {
    // 与 Glow 一致：旧版未关联功能的 Todo 不混入任意功能。
    if (!ids.has(object(raw).featureId as number)) continue;
    const step = parseWire(stepSchema, raw);
    const steps = stepsByFeature.get(step.featureId) ?? [];
    steps.push({ content: step.content, status: step.status });
    stepsByFeature.set(step.featureId, steps);
  }
  return features.map((feature) => {
    const steps = stepsByFeature.get(feature.id) ?? [];
    return {
      id: `feature:${sessionId}:${feature.id}`,
      kind: 'feature',
      featureId: feature.id,
      title: feature.title,
      status:
        feature.status === 'completed'
          ? 'completed'
          : feature.status === 'in_progress'
            ? 'running'
            : 'waiting',
      steps,
      ...(steps.length
        ? {
            stepProgress: {
              completed: steps.filter((step) => step.status === 'completed').length,
              total: steps.length,
            },
          }
        : { detail: '步骤尚未生成' }),
    };
  });
}

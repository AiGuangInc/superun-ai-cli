/** 会话 API 响应契约；通过运行时校验后再处理。@author xiuyu.yi */
import { z } from 'zod';
import { CliError } from '../output/exit-codes.js';

const extra = z.record(z.unknown());
export const itemSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    variant: z.string(),
    role: z.string().optional(),
    intent: z.string().optional(),
    source: z
      .object({ messageId: z.string().optional(), contentId: z.string().optional() })
      .passthrough()
      .optional(),
    payload: extra.default({}),
  })
  .passthrough();
export const roundSchema = z
  .object({
    roundId: z.string(),
    sessionId: z.string(),
    anchorUserMessageId: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'interrupted']),
    time: z.object({ timestamp: z.number() }).passthrough(),
    userItems: z.array(itemSchema),
    agentItems: z.array(itemSchema),
    activity: extra.optional(),
    meta: extra.optional(),
  })
  .passthrough();
export const messageSchema = z
  .object({
    messageId: z.string(),
    sessionId: z.string(),
    role: z.number(),
    createdAt: z.number(),
    replyMessageId: z.string().optional(),
    status: z.number().optional(),
    sessionStatus: z.number().optional(),
    sessionErrorType: z.string().optional(),
    extra: extra.optional(),
    roundExtra: extra.optional(),
    displayContents: z.array(extra).default([]),
    meta: extra.optional(),
  })
  .passthrough();
export const pipelineSchema = z
  .object({
    messages: z.array(messageSchema),
    render: z
      .object({ rounds: z.array(roundSchema) })
      .passthrough()
      .optional(),
    roundPatch: z
      .object({
        roundId: z.string(),
        targetMessageId: z.string(),
        anchorUserMessageId: z.string(),
        patch: z
          .object({
            operation: z.enum(['upsert-round', 'replace-agent-items', 'replace-user-items']),
            round: roundSchema.optional(),
            agentItems: z.array(itemSchema).optional(),
            userItems: z.array(itemSchema).optional(),
            status: roundSchema.shape.status.optional(),
            meta: extra.optional(),
            activity: extra.optional(),
            time: roundSchema.shape.time.optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    pollingHint: z
      .object({ nextPollAfterMs: z.number(), bypassIfNoneMatch: z.boolean().optional() })
      .optional(),
  })
  .passthrough();
export const recentlySchema = z.object({
  session: z
    .object({
      sessionId: z.string(),
      topic: z.string(),
      status: z.number(),
      errorType: z.string().optional(),
      pendingBranch: z.object({ preReplyMessageId: z.string() }).optional(),
      everDeployed: z.boolean().optional(),
      publicStatus: z.number().optional(),
    })
    .passthrough(),
  pipeline: pipelineSchema,
});
export type NodeItem = z.infer<typeof itemSchema>;
export type NodeRound = z.infer<typeof roundSchema>;
export type NodeMessage = z.infer<typeof messageSchema>;
export type NodePipeline = z.infer<typeof pipelineSchema>;
export type NodeRecently = z.infer<typeof recentlySchema>;
export type SessionView = NodeRecently & {
  extra: Record<string, unknown>;
  features?: Array<Record<string, unknown>>;
  automaticWork?: boolean;
};

export function parseWire<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new CliError('PROTOCOL_ERROR', 'API 响应与当前 CLI 契约不兼容', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  return parsed.data;
}

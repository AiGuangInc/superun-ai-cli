/** App 专属数据合同，不改变通用创作输出。@author xiuyu.yi */
import { z } from 'zod';
import type { NextAction, CreationState } from '../contracts/cli-output.js';
import type { ExecutionActivity } from '../conversation/execution-activity.js';

export const platformSchema = z.enum(['android', 'harmony', 'ios']);
export type AppPlatform = z.infer<typeof platformSchema>;
export const platformNames: Record<AppPlatform, string> = { android: '安卓', harmony: '鸿蒙', ios: 'iOS' };
export const appIdFields = { android: 'androidAppId', harmony: 'harmonyAppId', ios: 'iosAppId' } as const;
const optionalText = z.string().nullish();
export const configSchema = z.object({
  sessionId: z.string(),
  appName: z.string(),
  iconUrl: optionalText,
  androidAppId: z.string(),
  harmonyAppId: z.string(),
  iosAppId: z.string(),
  currentSnapshotId: z.number().nullish(),
  publishedSnapshotId: z.number().nullish(),
  environmentIsolationEnabled: z.boolean().optional(),
});
export type AppConfig = z.infer<typeof configSchema>;
export const uploadSchema = z.object({
  channel: z.enum(['appgallery_connect', 'app_store_connect']),
  status: z.string(),
  appId: optionalText,
  errorMessage: optionalText,
  uploadedAt: z.unknown().optional(),
});
export const buildSchema = z.object({
  taskId: z.string().regex(/^[a-f0-9]{32}$/),
  platform: platformSchema,
  appId: z.string(),
  appName: z.string(),
  versionName: z.string(),
  versionCode: z.number().int(),
  buildType: z.enum(['debug', 'release']),
  buildStatus: z.number().int(),
  downloadUrl: optionalText,
  artifactName: optionalText,
  fileSize: z.number().nullish(),
  errorMessage: optionalText,
  sourceMessageId: optionalText,
  sourceSnapshotId: z.number().nullish(),
  createdAt: z.unknown().optional(),
  uploads: z.array(uploadSchema).nullish(),
});
export type AppBuild = z.infer<typeof buildSchema>;
export const accountSchema = z.object({
  platform: platformSchema,
  connected: z.boolean(),
  agcAppId: optionalText,
  harmonyBundleName: optionalText,
  testDeviceIds: z.array(z.string()).nullish(),
});
export type AppAccount = z.infer<typeof accountSchema>;
export const signingSchema = z.object({
  platform: platformSchema,
  mode: z.string(),
  certificateDname: optionalText,
  signingSubject: z.record(z.string()).nullish(),
  exportable: z.boolean().optional(),
  exportedAt: z.unknown().optional(),
});
export const installSchema = z.object({
  platform: platformSchema,
  buildType: z.enum(['debug', 'release']).optional(),
  appName: z.string(),
  versionName: z.string(),
  versionCode: z.number(),
  iconUrl: optionalText,
  downloadUrl: z.string().url(),
  artifactName: optionalText,
});
export const threadSchema = z.object({
  consultId: z.string(),
  startReplyMessageId: z.string(),
  lastReplyMessageId: z.string(),
  lastMessageId: z.string(),
  running: z.boolean(),
  closed: z.boolean(),
  handedOffMessageId: optionalText,
  previewVersionId: z.number(),
});
export type AppThread = z.infer<typeof threadSchema>;
export const planFeatureSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  draftTodos: z.array(z.string().trim().min(1)).min(1),
  planBatchId: z.string().min(1),
  origin: z.literal('consult_plan'),
  status: z.literal('pending'),
  checked: z.literal(false),
});
export type AppPlanFeature = z.infer<typeof planFeatureSchema>;
export type AppQuestion = {
  header: string;
  question: string;
  multiSelect: false;
  options: Array<{ label: string; description: string; action: string }>;
};
export type AppResult = {
  executionActivity?: ExecutionActivity;
  state: CreationState | 'READY';
  sessionId: string;
  platform: AppPlatform;
  stage: string;
  notice?: string;
  nextActions: Array<NextAction>;
  question?: AppQuestion;
  [key: string]: unknown;
};
export const contextSchema = z.object({
  developmentMessageId: z.string().optional(),
  consultId: z.string().optional(),
  consultMessageId: z.string().optional(),
  consultRequestPending: z.boolean().optional(),
  planFingerprint: z.string().optional(),
  executionMessageId: z.string().optional(),
  executionPending: z.boolean().optional(),
  adaptedMessageId: z.string().optional(),
  publishedSnapshotId: z.number().optional(),
  taskId: z.string().optional(),
  buildPending: z.boolean().optional(),
  priorBuildIds: z.array(z.string()).optional(),
});
export type AppContext = z.infer<typeof contextSchema>;

/** 面向终端、Agent 和 MCP 调用方的稳定输出协议。@author xiuyu.yi */
export type CreationState =
  | 'ACCEPTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'NEEDS_INPUT'
  | 'NEEDS_SELECTION'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED';
export type InteractionKind =
  | 'PRD_CLARIFICATION'
  | 'ASK_USER_TOOL'
  | 'ASK_USER_MESSAGE'
  | 'SECRET_INPUT'
  | 'PLUGIN_SECRET_INPUT'
  | 'PLUGIN_ACTION'
  | 'DDL_CONFIRMATION'
  | 'STYLE_SELECTION'
  | 'ENTER_IDEATION'
  | 'APPROVE_ARCHITECTURE_PLAN'
  | 'SELECT_FEATURES'
  | 'START_EXECUTION';
export type Question = {
  id: string;
  question: string;
  header?: string;
  multiSelect: boolean;
  allowOther: boolean;
  options: Array<{ index: number; label: string; description?: string; preview?: string }>;
  recommendedIndices?: Array<number>;
};
export type Interaction = {
  interactionId: string;
  kind: InteractionKind;
  source: { roundId: string; messageId: string; contentId: string; variant: string; toolId?: string };
  questions: Array<Question>;
  actions: Array<string>;
  answerSchema: Record<string, unknown>;
  details?: Record<string, unknown>;
};
export type Choice = {
  choiceId: string;
  batchVersion?: number;
  index: number;
  preReplyMessageId: string;
  replyMessageId: string;
  lastReplyMessageId?: string;
  status: 'running' | 'success' | 'failed';
  previewUrl?: string;
  screenshotUrl?: string;
  errorType?: string;
  selected?: boolean;
};
export type NextAction = {
  action: string;
  instruction: string;
  requiresUserInput: boolean;
  /** 完整命令的参数数组；仅提供引导，不会自动执行。 */
  command: Array<string>;
  interactionId?: string;
  choiceId?: string;
  /** 回复的固定字段，用户数据仍需按对应交互的 answerSchema 补齐。 */
  input?: { action: string };
};
export type DemoPreview = {
  snapshotId: string;
  messageId: string;
  url: string;
  viewed: boolean;
};
export type DevelopmentSnapshot =
  | { status: 'READY'; snapshotId: string; messageId: string; url: string }
  | { status: 'PENDING' | 'UNAVAILABLE'; messageId: string; reason: string };
export type DevelopmentProgress = {
  stage:
    | 'READY'
    | 'PLANNING'
    | 'PLAN_REVIEW'
    | 'FEATURE_SELECTION'
    | 'EXECUTION_REVIEW'
    | 'DEVELOPING'
    | 'COMPLETED';
  started: boolean;
  planApproved: boolean;
  /** 当前研发轮的快照；规划与问答轮不要求产生快照。 */
  snapshot?: DevelopmentSnapshot;
};
export type CreationResult = {
  state: CreationState;
  sessionId: string;
  messageId?: string;
  replyMessageId?: string;
  topic?: string;
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>;
  progress: Array<{ id: string; text: string; status?: string }>;
  interactions: Array<Interaction>;
  choices?: Array<Choice>;
  /** 用户选定风格后，自动衔接演示状态与研发规划；不代表已确认规划。 */
  stylePlanning?: { choiceId: string };
  demo?: DemoPreview;
  development?: DevelopmentProgress;
  cursor?: { messageId?: string; etag?: string; branchAnchor?: string };
  attachments?: Array<Record<string, unknown>>;
  waitTimedOut?: boolean;
  nextActions?: Array<NextAction>;
};

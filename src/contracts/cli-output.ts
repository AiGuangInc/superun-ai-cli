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
  cursor?: { messageId?: string; etag?: string; branchAnchor?: string };
  attachments?: Array<Record<string, unknown>>;
  waitTimedOut?: boolean;
};

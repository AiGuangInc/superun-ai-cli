/** CLI 与宿主之间的版本化展示契约，不暴露业务处理器参数。@author xiuyu.yi */
export type FieldValue = { optionIds?: string[]; text?: string };
export type InteractionField = {
  id: string;
  type: 'single' | 'multi' | 'text' | 'secret';
  label: string;
  header?: string;
  required: boolean;
  allowOther: boolean;
  options: Array<{
    id: string;
    label: string;
    description?: string;
    preview?: string;
    recommended?: boolean;
  }>;
  /** 仅已保存的非敏感答案，不代表推荐项或替用户确认。 */
  value?: FieldValue;
};
export type InteractionViewAction = {
  id: string;
  label: string;
  description?: string;
  fieldIds: string[];
  validation: 'complete' | 'partial' | 'none';
  requiresUserInput: boolean;
};
export type InteractionView = {
  version: '1';
  reply?: { command: string[]; input: { response: { version: '1'; revision: string } } };
  interactionId: string;
  revision: string;
  stepId: string;
  title: string;
  supported: boolean;
  capabilities: string[];
  content: Array<{ type: 'markdown' | 'notice'; text: string }>;
  fields: InteractionField[];
  actions: InteractionViewAction[];
  links: Array<{ label: string; url: string }>;
};
export type InteractionResponse = {
  version: '1';
  revision: string;
  actionId: string;
  values?: Record<string, FieldValue>;
};

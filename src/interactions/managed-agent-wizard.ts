/** 托管向导只在确认后创建资源；每个成功 ID 立即落盘以恢复后续步骤。@author xiuyu.yi */
import type { CreationRuntime } from '../runtime.js';
import { CliError } from '../output/exit-codes.js';
import { object, requiredText, text, type JsonObject } from '../contracts/value.js';
import type { InteractionBinding } from './context.js';
import { InteractionDraftStore } from './draft-store.js';
import { ManagedAgentApi, type WizardCatalog } from '../api/managed-agent-api.js';
import { resolveAnswers } from './questions.js';
import {
  inferAgentName,
  suggestedMemoryName,
  wizardDraftSchema,
  wizardPage,
  type WizardDraft,
} from './managed-agent-model.js';
const emptyCatalog: WizardCatalog = { memories: [], skills: [], warnings: [] };
function validateDescription(value: string) {
  if (!value.trim() || value.length > 4000)
    throw new CliError('INVALID_ARGUMENT', '智能体设定必须为 1～4000 字符');
}
export class ManagedAgentWizard {
  readonly api: ManagedAgentApi;
  constructor(
    private readonly runtime: CreationRuntime,
    private readonly store: InteractionDraftStore,
  ) {
    this.api = new ManagedAgentApi(runtime.client);
  }
  private key(binding: InteractionBinding) {
    return `wizard:${binding.round.sessionId}:${binding.interaction.interactionId}`;
  }
  private async read(binding: InteractionBinding): Promise<WizardDraft> {
    const raw = await this.store.read(this.key(binding));
    if (raw === undefined)
      return wizardDraftSchema.parse({
        revision: 0,
        stage: 'description',
        description: text(binding.item.payload.workDescription) || '',
      });
    const parsed = wizardDraftSchema.safeParse(raw);
    if (!parsed.success) throw new CliError('PROTOCOL_ERROR', '向导草稿损坏，未创建资源');
    return parsed.data;
  }
  private async catalog(binding: InteractionBinding, draft: WizardDraft) {
    return ['memory', 'memory_existing', 'skills', 'confirm'].includes(draft.stage) && !draft.agentId
      ? this.api.catalog(binding.round.sessionId)
      : emptyCatalog;
  }
  async project(binding: InteractionBinding): Promise<InteractionBinding> {
    const draft = await this.read(binding);
    return {
      ...binding,
      interaction: wizardPage(binding.interaction, draft, await this.catalog(binding, draft)),
    };
  }
  async reply(
    binding: InteractionBinding,
    input: JsonObject,
    validate: () => Promise<void>,
  ): Promise<JsonObject> {
    return this.store.locked(this.key(binding), async () => {
      await validate();
      const draft = await this.read(binding),
        catalog = await this.catalog(binding, draft);
      const page = wizardPage(binding.interaction, draft, catalog);
      if (Object.keys(input).some((key) => !['action', 'pageRevision', 'answers'].includes(key)))
        throw new CliError('INVALID_ARGUMENT', '向导回答包含不支持的字段；不支持附件或技能上传');
      if (input.pageRevision !== page.page?.revision)
        throw new CliError('STALE_INTERACTION', '向导页面或选项目录已变化，请重新查询再回答');
      const action = requiredText(input.action, 'action');
      if (!page.actions.includes(action)) throw new CliError('INVALID_ARGUMENT', '当前向导不支持该动作');
      const save = async () => {
        draft.revision++;
        await this.store.write(this.key(binding), draft);
      };
      const local = async () => {
        await save();
        return { localInteraction: true, sessionId: binding.round.sessionId };
      };
      if (action === 'RESUME') return this.create(binding, draft, save, validate);
      if (action === 'TERMINATE') {
        draft.previousStage = draft.stage;
        draft.stage = 'terminate';
        return local();
      }
      if (action === 'UNDO') {
        if (draft.undoDescription === undefined) throw new CliError('INVALID_ARGUMENT', '没有可撤回的修改');
        draft.description = draft.undoDescription;
        delete draft.undoDescription;
        return local();
      }
      if (action === 'BACK') {
        const previous: Partial<Record<WizardDraft['stage'], WizardDraft['stage']>> = {
          rewrite: 'description',
          memory: 'description',
          memory_name: 'memory',
          memory_existing: 'memory',
          skills: 'memory',
          confirm: 'skills',
        };
        draft.stage = previous[draft.stage] || 'description';
        return local();
      }
      if (action === 'SKIP') {
        if (draft.stage === 'skills') {
          draft.skills = [];
          draft.stage = 'confirm';
        } else {
          draft.memoryMode = 'none';
          draft.memoryName = '';
          delete draft.existingMemory;
          draft.stage = 'skills';
        }
        return local();
      }
      const [answer] = resolveAnswers(page.questions, input.answers, {
        allowEmpty: draft.stage === 'skills',
      });
      if (!answer) throw new CliError('INVALID_ARGUMENT', '请回答当前问题');
      if (answer.otherValue && !answer.question.allowOther)
        throw new CliError('INVALID_ARGUMENT', '本题只能选择已展示的选项');
      const index = answer.selectedIndices[0];
      switch (draft.stage) {
        case 'description':
          if (answer.otherValue) {
            validateDescription(answer.otherValue);
            draft.undoDescription = draft.description;
            draft.description = answer.otherValue;
            draft.quick = false;
            draft.stage = 'memory';
            break;
          }
          validateDescription(draft.description);
          if (index === 1) draft.stage = 'rewrite';
          else if (index === 2) {
            draft.memoryMode = 'none';
            draft.memoryName = '';
            delete draft.existingMemory;
            draft.skills = [];
            draft.quick = true;
            draft.confirmed = true;
            await save();
            return this.create(binding, draft, save, validate);
          } else {
            draft.quick = false;
            draft.stage = 'memory';
          }
          break;
        case 'rewrite': {
          const rewritten = await this.api.rewrite(binding.round.sessionId, {
            messageId: binding.interaction.source.messageId,
            toolId: requiredText(binding.interaction.source.toolId, 'toolId'),
            currentDescription: draft.description,
            instruction: requiredText(answer.otherValue, '修改要求'),
          });
          draft.undoDescription = draft.description;
          draft.description = rewritten;
          draft.stage = 'description';
          break;
        }
        case 'memory':
          delete draft.existingMemory;
          if (index === 0 || answer.otherValue) {
            draft.memoryMode = 'new';
            draft.memoryName =
              answer.otherValue || draft.memoryName || suggestedMemoryName(draft.description);
            draft.stage = 'skills';
          } else if (catalog.memories.length && index === 1) {
            draft.memoryMode = 'existing';
            draft.memoryName = '';
            draft.stage = 'memory_existing';
          } else {
            draft.memoryMode = 'none';
            draft.memoryName = '';
            draft.stage = 'skills';
          }
          break;
        case 'memory_name':
          draft.memoryName = answer.otherValue || suggestedMemoryName(draft.description);
          draft.stage = 'skills';
          break;
        case 'memory_existing':
          draft.existingMemory = catalog.memories[index ?? -1];
          if (!draft.existingMemory) throw new CliError('STALE_INTERACTION', '记忆库已不可用，请重新选择');
          draft.stage = 'skills';
          break;
        case 'skills':
          draft.builtinFileSelected = answer.selectedIndices.includes(0);
          draft.builtinWebSelected = answer.selectedIndices.includes(1);
          draft.skills = answer.selectedIndices
            .filter((i) => i >= 2)
            .map((i) => {
              const skill = catalog.skills[i - 2];
              if (!skill) throw new CliError('STALE_INTERACTION', '技能目录已变化');
              return skill;
            });
          draft.stage = 'confirm';
          break;
        case 'confirm':
          if (index === 0) {
            draft.quick = false;
            draft.confirmed = true;
            await save();
            return this.create(binding, draft, save, validate);
          }
          draft.stage = index === 1 ? 'description' : index === 2 ? 'memory' : 'skills';
          break;
        case 'terminate':
          if (index === 1) {
            draft.stage = draft.previousStage || 'description';
            delete draft.previousStage;
            break;
          }
          draft.checkpoint = 'stop_pending';
          await save();
          await validate();
          try {
            await this.runtime.client.call(
              '/api/uxa-center/agent/AgentCommand/stop',
              {
                sessionId: binding.round.sessionId,
                messageId: binding.interaction.source.messageId,
                stopMain: 2,
                stopSubAgent: 0,
              },
              true,
            );
          } catch (error) {
            if (
              error instanceof CliError &&
              ['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'BUSINESS_ERROR'].includes(error.code)
            ) {
              draft.checkpoint = 'editing';
              await save();
            }
            throw error;
          }
          draft.checkpoint = 'stopped';
          draft.description = '';
          draft.skills = [];
          draft.memoryName = '';
          delete draft.existingMemory;
          await save();
          return { localInteraction: true, sessionId: binding.round.sessionId };
      }
      return local();
    });
  }
  private async create(
    binding: InteractionBinding,
    draft: WizardDraft,
    save: () => Promise<void>,
    validate: () => Promise<void>,
  ): Promise<JsonObject> {
    if (!draft.confirmed) throw new CliError('INVALID_ARGUMENT', '请先确认当前创建配置');
    if (['agent_pending', 'memory_pending'].includes(draft.checkpoint))
      throw new CliError('OUTCOME_UNKNOWN', '资源创建结果未确认，请先核验，不能重复创建');
    const sessionId = binding.round.sessionId;
    validateDescription(draft.description);
    try {
      if (!draft.agentId && !draft.quick && (draft.skills.length || draft.memoryMode === 'existing')) {
        const current = await this.api.catalog(sessionId);
        if (
          draft.memoryMode === 'existing' &&
          !current.memories.some((item) => item.id === draft.existingMemory?.id)
        )
          throw new CliError('STALE_INTERACTION', '所选记忆库已不可用或未能核验，请重新查询');
        if (
          draft.skills.some(
            (item) => !current.skills.some((value) => value.id === item.id && value.type === item.type),
          )
        )
          throw new CliError('STALE_INTERACTION', '所选技能已不可用或未能核验，请重新查询');
      }
      if (!draft.agentId) {
        const contract = await this.api.contract(sessionId, 'agents'),
          defaults = contract.defaultValue;
        const tools = Array.isArray(defaults.tools) ? [...defaults.tools] : [];
        if (!tools.some((tool) => String(object(tool).type).startsWith('agent_toolset')))
          tools.push({ type: 'agent_toolset_20260401' });
        const model = text(defaults.model) || text(object(defaults.model).id) || 'superun-efficient';
        const description = draft.description.trim();
        // 创建契约的简述字段可能短于向导的完整设定；完整文本始终放入 system。
        const maxDescription =
          Number(object(object(contract.createSchema.properties).description).maxLength) || 4000;
        await validate();
        draft.checkpoint = 'agent_pending';
        await save();
        draft.agentId = await this.api.create(sessionId, 'agents', {
          ...defaults,
          name: inferAgentName(description) || '项目问答助手',
          description: description.slice(0, maxDescription),
          model,
          system: `你是当前项目的问答助手。请按照以下工作说明提供准确、简洁的回答。遇到项目中无法确认的信息时，请明确说明，不要猜测。\n\n工作说明：\n${description}`,
          tools,
          skills: draft.skills.map((skill) => ({ type: skill.type, skill_id: skill.id, version: 'latest' })),
        });
        draft.checkpoint = 'editing';
        await save();
      }
      if (draft.memoryMode === 'new' && !draft.memoryStoreId) {
        const contract = await this.api.contract(sessionId, 'memory_stores');
        await validate();
        draft.checkpoint = 'memory_pending';
        await save();
        draft.memoryStoreId = await this.api.create(sessionId, 'memory_stores', {
          ...contract.defaultValue,
          name: requiredText(draft.memoryName, '记忆库名称'),
          description: draft.description.trim(),
        });
        draft.checkpoint = 'editing';
        await save();
      }
      await validate();
      draft.checkpoint = 'reply_pending';
      await save();
      const memoryStoreId = draft.memoryMode === 'existing' ? draft.existingMemory?.id : draft.memoryStoreId;
      const response = await this.runtime.command.reply(
        sessionId,
        requiredText(binding.interaction.source.toolId, 'toolId'),
        {
          success: true,
          status: 'completed',
          agentId: draft.agentId,
          fileIds: [],
          attachmentIds: [],
          ...(memoryStoreId ? { memoryStoreId } : {}),
          skillIds: draft.skills.map((skill) => skill.id),
          mcpServers: [],
        },
      );
      draft.checkpoint = 'complete';
      await save();
      return response;
    } catch (error) {
      // 明确拒绝没有创建副作用，允许修正后继续；网络不确定或进程中断保留检查点阻止重建。
      if (
        error instanceof CliError &&
        (['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'BUSINESS_ERROR', 'STALE_INTERACTION'].includes(error.code) ||
          (error.code === 'PROTOCOL_ERROR' &&
            [400, 404, 409, 422].includes(Number(error.details.httpStatus))))
      ) {
        draft.checkpoint = 'editing';
        if (!draft.agentId) draft.confirmed = false;
        await save();
      }
      if (error instanceof CliError)
        throw new CliError(error.code, error.message, {
          ...error.details,
          sessionId,
          interactionId: binding.interaction.interactionId,
          checkpoint: draft.checkpoint,
          agentId: draft.agentId,
          memoryStoreId: draft.memoryStoreId,
        });
      throw new CliError('OUTCOME_UNKNOWN', '创建进度未能确认，请查询状态，勿重复创建', {
        sessionId,
        checkpoint: draft.checkpoint,
        agentId: draft.agentId,
        memoryStoreId: draft.memoryStoreId,
      });
    }
  }
}

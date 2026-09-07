/** 回答处理器的内部入参。@author xiuyu.yi */
import type { CreationRuntime } from '../../runtime.js';
import type { InteractionBinding } from '../context.js';
import type { JsonObject } from '../../contracts/value.js';
export type ReplyContext = { runtime: CreationRuntime; binding: InteractionBinding; input: JsonObject };
export type ReplyHandler = (context: ReplyContext) => Promise<JsonObject>;

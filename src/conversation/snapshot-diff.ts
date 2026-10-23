/** 同项目主线版本差异；权限、版本和暂存检查不写入远端。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const stagingSchema = z.object({
  hasStaging: z.boolean(),
  files: z.array(
    z.object({
      filename: z.string().min(1),
      replyMessageId: z.string().min(1),
      updatedAt: z.number().finite(),
      status: z.number().int(),
    }),
  ),
});
const diffSchema = z.object({
  oldReplyMessageId: z.string(),
  newReplyMessageId: z.string(),
  diffs: z.array(
    z.object({
      filename: z.string().min(1),
      status: z.enum(['ADDED', 'REMOVED', 'UPDATED']),
      unifiedDiff: z.string(),
    }),
  ),
});

function safePath(filename: string) {
  const parts = filename.replace(/\\/g, '/').split('/');
  return !parts.some((part) => /^(?:\.\.|internal|compiled|\.superun|\._shared_|\.env(?:\..*)?)$/.test(part));
}

async function staging(service: CreationRuntime, sessionId: string) {
  // 此接口在服务端执行checkSessionEditorAccess，不能只靠diff的NoAuth入口。
  const result = parseWire(
    stagingSchema,
    await service.client.call('/api/uxa-center/agent/AgentQuery/queryAgentAttachmentGit', {
      sessionId,
      withContent: false,
    }),
  );
  if (
    result.hasStaging !== result.files.length > 0 ||
    new Set(result.files.map((file) => file.filename)).size !== result.files.length ||
    result.files.some((file) => file.status !== 0)
  )
    throw new CliError('PROTOCOL_ERROR', '暂存状态不完整，未继续读取版本差异');
  return result.files.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function pair(service: CreationRuntime, sessionId: string, oldId: string, newId: string) {
  const found = new Map<
    string,
    Awaited<ReturnType<CreationRuntime['query']['snapshotHistory']>>['items'][number]
  >();
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const result = await service.query.snapshotHistory(sessionId, page, 100);
    if (result.items.length > 100 || result.items.some((item) => seen.has(item.encryptedId)))
      throw new CliError('PROTOCOL_ERROR', '版本历史分页重复或超出页大小，请重新查询');
    for (const item of result.items) {
      if (seen.has(item.encryptedId)) throw new CliError('PROTOCOL_ERROR', '版本历史存在重复项');
      seen.add(item.encryptedId);
      if (item.messageId === oldId || item.messageId === newId) {
        if (found.has(item.messageId)) throw new CliError('PROTOCOL_ERROR', '同轮版本标识不唯一');
        found.set(item.messageId, item);
      }
    }
    if (found.size === 2) break;
    if (result.items.length < 100 || (result.total !== null && page * 100 >= result.total)) break;
  }
  const oldVersion = found.get(oldId),
    newVersion = found.get(newId);
  if (!oldVersion || !newVersion)
    throw new CliError(
      'INVALID_ARGUMENT',
      '未在本作品主线历史中确认两端版本，请从session history选择两个messageId',
    );
  if (oldVersion.createdAt >= newVersion.createdAt)
    throw new CliError('INVALID_ARGUMENT', '旧版本必须早于新版本，请核对两端顺序');
  return { oldVersion, newVersion };
}

export async function snapshotDiff(
  service: CreationRuntime,
  sessionId: string,
  oldId: string,
  newId: string,
  includeDiff: boolean,
) {
  if ([sessionId, oldId, newId].some((value) => !/^[A-Za-z0-9_-]+$/.test(value)) || oldId === newId)
    throw new CliError('INVALID_ARGUMENT', '请明确一个作品及两个不同的主线messageId');
  const view = await service.load(sessionId);
  if (view.session.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '版本查询返回了不同作品');
  const beforeStaging = await staging(service, sessionId);
  const versions = await pair(service, sessionId, oldId, newId);
  const response = parseWire(
    diffSchema,
    await service.client.call('/api/uxa-center/agent/SessionSnapshot/querySnapshotAttachmentDiff', {
      sessionId,
      oldReplyMessageId: oldId,
      newReplyMessageId: newId,
      withSourceContent: false,
    }),
  );
  if (response.oldReplyMessageId !== oldId || response.newReplyMessageId !== newId)
    throw new CliError('PROTOCOL_ERROR', '版本差异回执与本次两端标识不一致');
  if (new Set(response.diffs.map((item) => item.filename)).size !== response.diffs.length)
    throw new CliError('PROTOCOL_ERROR', '版本差异返回重复文件');
  const afterVersions = await pair(service, sessionId, oldId, newId);
  const afterStaging = await staging(service, sessionId);
  const versionKey = (value: typeof versions) =>
    JSON.stringify([
      value.oldVersion.encryptedId,
      value.oldVersion.createdAt,
      value.newVersion.encryptedId,
      value.newVersion.createdAt,
    ]);
  if (
    versionKey(versions) !== versionKey(afterVersions) ||
    JSON.stringify(beforeStaging) !== JSON.stringify(afterStaging)
  )
    throw new CliError('STALE_INTERACTION', '查询期间版本或暂存发生变化，请重新确认后查询');
  const visible = response.diffs.filter((item) => safePath(item.filename));
  const items = visible.slice(0, 200).map((item) => {
    let addedLines = 0,
      removedLines = 0,
      inHunk = false;
    for (const line of item.unifiedDiff.split('\n')) {
      if (line.startsWith('@@ ')) inHunk = true;
      else if (inHunk && line.startsWith('+')) addedLines++;
      else if (inHunk && line.startsWith('-')) removedLines++;
    }
    return {
      filename: item.filename,
      status: item.status,
      addedLines,
      removedLines,
      ...(includeDiff
        ? { unifiedDiff: item.unifiedDiff.slice(0, 12000), diffTruncated: item.unifiedDiff.length > 12000 }
        : {}),
    };
  });
  return {
    state: 'COMPLETED',
    sessionId,
    topic: view.session.topic,
    previewVersionId: 0,
    ...versions,
    basis: 'SNAPSHOT_WITH_CURRENT_USER_STAGING',
    stagingFilesOnNewVersion: beforeStaging.filter((file) => file.replyMessageId === newId).length,
    sourceCompleteness: 'UNVERIFIED',
    warning: '新侧可能叠加当前账号的未提交暂存；底层缺失源内容可能按空文件处理，不能保证源文件完整。',
    totalChangedFiles: visible.length,
    omittedInternalFiles: response.diffs.length - visible.length,
    filesTruncated: visible.length > items.length,
    items,
  };
}

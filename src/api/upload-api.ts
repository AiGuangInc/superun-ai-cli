/** 复用 Glow 的七牛上传、审核和文档预处理，只发送 URL 附件。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { pollOperation } from '../commands/shared.js';
import { list, object, requiredText } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { HttpClient } from '../transport/http-client.js';
import { getSuperunHostingDomain } from '../config/runtime-config.js';
import { MAX_PIXELS, MB } from './upload-files.js';
import type { PreparedFile } from './upload-files.js';

export type InputAttachment = { name: string; url: string; mediaType: string; meta?: JsonObject };
const urlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  });
const numberSchema = z.number().finite().nonnegative();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CliError('PROTOCOL_ERROR', `${label}返回的数据无效，尚未发送创作消息`);
  return result.data;
}

async function uploadToCdn(service: CreationRuntime, file: PreparedFile): Promise<string> {
  const response = await service.client.request(
    `/api/uxa-center/support/FileUpload/getUploadToken?fileType=${encodeURIComponent(file.extension)}`,
    undefined,
    { method: 'GET' },
  );
  const token = object(response.data),
    credential = requiredText(token.token, '上传凭据');
  service.output.registerSecret(credential);
  const encryptedId = requiredText(token.encryptedId, '上传记录');
  const form = new FormData();
  form.append('token', credential);
  form.append('file', file.blob, file.name);
  const signal = service.client.signal;
  let uploaded: Response;
  try {
    uploaded = await fetch('https://upload-na0.qiniup.com', {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
  } catch {
    throw new CliError(
      signal?.aborted ? 'INTERRUPTED' : 'OUTCOME_UNKNOWN',
      `${file.name}：上传已中断或结果不确定，尚未发送创作消息`,
    );
  }
  await uploaded.body?.cancel();
  if (!uploaded.ok) throw new CliError('BUSINESS_ERROR', `${file.name}：附件上传失败，尚未发送创作消息`);
  service.output.log(`${file.name}：上传完成，等待审核`);
  return pollOperation(
    async () => {
      const response = object(
        await service.client.call('/api/uxa-center/support/FileUpload/queryFileUrl', {
          encryptedIds: [encryptedId],
        }),
      );
      const item = object(list(response.items)[0]);
      switch (item.auditStatus) {
        case 0:
          return undefined;
        case 1:
        case 4:
          return parse(urlSchema, item.url, '附件审核');
        case 2:
          throw new CliError('BUSINESS_ERROR', `${file.name}：附件审核未通过，尚未发送创作消息`);
        case 3:
          throw new CliError('BUSINESS_ERROR', `${file.name}：附件审核结果存疑，尚未发送创作消息`);
        default:
          throw new CliError('BUSINESS_ERROR', `${file.name}：附件审核异常，尚未发送创作消息`);
      }
    },
    (url) => url !== undefined,
    { timeout: 180, signal },
  ).then((url) => url!);
}

async function preprocess(service: CreationRuntime, path: string, payload: JsonObject): Promise<JsonObject> {
  const domain =
    getSuperunHostingDomain(service.client.config.endpoint) === 'superun.yun' ? 'superun.com' : 'superun.ai';
  const response = await new HttpClient().request({
    url: `https://heavylift.${domain}/document/${path}/json`,
    body: payload,
    headers: { 'content-type': 'application/json' },
    write: true,
    timeoutMs: 300_000,
    signal: service.client.signal,
  });
  const taskId = requiredText(object(response.data).taskId, '文件预处理任务');
  return pollOperation(
    async () => {
      const task = object(
        await service.client.call('/api/uxa-center/support/FileUpload/pollFileTask', { taskId }),
      );
      if (task.status === 0 || task.status === 1) return undefined;
      if (task.status === 3) throw new CliError('BUSINESS_ERROR', '附件预处理失败，尚未发送创作消息');
      if (task.status !== 2 || typeof task.result !== 'string')
        throw new CliError('PROTOCOL_ERROR', '附件预处理返回未知状态，尚未发送创作消息');
      let result: JsonObject;
      try {
        result = object(JSON.parse(task.result));
      } catch {
        throw new CliError('PROTOCOL_ERROR', '无法读取附件预处理结果，尚未发送创作消息');
      }
      if (result.code !== 0)
        throw new CliError(
          'BUSINESS_ERROR',
          result.code === 10002 ? '不支持加密 PDF，尚未发送创作消息' : '附件预处理未通过，尚未发送创作消息',
        );
      return object(result.data);
    },
    (result) => result !== undefined,
    { timeout: 300, signal: service.client.signal },
  ).then((result) => result!);
}

function checkSize(file: PreparedFile, bytes: number): void {
  if (bytes > file.rule.size * MB)
    throw new CliError(
      'INVALID_ARGUMENT',
      `${file.name}：处理后文件仍超过 ${file.rule.size}MB，尚未发送创作消息`,
    );
}
function checkLimit(file: PreparedFile, value: number, limit: number | undefined, label: string): void {
  if (limit !== undefined && value > limit)
    throw new CliError('INVALID_ARGUMENT', `${file.name}：${label}超过 ${limit}，尚未发送创作消息`);
}
const bytesToMb = (bytes: number): number => Math.round((bytes / MB) * 100) / 100;

export async function uploadAttachment(
  service: CreationRuntime,
  file: PreparedFile,
): Promise<InputAttachment> {
  service.output.log(`${file.name}：正在上传附件`);
  const url = await uploadToCdn(service, file);
  const attachment: InputAttachment = { name: file.name, url, mediaType: file.mediaType };
  const { extension, rule } = file;
  if (file.image) {
    let { width, height } = file.image;
    let fileSize = file.blob.size;
    const maxPixels = Math.min(rule.maxPixels ?? MAX_PIXELS, MAX_PIXELS);
    if (fileSize > rule.size * MB || width * height > maxPixels) {
      service.output.log(`${file.name}：正在压缩图片`);
      const result = parse(
        z.object({
          image_url: urlSchema,
          width: numberSchema.positive(),
          height: numberSchema.positive(),
          file_size: numberSchema,
        }),
        await preprocess(service, 'compress-image', {
          image_url: url,
          max_dimension:
            width * height > maxPixels
              ? Math.floor(Math.max(width, height) * Math.sqrt(maxPixels / (width * height)))
              : -1,
        }),
        '图片压缩',
      );
      attachment.url = result.image_url;
      width = result.width;
      height = result.height;
      fileSize = result.file_size;
    }
    checkSize(file, fileSize);
    checkLimit(file, Math.max(width, height), rule.maxSize, '图片宽高');
    checkLimit(file, width * height, maxPixels, '图片总像素');
    attachment.meta = { image: { image_url: attachment.url, width, height, file_size: bytesToMb(fileSize) } };
  } else if (extension === 'pdf') {
    service.output.log(`${file.name}：正在预处理 PDF`);
    const result = parse(
      z.object({
        url: urlSchema,
        parsed_file_size: numberSchema,
        parsed_page_count: numberSchema,
        agent_representation: z.enum(['native_pdf', 'text_link']).optional(),
        representation_reason: z.string().nullable().optional(),
      }),
      await preprocess(service, 'compress-pdf', {
        pdf_url: url,
        compress_level: 'medium',
        grayscale: false,
        keep_pages: [],
      }),
      'PDF 预处理',
    );
    checkSize(file, result.parsed_file_size);
    checkLimit(file, result.parsed_page_count, rule.visualCount, 'PDF 页数');
    attachment.url = result.url;
    attachment.meta = {
      parsed_visual_count: result.parsed_page_count,
      parsed_file_size: bytesToMb(result.parsed_file_size),
      agent_representation: result.agent_representation ?? 'native_pdf',
      representation_reason: result.representation_reason ?? null,
    };
  } else if (extension === 'docx') {
    service.output.log(`${file.name}：正在解析 Word 文档`);
    const result = parse(
      z.object({
        url: urlSchema.nullable().optional(),
        parsed_url: urlSchema,
        parsed_image_map: z.record(z.string()).default({}),
        parsed_file_size: numberSchema,
        parsed_text_length: numberSchema,
      }),
      await preprocess(service, 'docx-to-md', { docx_url: url }),
      'Word 预处理',
    );
    checkSize(file, result.parsed_file_size);
    const count = Object.keys(result.parsed_image_map).length;
    checkLimit(file, count, rule.visualCount, '文档图片数');
    checkLimit(file, result.parsed_text_length, rule.textLimit, '文本长度');
    attachment.url = result.url ?? result.parsed_url;
    attachment.meta = {
      parsed_url: result.parsed_url,
      parsed_image_map: result.parsed_image_map,
      parsed_visual_count: count,
      parsed_file_size: bytesToMb(result.parsed_file_size),
      parsed_text_length: result.parsed_text_length,
    };
  } else if (['xlsx', 'xls', 'csv'].includes(extension)) {
    service.output.log(`${file.name}：正在解析表格`);
    const csv = extension === 'csv';
    const result = parse(
      z.object({
        url: urlSchema.nullable().optional(),
        items: z.array(
          z
            .object({
              csv_url: urlSchema,
              row_count: numberSchema,
              rows: z.array(z.array(z.string())).optional(),
            })
            .passthrough(),
        ),
      }),
      await preprocess(
        service,
        csv ? 'csv-parse' : 'xlsx-to-csv',
        csv ? { csv_url: url } : { xlsx_url: url },
      ),
      '表格预处理',
    );
    attachment.url = result.url ?? url;
    attachment.meta = { parsed_file_size: bytesToMb(file.blob.size), csvs: result.items };
  }
  service.output.log(`${file.name}：附件已就绪`);
  return attachment;
}

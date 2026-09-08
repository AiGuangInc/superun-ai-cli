/** 进入研发前保留演示，并明确后续消息的版本归属。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import { object } from '../contracts/value.js';

const versionListSchema = z.object({
  versions: z.array(z.object({ id: z.number().int().positive() })),
  currentPreviewVersionId: z.number().int().nonnegative().nullish(),
});
const PREFIX = '/api/uxa-center/agent/SessionPreviewVersion';

export class PreviewVersionApi {
  constructor(private readonly client: ApiClient) {}
  async prepareDevelopment(sessionId: string): Promise<void> {
    const current = parseWire(
      versionListSchema,
      await this.client.call(`${PREFIX}/listPreviewVersion`, { sessionId }),
    );
    if (!current.versions.length) {
      const result = object(
        await this.client.call(
          `${PREFIX}/createPreviewVersion`,
          {
            sessionId,
            scene: 'BEFORE_DEVELOPMENT',
          },
          true,
        ),
      );
      if (typeof result.previewVersionId !== 'number' || result.previewVersionId <= 0)
        throw new CliError(
          'OUTCOME_UNKNOWN',
          '保留演示请求已返回，但未取得版本标识；请查询后确认，勿重复创建',
          { sessionId },
        );
      return;
    }
    if (current.currentPreviewVersionId && current.currentPreviewVersionId !== 0)
      await this.client.call(`${PREFIX}/switchPreviewVersion`, { sessionId, previewVersionId: 0 }, true);
  }
}

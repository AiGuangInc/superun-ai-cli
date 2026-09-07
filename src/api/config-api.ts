/** 项目创建配置、需求类型和回复语言识别。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object, text } from '../contracts/value.js';

export class ConfigApi {
  constructor(private readonly client: ApiClient) {}
  async creation(content: string): Promise<{ runtime: 'shire' | 'glow'; language: string; slides: boolean }> {
    const [config, intent, language] = await Promise.all([
      this.client
        .request('/web-api/config/app-config', undefined, { method: 'GET' })
        .then((r) => object(r.data))
        .catch(() => ({})),
      this.client
        .call('/web-api/first-message-intent/classify', { text: content })
        .then(object)
        .catch(() => ({})),
      this.client
        .call('/web-api/detect-language', { text: content })
        .then(object)
        .catch(() => ({})),
    ]);
    return {
      runtime: object(config).agentRuntime === 'shire' ? 'shire' : 'glow',
      language: text(object(language).language) ?? this.client.config.locale,
      slides: object(intent).intent === 'slides',
    };
  }
}

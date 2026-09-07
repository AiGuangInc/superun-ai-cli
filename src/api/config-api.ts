/** 项目创建时的需求类型和回复语言识别。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object, text } from '../contracts/value.js';

export class ConfigApi {
  constructor(private readonly client: ApiClient) {}
  async creation(content: string): Promise<{ language: string; slides: boolean }> {
    const [intent, language] = await Promise.all([
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
      language: text(object(language).language) ?? this.client.config.locale,
      slides: object(intent).intent === 'slides',
    };
  }
}

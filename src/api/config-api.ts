/** 项目创建时的回复语言识别。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object, text } from '../contracts/value.js';

export class ConfigApi {
  constructor(private readonly client: ApiClient) {}
  async creation(content: string): Promise<{ language: string }> {
    const language = await this.client
      .call('/web-api/detect-language', { text: content })
      .then(object)
      .catch(() => ({}));
    return {
      language: text(object(language).language) ?? this.client.config.locale,
    };
  }
}

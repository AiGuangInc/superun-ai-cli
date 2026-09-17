/** 与 Glow 插件启用表单对齐；只返回字段定义，不向展示层暴露凭据。@author xiuyu.yi */
import { list, object, text, type JsonObject } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';

const CREDENTIALS: Record<string, string[]> = {
  ASR: ['TENCENT_ASR_APP_ID', 'TENCENT_ASR_SECRET_ID', 'TENCENT_ASR_SECRET_KEY'],
  FACEID: ['TENCENT_FACE_SECRET_ID', 'TENCENT_FACE_SECRET_KEY'],
  AMAP: ['AMAP_WEB_KEY', 'AMAP_JS_KEY', 'AMAP_SECURITY_KEY'],
  SMS: ['SMS_PROVIDER', 'SMS_API_KEY', 'SMS_API_SECRET', 'SMS_SIGN_NAME'],
  DINGTALK: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_ID'],
  FEISHU: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  WECOM: ['WECOM_CORP_ID', 'WECOM_SECRET', 'WECOM_AGENT_ID'],
  STRIPE: ['STRIPE_API_KEY'],
  SUPERUN_PAYMENT: ['REAL_NAME', 'ID_CARD_NO'],
};
const OPTIONAL: Record<string, string[]> = {
  DINGTALK: ['DINGTALK_AGENT_ID'],
  STRIPE: ['STRIPE_WEBHOOK_SECRET'],
  FACEID: ['FACEID_DEFAULT_MODE', 'FACEID_LIVENESS_TYPE', 'FACEID_SCORE_THRESHOLD'],
};

function source(plugin: string, info: JsonObject): 'user' | 'platform_default' {
  if (info.source_name === 'platform_default') return 'platform_default';
  const keys = CREDENTIALS[plugin] ?? [];
  const storedKeys = list(info.keyNames);
  if (info.source_name === 'user' || keys.some((key) => text(info[key])?.trim() || storedKeys.includes(key)))
    return 'user';
  if (plugin === 'FACEID' && info.configured === true) return 'user';
  if (
    plugin === 'ASR' &&
    (['appId', 'secretId', 'secretKey'].some((key) => text(info[key])?.trim()) ||
      storedKeys.some((key) => typeof key === 'string' && key.startsWith('TENCENT_ASR_')))
  )
    return 'user';
  return 'platform_default';
}

export function pluginForm(plugin: string, status: JsonObject, suggested: JsonObject = {}) {
  const info = object(status.info);
  const hasSavedSource =
    info.source_name === 'user' || info.source_name === 'platform_default' || source(plugin, info) === 'user';
  const mode = source(plugin, hasSavedSource ? info : suggested);
  const platform = ['ASR', 'FACEID'].includes(plugin) && mode === 'platform_default';
  const restoring =
    ['DISABLED', 'PAUSED'].includes(String(status.integrationStatus)) && !['ASR', 'FACEID'].includes(plugin);
  const fields =
    status.integrationStatus === 'ENABLED' || restoring || plugin === 'SUPERUN_MANAGED_AGENT_V2' || platform
      ? []
      : [...new Set([...(CREDENTIALS[plugin] ?? Object.keys(suggested)), ...(OPTIONAL[plugin] ?? [])])];
  return {
    keys: fields,
    requiredKeys:
      plugin === 'AMAP'
        ? []
        : fields.filter(
            (key) => !(OPTIONAL[plugin] ?? []).includes(key) && !(plugin === 'SMS' && key === 'SMS_PROVIDER'),
          ),
    ...(platform ? { source: 'platform_default', notice: '默认使用平台托管通道，无需填写自有密钥。' } : {}),
    ...(plugin === 'AMAP' ? { notice: '可使用平台配置；使用自有高德密钥时需完整填写三项。' } : {}),
    ...(restoring
      ? { notice: '恢复时沿用已保存配置，无需重新填写；如需修改，请在恢复后到插件设置中处理。' }
      : {}),
  };
}

export function preparePluginConfig(
  plugin: string,
  input: JsonObject,
  status: JsonObject,
  suggested: JsonObject = {},
): JsonObject {
  if (plugin === 'SUPERUN_MANAGED_AGENT_V2') return {};
  const values = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  );
  // 通用 restore 沿用服务端已存配置；ASR、FACEID 的专用入口仍需按各自表单准备参数。
  if (
    ['DISABLED', 'PAUSED'].includes(String(status.integrationStatus)) &&
    !['ASR', 'FACEID'].includes(plugin)
  )
    return values;
  const credentials = CREDENTIALS[plugin] ?? [];
  if (
    ['ASR', 'FACEID', 'AMAP'].includes(plugin) &&
    values.source_name !== undefined &&
    !['user', 'platform_default'].includes(String(values.source_name))
  )
    throw new CliError('INVALID_ARGUMENT', 'source_name 只能是 user 或 platform_default');
  if (
    ['ASR', 'FACEID', 'AMAP'].includes(plugin) &&
    values.source_name === 'platform_default' &&
    credentials.some((key) => text(values[key]))
  )
    throw new CliError('INVALID_ARGUMENT', '平台通道与自有凭据不能同时指定，请明确使用哪一种配置');
  if (['ASR', 'FACEID'].includes(plugin)) {
    const entered = credentials.filter((key) => text(values[key]));
    const form = pluginForm(plugin, status, { ...suggested, ...values });
    if (values.source_name !== 'user' && form.source === 'platform_default' && !entered.length)
      return { source_name: 'platform_default' };
    const missing = credentials.filter((key) => !text(values[key]));
    if (missing.length)
      throw new CliError('INVALID_ARGUMENT', '使用自有凭据时请完整提供所需字段，不能自动切换为平台模式', {
        keys: missing,
      });
    return { ...values, source_name: 'user' };
  }
  if (plugin === 'AMAP') {
    const entered = credentials.filter((key) => text(values[key]));
    if (!entered.length && values.source_name !== 'user') return {};
    if (entered.length !== credentials.length)
      throw new CliError('INVALID_ARGUMENT', '自有高德密钥需完整提供三项；不填写则沿用平台或已有配置', {
        keys: credentials,
      });
    return { ...values, source_name: 'user' };
  }
  if (plugin === 'SMS') values.SMS_PROVIDER = (text(values.SMS_PROVIDER) || 'tencent').toLowerCase();
  const missing = credentials.filter((key) => !text(values[key]));
  if (missing.length)
    throw new CliError('INVALID_ARGUMENT', '请通过安全输入提供插件所需配置', { keys: missing });
  return values;
}

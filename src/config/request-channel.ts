/** 识别当前进程的请求渠道，不依赖专家团传参。@author xiuyu.yi */
const DEFAULT_REQUEST_CHANNEL = 'superun-ai-cli';

export function detectRequestChannel(env: NodeJS.ProcessEnv): string {
  // Qoder 产品标识优先于其他宿主信号，所有会话类型统一归入 qoder。
  if (env.QODER_PRODUCT_ID === 'qoder' || env.QODER_PRODUCT_ID === 'qoder-cn') return 'qoder';

  const channels: string[] = [];
  // CodeBuddy 上下文需结合 WorkBuddy 产品标识，避免混淆两个产品。
  if (
    env.WORKBUDDY_CONFIG_DIR?.trim() &&
    (env.CODEBUDDY_TOOL_CALL_ID?.trim() || env.CODEBUDDY_SESSION_ID?.trim())
  )
    channels.push('workbuddy');
  if (env.CODEX_THREAD_ID?.trim()) channels.push('codex');
  if (env.CLAUDECODE === '1') channels.push('claude-code');
  if (env.GEMINI_CLI === '1') channels.push('gemini-cli');
  if (env.QWEN_CODE === '1') channels.push('qwen-code');
  if (env.CURSOR_AGENT === '1') channels.push('cursor');
  // 豆包工作本地、云电脑和飞书 Aily 工作伙伴共用注册渠道。
  const isDoubaoWork = env.DOUBAO_OFFICE_AGENT_NAME === 'doubao_moa';
  const isAily = env.LARKSUITE_CLI_AGENT_NAME === 'aily_agent';
  if (isDoubaoWork || isAily) channels.push('doubao');
  // 未识别或多个宿主信号冲突时统一兜底，不猜测嵌套调用的归属。
  return channels.length === 1 ? channels[0]! : DEFAULT_REQUEST_CHANNEL;
}

// 每个 CLI 进程只计算一次，PAT 默认名称和业务请求共用同一结果。
export const requestChannel = detectRequestChannel(process.env);

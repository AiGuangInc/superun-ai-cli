/** 与 Glow origin/pre 29112fe11d 同源的技能协议及两种完整接入指令。@author xiuyu.yi */
import type { ChatInput } from '../api/agent-command-api.js';
import { AGENT_FRIENDLY_SKILL_ID } from '../api/agent-friendly-api.js';

export type AgentFriendlyMethod = 'skill' | 'connector';
export const AGENT_FRIENDLY_DESCRIPTION =
  '让你的 AI 应用使用这个项目，可以把项目连接到你正在使用的 AI 应用，通过对话查询数据、使用项目功能。';

export function agentFriendlyChat(sessionId: string): ChatInput {
  return {
    sessionId,
    content: [
      '<command-message>连接 AI 应用</command-message>',
      `<command-name>${AGENT_FRIENDLY_SKILL_ID}</command-name>`,
      '<command-args>请生成「连接 AI 应用」：按照该技能的 SOP 为当前项目准备技能和连接器两种接入方式，并在完成后将该技能状态更新为 ENABLED。</command-args>',
      '<command-type>skill</command-type>',
    ].join('\n'),
    roundExtra: { special_skill_scope: 'official' },
    businessParams: {
      skill_display: {
        skillId: AGENT_FRIENDLY_SKILL_ID,
        name: '连接 AI 应用',
        category: 'technical',
        description: '连接常用的 AI 应用，并在其中使用 superun 部分功能、查询数据。',
      },
    },
  };
}

const SKILL_PROMPT =
  '请把这个 superun 项目作为一个技能接入你当前所在的AI应用，并完成一次真实查询验证。\n\n请按顺序执行：\n1. 先确认当前应用支持安装或导入技能；如果不支持，请明确告诉我，不要声称已经接入。\n2. 确认本机有 Node.js 20 或更高版本，然后执行：\n{{installCommand}}\n3. 先检查项目是否已经存在：\n{{inspectCommand}}\n只有明确提示项目未注册或不存在时，才执行：\n{{initCommand}}\n不要重复初始化已有项目。\n4. 完成登录并刷新项目能力：\n{{loginCommand}}\n{{refreshCommand}}\n5. 从 {{skillUrl}} 下载技能说明，安装到当前应用的技能目录中。保留已有其他技能，不要覆盖无关文件。\n6. 按技能说明执行一次只读的真实项目查询。只有拿到真实结果后才告诉我接入成功；如果失败，请说明失败步骤和错误信息。';
const CONNECTOR_PROMPT =
  '请把这个 superun 项目接入你当前所在的智能体或 MCP 客户端，并用一次真实查询确认连接成功。先确认当前客户端支持运行本地 MCP 服务（stdio）；如果不支持，请直接说明，不能假装接入成功。然后按以下步骤执行：\n\n1. 检查 Node.js 版本为 20 或更高，然后安装 CLI：\n{{installCommand}}\n\n2. 先检查这个项目是否已经注册：\n{{inspectCommand}}\n如果命令成功，复用现有项目配置，不要重复执行 init，以免覆盖已有设置。只有明确提示项目未注册或不存在时，才执行：\n{{initCommand}}\n初始化后再次运行上述 app show 命令，并记录返回的 id（如有）。\n\n3. 使用浏览器登录：\n{{loginCommand}}\n请让我在浏览器中完成授权，不要要求我在对话中粘贴 access token 或 refresh token。\n\n4. 优先使用当前客户端自带的 MCP 设置页面或命令。如果必须修改配置文件，先确认该客户端官方规定的配置位置和格式，再把下面的本地 MCP 服务参数合并进去；如果客户端使用 mcpServers 结构，可以直接采用下面的配置，否则请转换成作用相同的格式。必须保留已有的其他 MCP 服务，不要覆盖整个配置。如果 app show 返回 id，优先使用该 id 替换下方 args 中 --app 后的名称；如果当前客户端找不到 superun 命令，请先找到它的绝对路径再写入：\n{{mcpConfig}}\n\n5. 让客户端重新加载 MCP 服务并确认已经发现可用工具，然后实际调用 project_status，再执行一次只读项目查询。只有真实查询成功后，才告诉我配置完成；失败时请保留原配置并说明具体原因。不要开启不受限制的高权限模式。每次调用 call_function 前，先展示具体函数名和参数并等待我明确确认；只有确认后才将 userConfirmed 设为 true，未确认不得调用。';

/** 保留 Glow 的命令形状，转义项目名中的 Shell 特殊字符。 */
function shellName(name: string): string {
  return '"' + name.replace(/[\\"$`]/g, '\\$&') + '"';
}

export function agentFriendlyPrompt(
  method: AgentFriendlyMethod,
  connection: {
    appName: string;
    supabaseUrl: string;
    anonKey: string;
    manifestUrl: string;
  },
): string {
  const { appName, supabaseUrl, anonKey, manifestUrl } = connection;
  const app = `superun --app ${shellName(appName)} --env production`;
  const login = `${app} login --browser`;
  const refresh = `${app} app refresh`;
  const serverName = `superun-${
    appName
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  }`;
  const values: Record<string, string> = {
    installCommand: 'npm install -g superun-cli',
    inspectCommand: `${app} app show`,
    initCommand: `superun init --name ${shellName(appName)} --url ${supabaseUrl} --anon-key ${anonKey} --manifest ${manifestUrl} --environment production`,
    loginCommand: method === 'skill' ? login : `${login}\n${refresh}`,
    refreshCommand: refresh,
    skillUrl: 'https://raw.githubusercontent.com/AiGuangInc/superun-cli/main/skills/superun/SKILL.md',
    mcpConfig: JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            type: 'stdio',
            command: 'superun',
            args: ['--app', appName, '--env', 'production', 'mcp'],
          },
        },
      },
      null,
      2,
    ),
  };
  return (method === 'skill' ? SKILL_PROMPT : CONNECTOR_PROMPT).replace(
    /{{(\w+)}}/g,
    (_, key: string) => values[key]!,
  );
}

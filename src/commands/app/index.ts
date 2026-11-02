/** App 命令入口，平台参数只由对应专家固定传入。@author xiuyu.yi */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Command, Option } from 'commander';
import { z } from 'zod';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, pollOperation } from '../shared.js';
import { AppService } from '../../app/service.js';
import { platformSchema, appIdFields, accountSchema } from '../../app/contracts.js';
import { installApp } from '../../app/install.js';
import { appGuidance } from '../../app/guidance.js';
import { CliError } from '../../output/exit-codes.js';
import { parseWire } from '../../contracts/node-wire.js';
import { object, text } from '../../contracts/value.js';

const contentSchema = z.object({ content: z.string().trim().min(1) }).strict();
const signingSubjectSchema = z
  .object({
    commonName: z.string().trim().min(1).max(64),
    country: z.string().regex(/^[A-Za-z]{2}$/),
    organization: z.string().max(64).optional(),
    organizationalUnit: z.string().max(64).optional(),
    locality: z.string().max(64).optional(),
    state: z.string().max(64).optional(),
  })
  .strict();
const target = (command: Command) =>
  command.addOption(
    new Option('--platform <platform>', '本专家固定的目标平台')
      .choices(['android', 'harmony', 'ios'])
      .makeOptionMandatory(),
  );
const input = (command: Command) =>
  command.requiredOption('--input <file>', '输入 JSON 文件，- 表示标准输入');
const timeout = (command: Command) =>
  command.option('--timeout <seconds>', '本地等待秒数，超时后继续查询原任务', '60');
function limit(value: unknown, max = 200) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new CliError('INVALID_ARGUMENT', `数值须为 1–${max} 的整数`);
  return number;
}
export function registerApp(program: Command, context: CommandContext) {
  const app = program.command('app').description('App 专属咨询、适配、配置、云打包与安装交付');
  const service = async (sessionId: string, command: Command) =>
    new AppService(await runtime(context, command), sessionId, platformSchema.parse(command.opts().platform));
  const read = async (command: Command) => readInput(String(command.opts().input));

  target(app.command('status <sessionId>').description('只读查询本平台 App 准备状态和后续动作')).action(
    async (sid, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).prepare());
    },
  );
  target(app.command('prepare <sessionId>').description('汇总上线、应用、账号、签名和设备的真实缺项'))
    .addOption(new Option('--build-type <type>', '本次包类型').choices(['debug', 'release']).default('debug'))
    .action(async (sid, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).prepare(cmd.opts().buildType));
    });
  target(app.command('guidance <sessionId>').description('查看当前专家平台的账号与签名准备说明'))
    .addOption(new Option('--build-type <type>', '包类型').choices(['debug', 'release']).default('debug'))
    .action(async (sid, _options, cmd) => {
      const appService = await service(sid, cmd);
      await appService.api.config(sid);
      context.output.write({
        state: 'COMPLETED',
        sessionId: sid,
        guidance: appGuidance(appService.platform, cmd.opts().buildType),
      });
    });

  const consult = app.command('consult').description('在原项目中咨询 App 适配，继续咨询不进入研发');
  target(consult.command('start <sessionId>').description('本轮研发完成后发起或复用适配咨询'))
    .option('--source-message-id <messageId>', '本次已完成研发的真实消息来源')
    .option('--retry-failed <consultId>', '用户主动重试本次明确失败或中断的咨询')
    .action(async (sid, _options, cmd) => {
      context.output.write(
        await (await service(sid, cmd)).startConsultation(cmd.opts().sourceMessageId, cmd.opts().retryFailed),
      );
    });
  timeout(target(consult.command('status <sessionId> [consultId]').description('查询本次咨询，按原线程等待')))
    .option('--wait', '等待本次咨询结束或超时')
    .action(async (sid, id, _options, cmd) => {
      const appService = await service(sid, cmd);
      const result = cmd.opts().wait
        ? await pollOperation(
            () => appService.consultation(id),
            (result) => !['RUNNING', 'QUEUED', 'ACCEPTED'].includes(result.state),
            { timeout: limit(cmd.opts().timeout, 600), signal: context.signal },
          )
        : await appService.consultation(id);
      context.output.write(result);
    });
  input(
    target(consult.command('send <sessionId> <consultId>').description('把具体问题或修改意见续接到原咨询')),
  ).action(async (sid, id, _options, cmd) => {
    context.output.write(
      await (
        await service(sid, cmd)
      ).continueConsultation(id, parseWire(contentSchema, await read(cmd)).content),
    );
  });

  const plan = app.command('plan').description('展示实际咨询规划，确认后才进入适配执行');
  target(
    plan.command('get <sessionId> <consultId>').description('读取并记录当前向用户展示的真实规划'),
  ).action(async (sid, id, _options, cmd) => {
    context.output.write(await (await service(sid, cmd)).plan(id));
  });
  target(
    plan
      .command('execute <sessionId> <consultId>')
      .description('确认当前规划后按官方 plan_execution 合同执行'),
  )
    .requiredOption('--plan-fingerprint <hash>', '刚向用户展示并获确认的规划摘要')
    .option(
      '--feature-id <id>',
      '用户明确选择的真实条目 ID，可重复；省略表示执行已确认的整份规划',
      (value: string, previous: number[]) => [...previous, limit(value, Number.MAX_SAFE_INTEGER)],
      [],
    )
    .action(async (sid, id, _options, cmd) => {
      const ids = cmd.opts().featureId as number[];
      context.output.write(
        await (
          await service(sid, cmd)
        ).executePlan(id, cmd.opts().planFingerprint, ids.length ? ids : undefined),
      );
    });
  timeout(target(plan.command('wait <sessionId>').description('等待本次适配执行，不重复咨询或交接'))).action(
    async (sid, _options, cmd) => {
      context.output.write(
        await (await service(sid, cmd)).executionStatus(true, limit(cmd.opts().timeout, 600)),
      );
    },
  );

  const config = app.command('config').description('只读确认或修改当前平台应用信息');
  target(
    config.command('get <sessionId>').description('展示当前名称、图标及本平台应用 ID 并询问如何处理'),
  ).action(async (sid, _options, cmd) => {
    context.output.write(await (await service(sid, cmd)).config());
  });
  input(target(config.command('set <sessionId>').description('仅保存本次提供的应用信息字段'))).action(
    async (sid, _options, cmd) => {
      const data = parseWire(
        z
          .object({
            appName: z.string().trim().min(1).optional(),
            iconUrl: z.union([z.string().url(), z.literal('')]).optional(),
            appId: z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/)
              .optional(),
          })
          .strict(),
        await read(cmd),
      );
      if (!Object.keys(data).length) throw new CliError('INVALID_ARGUMENT', '请提供本次要修改的应用信息');
      const appService = await service(sid, cmd);
      const { appId, ...fields } = data;
      await appService.api.call(
        'saveAppConfig',
        { sessionId: sid, ...fields, ...(appId ? { [appIdFields[appService.platform]]: appId } : {}) },
        true,
      );
      context.output.write(await appService.prepare());
    },
  );
  const signing = app.command('signing').description('配置首次安卓正式签名主体；体验包无需此项');
  input(target(signing.command('set <sessionId>').description('保存正式签名的主体信息'))).action(
    async (sid, _options, cmd) => {
      const appService = await service(sid, cmd);
      if (appService.platform !== 'android')
        throw new CliError(
          'INVALID_ARGUMENT',
          '鸿蒙和 iOS 通过自己的开发者账号准备签名，不使用安卓签名主体接口',
        );
      await appService.api.call(
        'saveAndroidSigningSubject',
        { sessionId: sid, signingSubject: parseWire(signingSubjectSchema, await read(cmd)) },
        true,
      );
      context.output.write(await appService.prepare('release'));
    },
  );

  const account = app.command('account').description('由项目主人连接自己的开发者账号，不回显凭据');
  target(
    account
      .command('connect <sessionId>')
      .description('从原始 .p8 或开发者级 Service Account 文件读取并验证账号'),
  )
    .option('--issuer-id <id>', '苹果 Issuer ID')
    .option('--key-id <id>', '苹果 Key ID')
    .option('--key-file <file>', '苹果原始 .p8 文件路径')
    .option('--service-account-file <file>', '华为开发者级原始 JSON 文件路径')
    .action(async (sid, _options, cmd) => {
      const appService = await service(sid, cmd),
        options = cmd.opts();
      if (appService.platform === 'android')
        throw new CliError('INVALID_ARGUMENT', '安卓手机体验包无需连接应用商店开发者账号');
      const file = appService.platform === 'ios' ? options.keyFile : options.serviceAccountFile;
      if (typeof file !== 'string') throw new CliError('INVALID_ARGUMENT', '请先按指导提供原始凭据文件路径');
      const expectedExtension = appService.platform === 'ios' ? '.p8' : '.json';
      if (extname(file).toLowerCase() !== expectedExtension)
        throw new CliError('INVALID_ARGUMENT', `请选择原始 ${expectedExtension} 文件`);
      const bytes = await readFile(file);
      if (bytes.length > 64 * 1024) throw new CliError('INVALID_ARGUMENT', '凭据文件不能超过 64 KB');
      const value = bytes
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();
      context.output.registerSecret(value);
      let payload: Record<string, unknown>;
      if (appService.platform === 'ios') {
        if (
          !text(options.issuerId) ||
          !text(options.keyId) ||
          !/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----$/.test(value)
        )
          throw new CliError('INVALID_ARGUMENT', '请提供 Issuer ID、Key ID 和 Apple 下载的原始 .p8 私钥文件');
        payload = { issuerId: options.issuerId, keyId: options.keyId, privateKey: value };
      } else {
        let json: unknown;
        try {
          json = JSON.parse(value);
        } catch {
          throw new CliError('INVALID_ARGUMENT', 'Service Account 文件不是有效 JSON');
        }
        const credential = parseWire(
          z
            .object({
              key_id: z.string().min(1),
              private_key: z.string().min(1),
              sub_account: z.string().min(1),
              project_id: z.literal(''),
            })
            .passthrough(),
          json,
        );
        context.output.registerSecret(credential.private_key);
        payload = { serviceAccountJson: value };
      }
      const connected = parseWire(
        accountSchema,
        await appService.api.call(
          'saveDeveloperAccount',
          { sessionId: sid, platform: appService.platform, ...payload },
          true,
        ),
      );
      if (connected.platform !== appService.platform || !connected.connected)
        throw new CliError('PROTOCOL_ERROR', '账号连接回执尚未确认本平台已连接，请重新检查账号状态');
      context.output.write({
        state: 'COMPLETED',
        sessionId: sid,
        platform: appService.platform,
        account: connected,
        nextAction: '账号已经过接口验证，请继续读取并配置真实应用和测试手机；不用重复提供凭据。',
      });
    });

  const devices = app.command('devices').description('读取、登记与选择当前平台真实测试手机');
  const deviceService = async (sid: string, cmd: Command) => {
    const appService = await service(sid, cmd);
    if (appService.platform === 'android')
      throw new CliError('INVALID_ARGUMENT', '安卓体验包无需登记测试设备');
    const account = (await appService.api.accounts(sid)).find(
      (item) => item.platform === appService.platform,
    );
    if (!account) throw new CliError('PROTOCOL_ERROR', '接口未返回本平台账号状态，请重新查询');
    if (!account.connected)
      throw new CliError('INVALID_ARGUMENT', '请先连接自己的开发者账号，连接成功后再查询或配置测试手机', {
        guidance: appGuidance(appService.platform),
      });
    return appService;
  };
  target(devices.command('list <sessionId>').description('读取账号下可用的测试手机与匹配应用')).action(
    async (sid, _options, cmd) => {
      const appService = await deviceService(sid, cmd),
        config = await appService.api.config(sid);
      context.output.write({
        state: 'COMPLETED',
        sessionId: sid,
        platform: appService.platform,
        options: await appService.api.devices(
          sid,
          appService.platform,
          config[appIdFields[appService.platform]],
        ),
        guidance: appGuidance(appService.platform),
      });
    },
  );
  input(
    target(devices.command('register <sessionId>').description('按用户提供的真实 UDID 登记测试手机')),
  ).action(async (sid, _options, cmd) => {
    const data = parseWire(
      z.object({ udid: z.string().trim().min(1), deviceName: z.string().trim().min(1) }).strict(),
      await read(cmd),
    );
    const appService = await deviceService(sid, cmd);
    const device = parseWire(
      z.object({ id: z.string(), name: z.string() }),
      await appService.api.call(
        appService.platform === 'ios' ? 'registerIosDevice' : 'registerHarmonyDevice',
        { sessionId: sid, ...data },
        true,
      ),
    );
    context.output.write({
      state: 'COMPLETED',
      sessionId: sid,
      platform: appService.platform,
      device,
      notice: '设备已登记，仍需由用户明确选择并保存本次测试设备。',
    });
  });
  input(
    target(devices.command('select <sessionId>').description('保存用户明确选择的真实应用与测试手机 ID')),
  ).action(async (sid, _options, cmd) => {
    const data = parseWire(
      z.object({ testDeviceIds: z.array(z.string()).max(100), agcAppId: z.string().optional() }).strict(),
      await read(cmd),
    );
    if (new Set(data.testDeviceIds).size !== data.testDeviceIds.length)
      throw new CliError('INVALID_ARGUMENT', '测试设备 ID 不能重复');
    const appService = await deviceService(sid, cmd),
      config = await appService.api.config(sid);
    const options = await appService.api.devices(
      sid,
      appService.platform,
      config[appIdFields[appService.platform]],
    );
    if (data.testDeviceIds.some((id) => !options.devices.some((device) => device.id === id)))
      throw new CliError('INVALID_ARGUMENT', '设备选择包含当前真实列表之外的 ID');
    if (appService.platform === 'harmony' && !options.apps?.some((app) => app.id === data.agcAppId))
      throw new CliError('INVALID_ARGUMENT', '请选择与当前包名匹配的真实 AGC 应用');
    await appService.api.call(
      appService.platform === 'ios' ? 'saveIosBuildConfig' : 'saveHarmonyBuildConfig',
      {
        sessionId: sid,
        testDeviceIds: data.testDeviceIds,
        ...(appService.platform === 'harmony' ? { agcAppId: data.agcAppId } : {}),
      },
      true,
    );
    context.output.write(await appService.prepare());
  });

  target(app.command('build <sessionId>').description('适配并上线后提交本平台云构建，默认手机体验包'))
    .addOption(new Option('--build-type <type>', '包类型').choices(['debug', 'release']).default('debug'))
    .addOption(
      new Option('--version-bump <bump>', '正式包版本升级方式')
        .choices(['none', 'patch', 'minor', 'major'])
        .default('none'),
    )
    .option('--acknowledge-store-upload', '用户已知晓并明确要求鸿蒙/iOS 商店包生成后上传第三方')
    .action(async (sid, _options, cmd) => {
      context.output.write(
        await (
          await service(sid, cmd)
        ).build(cmd.opts().buildType, cmd.opts().versionBump, cmd.opts().acknowledgeStoreUpload === true),
      );
    });
  timeout(
    target(app.command('wait <sessionId> [taskId]').description('查询并等待原打包任务，不重复提交')),
  ).action(async (sid, id, _options, cmd) => {
    const appService = await service(sid, cmd);
    context.output.write(
      await pollOperation(
        () => appService.buildStatus(id),
        (result) => !['RUNNING', 'ACCEPTED', 'QUEUED'].includes(result.state),
        { timeout: limit(cmd.opts().timeout, 600), signal: context.signal },
      ),
    );
  });
  target(
    app.command('install <sessionId> <taskId>').description('交付本次真实安装页、二维码和可读取的包文件'),
  )
    .option('--out <file>', '本地二维码 PNG 路径；默认写入独立 App 交付目录')
    .action(async (sid, id, _options, cmd) => {
      context.output.write(await installApp(await service(sid, cmd), id, cmd.opts().out));
    });

  const history = app.command('history').description('只读查看当前项目和平台的最近历史包，不重新打包');
  target(history.command('list <sessionId>').description('查看实际返回范围内的历史记录'))
    .option('--limit <count>', '最近记录数量，默认 50，最多 200；接口另补最近成功入口', '50')
    .action(async (sid, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).history(limit(cmd.opts().limit)));
    });
  target(history.command('get <sessionId> <taskId>').description('读取当前授权列表中指定包的详情')).action(
    async (sid, id, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).history(200, id));
    },
  );
  const filing = app.command('filing').description('查询实际备案材料及其来源正式版本');
  target(filing.command('get <sessionId>').description('展示当前平台可用的备案资料和未就绪原因')).action(
    async (sid, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).filing());
    },
  );
  const upload = app.command('upload').description('查询或主动重试已成功商店包的第三方上传');
  target(upload.command('status <sessionId> <taskId>').description('查看原包实际上传状态')).action(
    async (sid, id, _options, cmd) => {
      context.output.write(await (await service(sid, cmd)).history(200, id));
    },
  );
  target(
    upload.command('retry <sessionId> <taskId>').description('用户要求后重试原成功包上传，不重新构建'),
  ).action(async (sid, id, _options, cmd) => {
    const appService = await service(sid, cmd);
    if (appService.platform === 'android')
      throw new CliError('INVALID_ARGUMENT', '当前没有安卓应用商店自动上传通道');
    const record = (await appService.api.builds(sid, appService.platform)).find((item) => item.taskId === id);
    if (!record || record.buildStatus !== 1 || record.buildType !== 'release')
      throw new CliError('INVALID_ARGUMENT', '只有本项目本平台的成功应用商店包可重试上传');
    const channel = appService.platform === 'ios' ? 'app_store_connect' : 'appgallery_connect';
    const result = await appService.api.call(
      'uploadAppPackage',
      { sessionId: sid, taskId: id, channel },
      true,
    );
    context.output.write({
      state: 'ACCEPTED',
      sessionId: sid,
      platform: appService.platform,
      taskId: id,
      upload: result,
      notice: '继续读取原包上传状态；上传完成不等于审核或邀请测试已就绪。',
    });
  });
}

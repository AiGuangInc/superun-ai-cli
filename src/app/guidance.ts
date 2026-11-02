/** 对照 Glow 配置页维护的 App 专属引导。@author xiuyu.yi */
import type { AppPlatform } from './contracts.js';

export function appGuidance(platform: AppPlatform, buildType: 'debug' | 'release' = 'debug') {
  const common = {
    checkedAt: '2026-10-30',
    platform,
    buildType,
    applicationInfo:
      '请确认应用名称、图标和应用 ID。名称和图标由当前项目各平台共用，应用 ID 只对应当前平台；更改 ID 后无法覆盖安装旧包，保存后用于下一次打包。',
    publication: '只有上线运营成功后，才能进行 App 打包。',
    credentialInput: '由项目主人通过本地文件提供凭据，CLI 直接读取并验证，不要把私钥或文件正文粘贴到对话中。',
  };
  if (platform === 'android')
    return {
      ...common,
      title: buildType === 'debug' ? '准备安卓手机体验包' : '准备安卓应用商店包',
      explanation:
        buildType === 'debug'
          ? '手机体验包使用默认调试签名，无需连接应用商店开发者账号或配置正式证书。'
          : '首次正式打包需要签名主体信息，superun 将生成并保管签名证书，后续更新继续复用。',
      steps:
        buildType === 'debug'
          ? ['确认应用信息后生成体验包，用安卓手机扫码下载安装。']
          : [
              '填写并保存姓名或主体名称、两位国家代码；组织、部门、省市可选。',
              '生成正式签名包后，建议通过 Glow 导出签名备份并妥善保存。',
            ],
    };
  if (platform === 'harmony')
    return {
      ...common,
      title: '连接华为开发者账号',
      explanation: '需要你自己的华为开发者账号，平台据此准备签名证书和 Profile。',
      steps: [
        { text: '注册华为开发者账号并完成实名认证。', url: 'https://developer.huawei.com/consumer/cn/' },
        {
          text: '在 AGC 的 Connect API 创建开发者级 Service Account，授权证书、Profile、设备及应用访问权限，下载原始 JSON；不能使用项目级凭据。',
          url: 'https://developer.huawei.com/consumer/cn/doc/app/agc-help-connect-api-obtain-server-auth-0000002271134661#section17426104123117',
        },
        { text: '提供 JSON 文件路径，由账号连接命令验证并保存。' },
        {
          text: '关联与当前包名一致的 AGC 应用。',
          url: 'https://developer.huawei.com/consumer/cn/service/josp/agc/index.html',
        },
        {
          text:
            buildType === 'debug'
              ? '添加并选择本次测试手机；新增手机后需重新打包。'
              : '正式包无需选择测试手机，生成后会自动上传至华为。',
        },
      ],
      deviceHelp:
        '可在 superun 桌面端连接鸿蒙手机并允许 USB 调试，登记后返回重新读取名单；CLI 也支持提交你已取得的真实 UDID。',
      installation: '使用本次已选的测试手机，在华为浏览器打开安装页。',
    };
  return {
    ...common,
    title: '连接 Apple 开发者账号',
    explanation: '需要你自己的 Apple 开发者账号，平台据此准备签名和测试设备的 Profile。',
    steps: [
      {
        text: '加入 Apple Developer Program。会员费由 Apple 收取，标准为 99 USD/年，地区价格和适用减免以官网为准。',
        url: 'https://developer.apple.com/programs/enroll/',
      },
      {
        text: '在 App Store Connect 的“用户和访问 → 集成 → 团队密钥”创建密钥，按当前 Glow 指引选择 Admin 权限，下载 .p8。',
        url: 'https://appstoreconnect.apple.com/access/integrations/api',
      },
      { text: '准备 Issuer ID、Key ID 和 .p8 文件路径，通过连接命令验证并保存；已有材料可以直接复用。' },
      {
        text:
          buildType === 'debug'
            ? '添加并选择本次测试 iPhone，仅所选设备可安装。'
            : '在 App Store Connect 创建与当前 Bundle ID 对应的应用，正式包生成后自动上传至苹果。',
        url: 'https://appstoreconnect.apple.com/apps',
      },
    ],
    deviceHelp: '可以填写 UDID，或在 Mac 版 superun 中连接、解锁并信任电脑后识别手机。',
    installation: '使用本次已选的 iPhone，在 Safari 中打开安装页并确认系统安装提示。',
  };
}

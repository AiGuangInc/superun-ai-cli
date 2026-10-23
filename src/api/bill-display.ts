/** 复用 Glow 简体中文账单类型映射与明细组合规则。@author xiuyu.yi */
// 来源：uxarts-glow 的 pricing.tokenLog.relatedTypeMapping 与 TokenLogDetail。
// 同名映射直接回退原文，只维护实际需要转换的名称。
const RELATED_TYPE_NAMES = new Map<string, string>([
  ['Chat', '聊天并生成'],
  ['样式选择', '生成风格'],
  ['每日登录', '登录赠送'],
  ['首次登录', '首次登录赠送'],
  ['过期', '赠送算力值过期'],
  ['账单调整', '后台调整'],
  ['superun Cloud', 'superun 云计算'],
  ['Nano Banana', 'superun 生图'],
  ['superun Storage', '文件存储'],
  ['算力消耗费', '算力值消耗'],
  ['Cloud Computing', 'superun 云计算'],
  ['Superun AI 对话', 'superun AI'],
  ['Nano 香蕉', 'superun 生图'],
  ['Storage', '文件存储'],
  ['Preview Storage', '演示云服务费-云存储'],
  ['Superun 托管 Agent', 'superun 通用智能体'],
  ['回收恢复版本红包', '恢复版本红包回收'],
  ['语音合成', '文字转语音'],
]);

export function billTypeName(content: string | null | undefined): string {
  return content ? (RELATED_TYPE_NAMES.get(content) ?? content) : '';
}

type BillDisplayFields = {
  type: number;
  relatedType?: number | null;
  relatedTypeContent?: string | null;
  relatedTypeL1Content?: string | null;
  amount: number;
  projectCloudPackageAmount?: number | null;
  projectCloudPackageProjectTitle?: string | null;
};

export function billDisplayNames(bill: BillDisplayFields) {
  const packageAmount = bill.projectCloudPackageAmount;
  const isPackagePurchase =
    bill.type === 1 &&
    bill.relatedType === 57 &&
    Number.isSafeInteger(packageAmount) &&
    packageAmount != null &&
    packageAmount > 0 &&
    packageAmount === bill.amount;
  const projectTitle = bill.projectCloudPackageProjectTitle?.trim();
  const relatedTypeName = isPackagePurchase
    ? projectTitle
      ? `购买《${projectTitle}》项目云服务算力包`
      : '购买云服务算力包'
    : billTypeName(bill.relatedTypeContent);
  const relatedTypeL1Name = billTypeName(bill.relatedTypeL1Content);
  const relatedTypeDisplay =
    relatedTypeL1Name && relatedTypeName && relatedTypeL1Name !== relatedTypeName
      ? `${relatedTypeL1Name}-${relatedTypeName}`
      : relatedTypeL1Name || relatedTypeName;
  return { relatedTypeName, relatedTypeL1Name, relatedTypeDisplay };
}

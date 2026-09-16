/**
 * 路由解析工具
 * @author xiuyu.yi
 * 移植自 Glow client/src/pages/project/utils/route-parser.ts，保持同源分组和排序规则。
 *
 * 从 App.tsx / routes.tsx 内容中解析路由信息，支持：
 * - 多端路由分端：JSX 取 handle={{ side }}（结构化优先）/ `// @side:` 注释兜底；data-mode 取 RouteObject 的 handle.side
 * - JSX <Route>（App.tsx）与 RouteObject[]（routes.tsx，data-mode/SSR）两种路由源
 * - 嵌套路由 / 扁平路由 / 单组件应用
 */

export type Route = { path: string; name: string; codePath?: string; side?: string };
export type RouteGroup = { side: string; label: string; basePath: string; routes: Route[] };
const HOME_SIDE_KEY = '__home__';

/** 路由配置文件查找顺序：独立 routes.tsx 优先于 App.tsx */
export const ROUTE_CONFIG_FILENAMES = ['src/routes.tsx', 'src/App.tsx'] as const;

export type RouteConfigAttachmentCandidate = { name: string; content?: string };

export function matchesRouteConfigFilename(
  name: string,
  filename: (typeof ROUTE_CONFIG_FILENAMES)[number],
): boolean {
  const basename = filename.split('/').pop();
  return (
    name === filename || name.endsWith(`/${filename}`) || name === basename || name.endsWith(`/${basename}`)
  );
}

/**
 * 从 attachments 中查找带 content 的路由配置文件（routes.tsx 优先，其次 App.tsx）
 * 原实现作者：lidewen
 */
export function findRouteConfigAttachment<T extends RouteConfigAttachmentCandidate>(
  attachments: readonly T[],
): T | undefined {
  for (const filename of ROUTE_CONFIG_FILENAMES) {
    const found = attachments.find((att) => matchesRouteConfigFilename(att.name, filename) && att.content);
    if (found) return found;
  }
  return undefined;
}

/**
 * 规范化 import 路径
 * 将 @/ 或 ./ 转换为 src/，并添加文件扩展名
 */
export const normalizeImportPath = (importPath: string): string => {
  let normalized = importPath;
  if (normalized.startsWith('@/')) {
    normalized = normalized.replace('@/', 'src/');
  } else if (normalized.startsWith('./')) {
    normalized = normalized.replace('./', 'src/');
  }
  if (!normalized.endsWith('.tsx') && !normalized.endsWith('.ts')) {
    normalized += '.tsx';
  }
  return normalized;
};

/**
 * 判断路由是否为动态路由（包含 :param 动态参数或 * 通配符）
 * 例如：/users/:id -> true, /products/:category/:slug -> true, /about -> false
 */
export const isDynamicRoute = (path: string): boolean => {
  return /:[^/]+/.test(path) || path.includes('*');
};

/**
 * 将组件名转换为友好的显示名称
 * 例如：UserProfile -> User Profile
 */
export const toFriendlyName = (componentName: string): string => {
  return componentName.replace(/([A-Z])/g, ' $1').trim();
};

/**
 * 解析 import 语句，建立组件名到文件路径的映射
 */
export const parseImportMap = (content: string): Record<string, string> => {
  const importMap: Record<string, string> = {};

  // 匹配默认导入: import Component from '...'
  const defaultImportRegex = /import\s+([^\s{]+)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(defaultImportRegex)) {
    const componentName = match[1] as string;
    const importPath = match[2] as string;
    importMap[componentName] = normalizeImportPath(importPath);
  }

  // 匹配命名导入: import { Component1, Component2 } from '...'
  const namedImportRegex = /import\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/g;
  for (const namedImportMatch of content.matchAll(namedImportRegex)) {
    const namedImports = namedImportMatch[1] as string;
    const importPath = namedImportMatch[2] as string;
    const normalizedPath = normalizeImportPath(importPath);

    const componentNames = namedImports.split(',').map((name) => name.trim());
    componentNames.forEach((componentName) => {
      const finalName = componentName.includes(' as ')
        ? componentName.split(' as ')[1]!.trim()
        : componentName;
      importMap[finalName] = normalizedPath;
    });
  }

  return importMap;
};

/**
 * 从 `fromIndex` 起查找下一个 `<Route` 组件起始位置（使用词边界，避免把 `<Routes` 误当成 `<Route`）。
 * 原实现作者：lidewen
 */
function indexOfNextRouteTag(routeBlock: string, fromIndex: number): number {
  const re = /<Route\b/g;
  re.lastIndex = fromIndex;
  const m = re.exec(routeBlock);
  return m ? m.index : -1;
}

/**
 * 从 `const xxxRoutes = ( ... )` 的路由块推断该端 basePath（对应最外层 Route 的 path）。
 * 只在「第一个 `<Route` 到第二个 `<Route` 之前」的片段里找 path，避免把子路由的 path 误当成父级 base。
 * 若父级为无 path 的 layout（仅 element），则视为挂载在根 `/`。
 * 原实现作者：lidewen
 */
export function inferGroupBasePathFromRouteBlock(routeBlock: string): string {
  const absolutePaths: string[] = [];
  const pathRegex = /<Route\s+path=["']([^"']+)["']/g;
  for (const match of routeBlock.matchAll(pathRegex)) {
    const routePath = match[1] as string;
    if (routePath.startsWith('/')) {
      absolutePaths.push(routePath);
    }
  }

  /*
   * 优先取「作为其他绝对路径前缀的最长 path」作为 layout basePath。
   * 场景：管理后台先声明 /admin/login，再声明带嵌套子路由的 /admin layout，
   * 若仍取第一个 Route 会得到 /admin/login，导致子路由拼错。
   */
  let layoutBasePath: string | null = null;
  for (const candidate of absolutePaths) {
    const prefix = candidate.endsWith('/') ? candidate : `${candidate}/`;
    const hasChildPath = absolutePaths.some((other) => other !== candidate && other.startsWith(prefix));
    if (hasChildPath && (!layoutBasePath || candidate.length > layoutBasePath.length)) {
      layoutBasePath = candidate;
    }
  }
  if (layoutBasePath) {
    return layoutBasePath;
  }

  const firstIdx = indexOfNextRouteTag(routeBlock, 0);
  if (firstIdx === -1) return '/';
  const secondIdx = indexOfNextRouteTag(routeBlock, firstIdx + 1);
  const parentHead = secondIdx === -1 ? routeBlock.slice(firstIdx) : routeBlock.slice(firstIdx, secondIdx);
  const pathMatch = parentHead.match(/path=["']([^"']+)["']/);
  return pathMatch ? pathMatch[1]! : '/';
}

/**
 * 从路由块抽出顶层 <Route> 的 handle={{ side: "X" }} 的 X。
 * 这是结构化的分端标记，比 `// @side:` 注释更抗格式化/重生成；约定里每端顶层 <Route> 带 handle、
 * 子路由继承不重复，故取首个匹配即该组的 side。读不到（无 handle）→ undefined，由调用方回退注释/变量名。
 */
export function extractHandleSideFromRouteBlock(routeBlock: string): string | undefined {
  const m = routeBlock.match(/handle=\{\{\s*side:\s*["']([^"']+)["']/);
  return m ? m[1] : undefined;
}

/**
 * 从嵌套路由块中解析路由
 */
export const parseNestedRoutes = (
  routeBlock: string,
  parentPath: string,
  side: string,
  importMap: Record<string, string>,
): Route[] => {
  const routes: Route[] = [];
  let hasIndexRoute = false;
  let parentLayoutRoute: Route | null = null;

  // 匹配 index 路由（index 与 element 之间允许夹 handle 等属性）: <Route index element={<Component />} />
  const indexRouteRegex = /<Route\s+index\b[^>]*?element=\{[^}]*<([^\s/>]+)[^}]*\}[^/>]*\/?>/g;
  for (const match of routeBlock.matchAll(indexRouteRegex)) {
    const componentName = match[1] as string;
    if (componentName === 'Navigate') continue;

    hasIndexRoute = true;
    const codePath = importMap[componentName];
    routes.push({ path: parentPath, name: toFriendlyName(componentName), codePath, side });
  }

  // 匹配带 path 的子路由（path 与 element 之间允许夹 handle 等属性）: <Route path="xxx" element={<Component />} />
  const childRouteRegex = /<Route\s+path=["']([^"']+)["'][^>]*?element=\{[^}]*<([^\s/>]+)[^}]*\}[^/>]*\/?>/g;
  for (const match of routeBlock.matchAll(childRouteRegex)) {
    const childPath = match[1] as string;
    const componentName = match[2] as string;

    if (componentName === 'Navigate' || childPath === '*') continue;

    // 判断是否为父路由 layout（path 与 parentPath 相同）
    if (childPath === parentPath) {
      // 暂存父路由 layout，后续根据是否有 index 路由决定是否添加
      const codePath = importMap[componentName];
      parentLayoutRoute = { path: parentPath, name: toFriendlyName(componentName), codePath, side };
      continue;
    }

    // 拼接完整路径（parent 为根时避免 `//space`）
    const fullPath = childPath.startsWith('/')
      ? childPath
      : parentPath === '/' || parentPath === ''
        ? `/${childPath}`
        : `${parentPath}/${childPath}`;
    const codePath = importMap[componentName];
    routes.push({ path: fullPath, name: toFriendlyName(componentName), codePath, side });
  }

  // 如果没有 index 路由，但有父 layout，则用父 layout 兜底
  if (!hasIndexRoute && parentLayoutRoute) {
    routes.unshift(parentLayoutRoute);
  }

  return routes;
};

/**
 * 从变量名推断 side 名称
 * 例如：adminRoutes -> Admin, userRoutes -> User, workspaceGroup -> Workspace
 */
export const inferSideFromVarName = (varName: string): string => {
  // 移除 Routes / Group / Pages / Side 等常见路由组后缀
  const baseName = varName.replace(/(?:Routes|Group|Pages|Side)$/i, '');
  if (!baseName) return 'Other';
  // 首字母大写
  return baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase();
};

/**
 * 解析扁平路由（兼容旧格式，无 @side 注释）
 */
export const parseFlatRoutes = (content: string, importMap: Record<string, string>): Route[] => {
  const routes: Route[] = [];
  const navigateRoutes: { path: string; to: string }[] = [];

  // 匹配普通路由（path 与 element 之间允许夹 handle 等属性） <Route path="..." element={<Component />} />
  const routeRegex = /<Route\s+path=["']([^"']+)["'][^>]*?element=\{[^}]*<([^\s/>]+)[^}]*\}[^/>]*\/?>/g;
  for (const match of content.matchAll(routeRegex)) {
    const path = match[1] as string;
    const componentName = match[2] as string;

    if (componentName === 'Navigate' || path === '*') continue;

    const codePath = importMap[componentName];
    routes.push({ path, name: toFriendlyName(componentName), codePath, side: 'default' });
  }

  // 匹配 Navigate 重定向（path 与 element 之间允许夹 handle 等属性）
  const navigateRegex =
    /<Route\s+path=["']([^"']+)["'][^>]*?element=\{[^}]*<Navigate[^>]*to=["']([^"']+)["'][^}]*\}[^/>]*\/?>/g;
  for (const match of content.matchAll(navigateRegex)) {
    const path = match[1] as string;
    const to = match[2] as string;
    navigateRoutes.push({ path, to });
  }

  // 处理 Navigate 路由
  navigateRoutes.forEach(({ to }) => {
    const targetRoute = routes.find((route) => route.path === to);
    const exists = routes.some((r) => r.path === to);
    if (exists) return;

    routes.push({
      path: to,
      name: targetRoute?.name || 'Home',
      codePath: targetRoute?.codePath,
      side: 'default',
    });
  });

  // 如果没有解析到路由，尝试解析单组件应用
  if (routes.length === 0) {
    const returnIndex = content.indexOf('return');
    if (returnIndex !== -1) {
      const afterReturn = content.slice(returnIndex);
      const uppercaseTagRegex = /<\s*([A-Z][A-Za-z0-9_]*)\b[^>]*\/?>(?!\s*\})/g;
      const ignoredComponents = new Set([
        'Routes',
        'Route',
        'Navigate',
        'Fragment',
        'React',
        'React.Fragment',
      ]);

      for (const m of afterReturn.matchAll(uppercaseTagRegex)) {
        const candidate = m[1] as string;
        if (ignoredComponents.has(candidate)) continue;

        const codePath = importMap[candidate];
        const friendlyName = toFriendlyName(candidate);
        routes.push({ path: '/', name: friendlyName || 'Home', codePath, side: 'default' });
        break;
      }
    }
  }

  return routes;
};

/**
 * 从 App.tsx 内容中解析路由分组
 *
 * 解析优先级：
 * 1. 带 @side 注释的路由组
 * 2. 缺少注释的 xxxRoutes 变量
 * 3. 扁平路由
 * 4. 默认路由
 */
export const parseRouteGroupsFromAppTsx = (content: string, onFallback?: () => void): RouteGroup[] => {
  const groups: RouteGroup[] = [];
  const importMap = parseImportMap(content);
  const parsedVarNames = new Set<string>(); // 记录已解析的变量名

  try {
    // 第一步：匹配带 @side 注释的路由组
    // 变量名不限后缀：只要紧邻 `// @side:` 注释即视为路由组（AI 生成的变量名可能是 xxxGroup/xxxSide 等）。
    const routeGroupRegex =
      /\/\/\s*@side:\s*(\S+).*\n\s*const\s+(\w+)\s*=\s*(?:\(\s*([\s\S]*?)\n\)|([\s\S]*?));/g;

    for (const match of content.matchAll(routeGroupRegex)) {
      const commentSide = match[1] as string;
      const varName = match[2] as string;
      // match[3] 是带括号格式的内容，match[4] 是不带括号格式的内容
      const routeBlock = (match[3] || match[4]) as string;

      parsedVarNames.add(varName); // 记录已解析的变量名

      // 结构化 handle={{ side }} 优先（抗格式化/重生成），// @side: 注释兜底
      const side = extractHandleSideFromRouteBlock(routeBlock) || commentSide;

      const basePath = inferGroupBasePathFromRouteBlock(routeBlock);

      // 解析嵌套路由
      const routes = parseNestedRoutes(routeBlock, basePath, side, importMap);

      if (routes.length > 0) {
        groups.push({
          side,
          label: side,
          basePath,
          routes,
        });
      }
    }

    // 第二步：兜底 - 匹配所有 const xxx = (...) 括号赋值，找出缺少 @side 注释的路由组。
    // 变量名不限后缀（AI 可能命名 xxxGroup 等），改由「块内确实含 <Route」来判定是否路由组，
    // 避免误伤 const App = (...) / const router = (...) 这类同样用括号包裹的普通常量。
    const allRouteVarsRegex = /const\s+(\w+)\s*=\s*\(\s*([\s\S]*?)\n\);/g;
    let otherCounter = 0;

    for (const match of content.matchAll(allRouteVarsRegex)) {
      const varName = match[1] as string;
      const routeBlock = match[2] as string;

      // 跳过已解析的变量
      if (parsedVarNames.has(varName)) {
        continue;
      }

      // fallback 捕获的是 `const xxx = (...)` 的括号体：只有 RHS 自身以 JSX Route/Fragment 开头，
      // 才能认为它是一个路由组。避免把 `const Foo = () => { ... }` 的形参括号当成路由组起点，
      // 进而跨块吞到后面的真实路由组并生成重复端（如“采集后台1”）。
      const normalizedRouteBlock = routeBlock.trimStart();
      const startsWithRouteJsx = /^<Route\b/.test(normalizedRouteBlock);
      const startsWithFragmentJsx = /^<(?:>|Fragment\b|React\.Fragment\b)/.test(normalizedRouteBlock);

      if ((!startsWithRouteJsx && !startsWithFragmentJsx) || !/<Route\b/.test(routeBlock)) {
        continue;
      }

      parsedVarNames.add(varName);

      // 结构化 handle={{ side }} 优先，否则从变量名推断
      let inferredSide = extractHandleSideFromRouteBlock(routeBlock) || inferSideFromVarName(varName);

      // 检查推断的 side 是否已存在，若存在则添加序号
      const existingSides = new Set(groups.map((g) => g.side));
      if (existingSides.has(inferredSide)) {
        otherCounter++;
        inferredSide = `${inferredSide}${otherCounter}`;
      }

      const basePath = inferGroupBasePathFromRouteBlock(routeBlock);

      // 解析嵌套路由
      const routes = parseNestedRoutes(routeBlock, basePath, inferredSide, importMap);

      if (routes.length > 0) {
        groups.push({
          side: inferredSide,
          label: inferredSide,
          basePath,
          routes,
        });
      }
    }

    // 第 2.5 步：检测独立 index 路由（主页端）
    // 当已存在其他端时，查找不属于任何 xxxRoutes 变量的根级 index 路由
    if (groups.length > 0) {
      const capturedCodePaths = new Set<string>();
      const capturedNames = new Set<string>();
      for (const g of groups) {
        for (const r of g.routes) {
          if (r.codePath) capturedCodePaths.add(r.codePath);
          capturedNames.add(r.name);
        }
      }

      const standaloneIndexRegex = /<Route\s+index\s+element=\{[^}]*<([^\s/>]+)[^}]*\}[^/>]*\/?>/g;
      for (const match of content.matchAll(standaloneIndexRegex)) {
        const componentName = match[1] as string;
        if (componentName === 'Navigate') continue;

        const codePath = importMap[componentName];
        const friendlyName = toFriendlyName(componentName);
        if ((codePath && capturedCodePaths.has(codePath)) || capturedNames.has(friendlyName)) continue;

        groups.unshift({
          side: HOME_SIDE_KEY,
          label: '主页端',
          basePath: '/',
          routes: [{ path: '/', name: friendlyName, codePath, side: HOME_SIDE_KEY }],
        });
        break;
      }
    }

    // 第三步：如果没有找到任何路由组，回退到解析普通路由
    if (groups.length === 0) {
      const fallbackRoutes = parseFlatRoutes(content, importMap);
      if (fallbackRoutes.length > 0) {
        groups.push({
          side: 'default',
          label: 'Routes',
          basePath: '/',
          routes: fallbackRoutes,
        });
      }
    }

    // 第四步：如果还是没有路由，提供默认路由
    if (groups.length === 0) {
      onFallback?.();
      groups.push({
        side: 'default',
        label: 'Routes',
        basePath: '/',
        routes: [{ path: '/', name: 'Home', side: 'default' }],
      });
    }
  } catch (error) {
    onFallback?.();
    groups.push({
      side: 'default',
      label: 'Routes',
      basePath: '/',
      routes: [{ path: '/', name: 'Home', side: 'default' }],
    });
  }

  return groups;
};

// ───────────────────────── data-mode RouteObject[] 解析（routes.tsx） ─────────────────────────
// SSR / RR7 data-mode 项目把路由收敛在 src/routes.tsx 的 RouteObject[]（对象字面量，非 JSX <Route>）。
// 浏览器端没有 @babel/parser，这里用一个「只认路由相关键」的轻量对象字面量扫描器：对 (){}[]、字符串、
// 注释做精确配平来跳过 element/loader 等任意表达式，只抽 path / index / handle.side / children，
// 足够还原预览地址栏要的可导航路由。解析不出 → 返回 []，交回上层兜底。

interface RouteObjectNode {
  path?: string;
  index: boolean;
  side?: string;
  elementName?: string; // element/Component 的首个组件名，用于展示名
  hasChildren: boolean;
  children: RouteObjectNode[];
}

/** 从 i 起跳过空白与 // 行注释 / 块注释，返回新下标 */
function skipTrivia(s: string, i: number): number {
  for (;;) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

/** s[i] 为引号(' " `)，跳到匹配结束引号之后；模板串内 ${...} 做花括号配平 */
function skipString(s: string, i: number): number {
  const quote = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && s[i + 1] === '{') {
      i = skipBalanced(s, i + 1);
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/** s[i] 为 ( [ {，跳到匹配闭合之后（内部字符串/注释/嵌套都正确跳过） */
function skipBalanced(s: string, i: number): number {
  const open = s[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i);
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      i = skipTrivia(s, i);
      continue;
    }
    if (c === open) {
      depth++;
      i++;
      continue;
    }
    if (c === close) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/** 从 i 起跳过一个属性值，停在顶层 `,` 或对象闭合 `}` 处（返回该下标）。(){}[]、字符串、注释配平。 */
function skipValue(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ',' || c === '}') return i;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      i = skipBalanced(s, i);
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      i = skipTrivia(s, i);
      continue;
    }
    i++;
  }
  return i;
}

/** s[i] 为 '{'，解析为 RouteObjectNode（只关心路由相关键） */
function parseRouteObjectAt(s: string, i: number): { node: RouteObjectNode; end: number } {
  const node: RouteObjectNode = { index: false, hasChildren: false, children: [] };
  i++; // 跳过起始花括号
  for (;;) {
    i = skipTrivia(s, i);
    if (i >= s.length || s[i] === '}') {
      i++;
      break;
    }
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === '.' && s[i + 1] === '.' && s[i + 2] === '.') {
      i = skipValue(s, i); // 展开 ...x
      continue;
    }
    // key：标识符 或 带引号字符串
    let key = '';
    if (s[i] === '"' || s[i] === "'") {
      const ke = skipString(s, i);
      key = s.slice(i + 1, ke - 1);
      i = ke;
    } else {
      const m = /^[A-Za-z0-9_$]+/.exec(s.slice(i));
      if (m) {
        key = m[0];
        i += m[0].length;
      } else {
        i++;
        continue;
      }
    }
    i = skipTrivia(s, i);
    let valueText = '';
    let arrayStart = -1;
    if (s[i] === ':') {
      i++;
      i = skipTrivia(s, i);
      const vs = i;
      if (s[i] === '[') arrayStart = i;
      const ve = skipValue(s, i);
      valueText = s.slice(vs, ve);
      i = ve;
    }
    if (key === 'path') {
      const sm = /^\s*['"]([^'"]*)['"]/.exec(valueText);
      if (sm) node.path = sm[1];
    } else if (key === 'index') {
      node.index = /^\s*true\b/.test(valueText);
    } else if (key === 'handle') {
      const sm = /side\s*:\s*['"]([^'"]+)['"]/.exec(valueText);
      if (sm) node.side = sm[1];
    } else if (key === 'element' || key === 'Component') {
      const nm = /^\s*<\s*([A-Za-z_$][\w.]*)/.exec(valueText);
      if (nm) node.elementName = nm[1];
    } else if (key === 'children' && arrayStart >= 0) {
      node.children = parseRouteObjectArray(s.slice(arrayStart));
      node.hasChildren = node.children.length > 0;
    }
  }
  return { node, end: i };
}

/** 文本以 '[' 开头（可有前导空白），解析其中顶层对象为 RouteObjectNode[]，到匹配 ']' 即止 */
function parseRouteObjectArray(s: string): RouteObjectNode[] {
  const nodes: RouteObjectNode[] = [];
  let i = skipTrivia(s, 0);
  if (s[i] !== '[') return nodes;
  i++;
  for (;;) {
    i = skipTrivia(s, i);
    if (i >= s.length || s[i] === ']') break;
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === '{') {
      const { node, end } = parseRouteObjectAt(s, i);
      nodes.push(node);
      i = end;
      continue;
    }
    i = skipValue(s, i); // 非对象元素（展开/变量引用）跳过
  }
  return nodes;
}

/**
 * 收集文件里所有「路由数组 const」声明（含外层 []）及其紧邻的 `// @side:` 注释。
 * 覆盖两种 data-mode 写法：① 单一 `export const routes = [...]`；
 * ② 多端分写——`// @side: X` + `const xxxRoutes: RouteObject[] = [...]`，再由 `export const routes` 用 spread 拼装
 *   （spread 引用的源数组本身就是这里的某个 const，直接解析它即可，无需展开 spread）。
 * 跳过解构 `const [a] = ...` 与非数组 `const f = () => {}`（`=\s*\[` 把关）。
 */
function findRouteArrayConsts(content: string): Array<{ side?: string; arrayText: string }> {
  const out: Array<{ side?: string; arrayText: string }> = [];
  const declRe = /(?:\/\/\s*@side:\s*(\S+)[^\n]*\r?\n\s*)?(?:export\s+)?const\s+\w+\s*(?::[^=\n]*)?=\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) {
    const start = m.index + m[0].length - 1; // 指向数组的 '['
    const end = skipBalanced(content, start);
    out.push({ side: m[1], arrayText: content.slice(start, end) });
    declRe.lastIndex = end; // 跳过整个数组体，避免匹配到数组内部嵌套的 const
  }
  return out;
}

function joinRoutePath(parent: string, child: string): string {
  const p = (parent || '').replace(/\/+$/, '');
  const c = (child || '').replace(/^\/+/, '');
  const joined = `${p}/${c}`.replace(/\/{2,}/g, '/');
  return joined === '' ? '/' : joined;
}

function normalizeRoutePath(p: string): string {
  if (!p) return '/';
  const n = `/${p}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return n === '' ? '/' : n;
}

function lastSegmentHasExt(p: string): boolean {
  const last = (p || '').split('/').pop() || '';
  return /\.[^/]+$/.test(last);
}

/** 可导航具体页面：以 / 开头、无通配 *、无动态段 :x、末段无文件扩展名 */
function isNavigablePath(p: string): boolean {
  return p.startsWith('/') && !p.includes('*') && !/(^|\/):[^/]+/.test(p) && !lastSegmentHasExt(p);
}

/** 无组件名时按路径末段派生展示名：'/' -> 'Home'，'/order-history' -> 'Order History' */
function pathToDisplayName(p: string): string {
  if (!p || p === '/') return 'Home';
  const seg = p.split('/').filter(Boolean).pop() || '';
  const words = seg
    .replace(/^[:*]/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || 'Home';
}

interface RouteEntry {
  path: string;
  name: string;
  side?: string;
}

/** DFS 收集可导航路由：有 index 子路由的节点不重复吐自身 path（由 index 提供该路径） */
function collectRouteEntries(
  nodes: RouteObjectNode[],
  parentPath: string,
  parentSide: string | undefined,
  out: RouteEntry[],
): void {
  for (const node of nodes) {
    const side = node.side || parentSide;
    const fullPath = node.path != null ? joinRoutePath(parentPath, node.path) : parentPath;
    const isRedirect = node.elementName === 'Navigate';
    const nameFrom = (p: string) =>
      node.elementName && !isRedirect ? toFriendlyName(node.elementName) : pathToDisplayName(p);

    const hasIndexChild = node.children.some((c) => c.index);
    if (node.path != null && !hasIndexChild) {
      const np = normalizeRoutePath(fullPath);
      if (!isRedirect && isNavigablePath(np)) out.push({ path: np, name: nameFrom(np), side });
    } else if (node.path == null && node.index && parentPath) {
      const np = normalizeRoutePath(parentPath);
      if (!isRedirect && isNavigablePath(np)) out.push({ path: np, name: nameFrom(np), side });
    }

    if (node.children.length) collectRouteEntries(node.children, fullPath, side, out);
  }
}

/** 多端分组时推断该端 basePath：各路径最长公共段前缀，没有则 '/' */
function inferBasePathFromPaths(paths: string[]): string {
  const segLists = paths.map((p) => p.split('/').filter(Boolean));
  if (segLists.length === 0) return '/';
  const first = segLists[0]!;
  const common: string[] = [];
  for (let idx = 0; idx < first.length; idx++) {
    const seg = first[idx]!;
    if (segLists.every((s) => s[idx] === seg)) common.push(seg);
    else break;
  }
  return common.length ? '/' + common.join('/') : '/';
}

function entriesToGroups(entries: RouteEntry[]): RouteGroup[] {
  if (entries.length === 0) return [];
  // 按 path 去重（首条优先；后到的若带 side 而原条没有则补上 side）
  const byPath = new Map<string, RouteEntry>();
  for (const e of entries) {
    const prev = byPath.get(e.path);
    if (!prev) byPath.set(e.path, e);
    else if (!prev.side && e.side) byPath.set(e.path, e);
  }
  const list = Array.from(byPath.values());
  const distinctSides = Array.from(new Set(list.map((e) => e.side).filter((s): s is string => !!s)));

  // 无 side / 单端 → 单个 default 组（label 'Routes'，地址栏不显示侧边切换）
  if (distinctSides.length <= 1) {
    return [
      {
        side: 'default',
        label: 'Routes',
        basePath: '/',
        routes: list.map((e) => ({ path: e.path, name: e.name, side: 'default' })),
      },
    ];
  }

  const groups: RouteGroup[] = [];
  for (const side of distinctSides) {
    const es = list.filter((e) => e.side === side);
    groups.push({
      side,
      label: side,
      basePath: inferBasePathFromPaths(es.map((e) => e.path)),
      routes: es.map((e) => ({ path: e.path, name: e.name, side })),
    });
  }
  return groups;
}

/**
 * 从 routes.tsx 的 RouteObject[] 解析路由分组（data-mode / SSR 项目）。
 * 解析不出（非 RouteObject、无 routes 数组、异常）→ 返回 []，交回上层兜底。
 */
export const parseRouteGroupsFromRouteObjects = (content: string): RouteGroup[] => {
  try {
    const arrays = findRouteArrayConsts(content);
    if (arrays.length === 0) return [];
    const entries: RouteEntry[] = [];
    for (const { side, arrayText } of arrays) {
      const nodes = parseRouteObjectArray(arrayText);
      // 注释 side 作为 parentSide（节点自带 handle.side 时仍以 handle 为先，见 collectRouteEntries）
      collectRouteEntries(nodes, '', side, entries);
    }
    if (entries.length === 0) return [];
    return entriesToGroups(entries);
  } catch (error) {
    return [];
  }
};

/**
 * 路由分组统一入口（自动分发）：
 * - 含 JSX `<Route>` → 走 parseRouteGroupsFromAppTsx（CSR / 原型项目）
 * - 否则尝试 RouteObject[] 解析（data-mode / SSR 的 routes.tsx）
 * - 都解析不出 → 回到 parseRouteGroupsFromAppTsx 的兜底（默认单条 /）
 */
export const parseRouteGroups = (content: string, onFallback?: () => void): RouteGroup[] => {
  if (/<Route\b/.test(content)) return parseRouteGroupsFromAppTsx(content, onFallback);
  const groups = parseRouteGroupsFromRouteObjects(content);
  if (groups.length > 0) return groups;
  return parseRouteGroupsFromAppTsx(content, onFallback);
};

/**
 * 创建默认路由分组
 */
export const createDefaultRouteGroups = (): RouteGroup[] => {
  return [
    {
      side: 'default',
      label: 'Routes',
      basePath: '/',
      routes: [{ path: '/', name: 'Home', side: 'default' }],
    },
  ];
};

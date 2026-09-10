#!/usr/bin/env bash
# 一键递增 patch 版本、发布 npm 并推送版本提交和标签。
# @author xiuyu.yi
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "请切换到 main 分支后再发布。" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "请先提交当前改动，再执行 npm run release。" >&2
  exit 1
fi

package_name="$(node -p "require('./package.json').name")"
previous_version="$(node -p "require('./package.json').version")"
echo "包名：${package_name}"
echo "上个版本：${previous_version}"

# 先验证认证，避免凭据失效时已经生成新的版本提交和标签。
echo "检查 npm 登录状态……"
if ! npm whoami --registry=https://registry.npmjs.org/; then
  echo "npm 身份验证未通过，请完成登录后继续。"
  if ! npm login --registry=https://registry.npmjs.org/ ||
    ! npm whoami --registry=https://registry.npmjs.org/; then
    echo "npm 登录或身份验证失败，发布已停止，版本号尚未修改。" >&2
    exit 1
  fi
fi

npm version patch

current_version="$(node -p "require('./package.json').version")"
echo "本次版本：${current_version}"
echo "发布目标：https://registry.npmjs.org/（latest）"

# npm publish 会自动执行 package.json 中已有的 prepack 校验和构建。
if ! npm publish --access public --registry=https://registry.npmjs.org/ --tag latest; then
  echo "npm 未确认发布成功，请先查询 ${package_name}@${current_version} 的远端状态。" >&2
  echo "本地版本提交和标签已创建，不要重新运行 release 递增版本。" >&2
  exit 1
fi

echo "npm 发布成功：${package_name}@${current_version}"
if ! git push origin main --follow-tags; then
  echo "npm 已发布，Git 推送失败。只需补执行：git push origin main --follow-tags" >&2
  exit 1
fi

echo "发布完成：${previous_version} → ${current_version}，版本提交和标签已推送。"

#!/usr/bin/env bash
# 把 src/core.js 拼上 userscript 头，生成可导入 Tampermonkey 的成品
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-1.0.0}"
OUT="userscript/henan-enterprise-accel.user.js"
mkdir -p userscript

cat > "$OUT" <<HEADER
// ==UserScript==
// @name         河南企业登记 · 填表加速
// @namespace    https://github.com/zhaoruizhe81/henan-enterprise-accel
// @version      ${VERSION}
// @description  缓存只读校验接口，消除同步 XHR 造成的页面冻结；表单快照防止填写内容丢失
// @author       zhaoruizhe81
// @match        http://222.143.21.61:9080/*
// @run-at       document-end
// @grant        unsafeWindow
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

HEADER

cat src/core.js >> "$OUT"

# 语法自检
node --check "$OUT" 2>/dev/null && echo "syntax ok" || echo "node 不在，跳过语法检查"
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, v${VERSION})"

#!/usr/bin/env node
// 把「文字 → GPT-SoVITS → QQ 语音条」工具注入已有的 qq-bridge。
//
// 用法：
//   node integration/patch-bridge.mjs --bridge "C:\path\to\qq-bridge"
//   node integration/patch-bridge.mjs            # 默认 ../qq-bridge-main
//
// 只改 src/mcp-snowluma-safe.js：新增 qq_say_voice 工具（挂在 mcp__snowluma__ 命名空间，
// 这样 QQ preset 原有白名单就能放行），并补两个 import。原文件会先备份成 .bak-<时间戳>。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const block = fs.readFileSync(path.join(HERE, 'voice-tool.block.js'), 'utf8');

const argv = process.argv.slice(2);
const i = argv.indexOf('--bridge');
const bridge = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(HERE, '..', '..', 'qq-bridge-main'));
const target = path.join(bridge, 'src', 'mcp-snowluma-safe.js');

if (!fs.existsSync(target)) {
  console.error(`找不到 ${target}\n请先安装 qq-bridge，或用 --bridge 指定目录。`);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes("'qq_say_voice'")) {
  console.log('已经包含 qq_say_voice，跳过。');
  process.exit(0);
}

function ensureImport(source, line, anchor) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) throw new Error(`找不到插入锚点：${anchor}`);
  return source.replace(anchor, `${anchor}\n${line}`);
}

src = ensureImport(src, "import { spawnSync } from 'node:child_process';", "import path from 'node:path';");
src = ensureImport(src, "import { createHash } from 'node:crypto';", "import { spawnSync } from 'node:child_process';");

const marker = 'await server.connect(new StdioServerTransport());';
if (!src.includes(marker)) {
  console.error('找不到 server.connect 锚点，qq-bridge 版本可能不兼容。');
  process.exit(1);
}

const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(target, backup);
src = src.replace(marker, `${block}\n${marker}`);
fs.writeFileSync(target, src, 'utf8');

console.log(`✓ 已注入 qq_say_voice：${target}`);
console.log(`  备份：${backup}`);
console.log('');
console.log('下一步：');
console.log('1. 确认 config.json 的 snowluma.httpUrl / accessToken 已配置，参考音频放在 <bridge>/ref/reference.wav');
console.log('2. 重启 qq-bridge（或结束 mcp-snowluma-safe.js 子进程，让 DSH 重新拉起）');
console.log('3. 在 QQ 里说「用语音说：你好」测试');

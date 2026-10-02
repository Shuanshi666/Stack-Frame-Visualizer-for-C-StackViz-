#!/usr/bin/env node
/*
 * Runs every `*.test.js` of the given directories with the Node test runner.
 *
 * This exists because passing a glob through an npm script is not portable:
 * the shell does not expand quoted patterns, and Node only understands glob
 * patterns itself from v21 on (the CI ran Node 20 and failed with
 * "Could not find .../test/unit/*.test.js").
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('用法: node test/run.js <目录> [目录...]');
  process.exit(2);
}

const files = [];
for (const root of roots) {
  const directory = path.resolve(root);
  if (!fs.existsSync(directory)) {
    console.error(`目录不存在: ${root}`);
    process.exit(2);
  }
  for (const entry of fs.readdirSync(directory).sort()) {
    if (entry.endsWith('.test.js')) {
      files.push(path.join(directory, entry));
    }
  }
}

if (files.length === 0) {
  console.error(`在 ${roots.join(', ')} 里没有找到 *.test.js`);
  process.exit(2);
}

console.log(`node ${process.version} · 运行 ${files.length} 个测试文件：`);
for (const file of files) {
  console.log(`  ${path.relative(process.cwd(), file)}`);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);

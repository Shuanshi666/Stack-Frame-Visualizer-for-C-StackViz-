/*
 * The "1000 frames / 5000 steps" budget from the README.  Opt-in because it
 * takes a few seconds and needs a real gdb:
 *   npm run test:slow
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { compileFixture, gdbSkipReason } = require('../helpers/toolchain');
const { record, countByType } = require('../helpers/driver');

const enabled = process.env.STACKVIZ_SLOW_TESTS === '1';
const skip = gdbSkipReason() || (enabled ? undefined : '设置 STACKVIZ_SLOW_TESTS=1 才运行（npm run test:slow）');

test('1000 帧深 / 5000 步：跑得完，且次数正确', { skip, timeout: 300000 }, async () => {
  const { source, binary } = compileFixture('deep1000.c');
  const result = await record({
    source,
    binary,
    options: { maxSteps: 5000, maxDepth: 2000 },
    timeoutMs: 240000,
  });
  const counts = countByType(result.events);
  assert.equal(result.code, 0);
  assert.equal(counts.call, 1002, 'main + down(1000..0)');
  assert.equal(counts.return, 1001);
  assert.equal(Math.max(...result.events.map((event) => event.depth)) + 1, 1002);
  assert.ok(result.wallMs < 60000, `应该远快于 60 秒，实际 ${result.wallMs} ms`);
  console.log(`      deep1000: ${result.wallMs} ms, ${result.events.length} 条事件`);
});

/*
 * The cheap snapshot path must produce exactly the same event stream as the
 * exact walk.  This is the safety net for the shortcuts the driver takes
 * (frame pointer identity, "stopped on the closing brace", fallbacks).
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { compileFixture, gdbSkipReason } = require('../helpers/toolchain');
const { record, normalized } = require('../helpers/driver');

const skip = gdbSkipReason();

const CASES = [
  { fixture: 'factorial.c', options: {}, calls: 9 },
  { fixture: 'fibonacci.c', options: {}, calls: 26 },
  { fixture: 'sibling.c', options: {}, calls: 10 },
  { fixture: 'loop_top.c', options: {}, calls: 4 },
  { fixture: 'goto_back.c', options: {}, calls: 4 },
  { fixture: 'mutual.c', options: {}, calls: 19 },
  { fixture: 'preview.c', options: {}, calls: 14 },
  { fixture: 'preview.c', options: { recordLocals: false }, calls: 14 },
  { fixture: 'truncate.c', options: { maxDepth: 5 }, calls: 14 },
  { fixture: 'deep.c', options: { maxSteps: 600 }, calls: 42 },
];

for (const { fixture, options, calls } of CASES) {
  const label = `${fixture}${Object.keys(options).length > 0 ? ` + ${JSON.stringify(options)}` : ''}`;
  test(`快速路径与完整走栈给出同一串事件：${label}`, { skip }, async () => {
    const { source, binary } = compileFixture(fixture);
    const fast = await record({ source, binary, options: { ...options, snapshot: 'auto' } });
    const exact = await record({ source, binary, options: { ...options, snapshot: 'full' } });

    const fastEvents = normalized(fast.events);
    const exactEvents = normalized(exact.events);
    assert.equal(fastEvents.length, exactEvents.length, '事件条数应一致');
    for (let index = 0; index < fastEvents.length; index += 1) {
      assert.deepEqual(fastEvents[index], exactEvents[index], `第 ${index} 条事件不一致`);
    }
    assert.equal(
      fastEvents.filter((event) => event.type === 'call').length,
      calls,
      '调用次数应等于语义期望值'
    );
  });
}

test('同一份记录跑两次结果一致（不依赖时钟/随机）', { skip }, async () => {
  const { source, binary } = compileFixture('fibonacci.c');
  const first = await record({ source, binary });
  const second = await record({ source, binary });
  assert.deepEqual(normalized(first.events), normalized(second.events));
});

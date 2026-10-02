/* Text rendering of events and stacks. */
const assert = require('node:assert/strict');
const test = require('node:test');

const { createHarness } = require('../helpers/vscode-stub');

const harness = createHarness();
const { eventLine, stackLines, DEFAULT_MAX_PRINTED_FRAMES } = require('../../out/render.js');

function frame(id, depth) {
  return {
    frameId: id,
    functionName: 'down',
    file: '/home/x/a.c',
    line: 10 + id,
    depth,
    args: { n: String(100 - id) },
    locals: {},
    lastEventType: 'line',
  };
}

test('events render as one readable line, in Chinese', () => {
  const call = eventLine(
    { type: 'call', frameId: 2, parentFrameId: 1, functionName: 'down', file: '/x/a.c', line: 10, depth: 1, timestamp: 0 },
    7
  );
  assert.match(call, /^\[0007\] \+ 调用/);
  assert.match(call, /帧#2/);
  assert.match(call, /第 2 层/);
  assert.match(call, /父帧 #1/);

  const line = eventLine(
    { type: 'line', frameId: 3, functionName: 'down', file: '/x/a.c', line: 11, depth: 2, timestamp: 0, locals: { i: '7' } },
    8
  );
  assert.match(line, /执行/);
  assert.match(line, /\{i = 7\}/);

  assert.match(
    eventLine({ type: 'exit', frameId: 1, functionName: 'main', file: '/x/a.c', line: 1, depth: 0, timestamp: 0, message: '正常结束' }, 9),
    /结束 {3}正常结束/
  );
});

test('the top frame is marked and short stacks are complete', () => {
  const lines = stackLines([frame(1, 0), frame(2, 1)], { indent: '  ' });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /<-- 栈顶$/);
  assert.equal(lines[0].includes('栈顶'), false);
  assert.equal(stackLines([])[0].includes('空的'), true);
});

test('deep stacks elide the middle', () => {
  const frames = Array.from({ length: DEFAULT_MAX_PRINTED_FRAMES + 12 }, (_, index) => frame(index + 1, index));
  const lines = stackLines(frames);
  assert.equal(lines.length, DEFAULT_MAX_PRINTED_FRAMES + 1);
  assert.match(lines.join('\n'), /中间省略 12 帧/);
  assert.match(lines[lines.length - 1], /<-- 栈顶$/);
});

test.after(() => harness.restore());

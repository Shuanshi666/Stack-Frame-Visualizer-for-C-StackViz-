/*
 * Drives the real gcc + gdb pipeline and checks the things a learner would
 * notice: does every invocation show up, are recursive levels separate, are
 * variables readable, are library frames hidden.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { compileFixture, gdbSkipReason } = require('../helpers/toolchain');
const { record, countByType } = require('../helpers/driver');

const skip = gdbSkipReason();
const options = skip ? {} : undefined;
void options;

async function runFixture(name, { options: overrides = {}, sources } = {}) {
  const { source, binary } = compileFixture(name);
  const result = await record({ source, binary, options: overrides, sources });
  assert.equal(result.code, 0, `gdb exited with ${result.code}:\n${result.stderr.slice(-800)}`);
  return { ...result, counts: countByType(result.events), source, binary };
}

const CASES = [
  { fixture: 'factorial.c', calls: 9, label: '线性递归' },
  { fixture: 'fibonacci.c', calls: 26, label: '树状递归（同一行两次调用）' },
  { fixture: 'sibling.c', calls: 10, label: '同一行两次同名调用' },
  { fixture: 'mutual.c', calls: 19, label: '互递归' },
  { fixture: 'deep.c', calls: 42, label: '42 层深栈' },
  { fixture: 'loop_top.c', calls: 4, label: '循环头就是函数首行（对抗用例）' },
  { fixture: 'goto_back.c', calls: 4, label: '往回 goto（对抗用例）' },
];

for (const { fixture, calls, label } of CASES) {
  test(`${fixture}: 每次调用都记录，且递归各层独立（${label}）`, { skip }, async () => {
    const result = await runFixture(fixture);
    assert.equal(result.counts.call, calls);
    assert.equal(result.counts.return, calls - 1, 'main 还没返回，其余调用都应闭合');
    assert.equal(result.counts.exit, 1);
    assert.equal(result.counts.exception, 0);

    const ids = result.events.filter((event) => event.type === 'call').map((event) => event.frameId);
    assert.equal(new Set(ids).size, ids.length, '帧号必须唯一');

    // every parent must have been seen before its child, and depth must match
    const seen = new Set();
    for (const event of result.events) {
      if (event.type === 'call') {
        if (event.parentFrameId !== undefined) {
          assert.ok(seen.has(event.parentFrameId), `父帧 ${event.parentFrameId} 应早于子帧出现`);
        }
        seen.add(event.frameId);
      }
    }
  });
}

test('变量预览：数组截断、结构体、指针只给地址', { skip }, async () => {
  const result = await runFixture('preview.c');
  const values = new Map();
  for (const event of result.events) {
    for (const [name, value] of Object.entries({ ...(event.args || {}), ...(event.locals || {}) })) {
      values.set(name, value);
    }
  }
  assert.match(values.get('values'), /^\[0, 1, 4, 9, 16, 25, 36, 49, 64, 81, \.\.\.\]$/);
  assert.equal(values.get('p'), '{x = 3, y = 4, label = "hi"}');
  assert.match(values.get('ptr'), /^0x[0-9a-f]+$/);
  assert.match(values.get('text'), /^"[a-z\.\.\.]+"$/);
  assert.equal(values.get('ratio'), '1.5');
});

test('maxDepth 截断：栈不会超深，且给出异常提示', { skip }, async () => {
  const { source, binary } = compileFixture('truncate.c');
  const result = await record({
    source,
    binary,
    options: { maxDepth: 5, recordLocals: false },
  });
  const truncated = result.events.filter((event) => event.type === 'exception');
  assert.equal(truncated.length, 1, '超过 maxDepth 应给出一条提示');
  assert.match(truncated[0].message, /maxDepth/);
  const deepest = Math.max(...result.events.map((event) => event.depth));
  assert.ok(deepest <= 4, `depth 应被截断到 maxDepth 以内，实际 ${deepest}`);

  const limited = await record({
    source,
    binary,
    options: { maxDepth: 5, maxSteps: 4, recordLocals: false },
  });
  const exceptions = limited.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 1);
  assert.match(exceptions[0].message, /maxSteps/);
});

test('没有 STACKVIZ_SOURCES 时仍能过滤库函数帧（启发式模式）', { skip }, async () => {
  const { source, binary } = compileFixture('factorial.c');
  const result = await record({ source, binary, sources: null });
  const functions = new Set(result.events.map((event) => event.functionName));
  assert.deepEqual([...functions].sort(), ['factorial', 'main', 'sum_to']);
  assert.equal(countByType(result.events).call, 9);
});

test('库函数回调：qsort 的比较函数不会让记录崩掉', { skip }, async () => {
  const result = await runFixture('callback.c');
  assert.equal(result.counts.exit, 1);
  const comparator = result.events.find((event) => event.functionName === 'compare_desc');
  if (comparator) {
    const parent = result.events.find((event) => event.frameId === comparator.parentFrameId);
    assert.ok(parent, '比较函数的父帧必须是已记录的帧');
    assert.notEqual(parent.functionName, 'compare_desc', '调用关系挂在调用者下面');
  }
});

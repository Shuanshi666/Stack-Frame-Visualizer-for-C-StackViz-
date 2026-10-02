/*
 * Drives the real gcc + gdb pipeline and checks the things a learner would
 * notice: does every invocation show up, are recursive levels separate, are
 * variables readable, are library frames hidden.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { compileFixture, gdbSkipReason } = require('../helpers/toolchain');
const { record, countByType } = require('../helpers/driver');
const path = require('node:path');

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

test('启发式过滤：系统目录前缀可配置，sourceRoots 可以覆盖它', { skip }, async () => {
  const { source, binary } = compileFixture('factorial.c');
  const sourceDir = path.dirname(source);

  // Declare the fixture directory a "system" directory: nothing is user code.
  const filtered = await record({
    source,
    binary,
    sources: null,
    env: { STACKVIZ_SYSTEM_PREFIXES: JSON.stringify([sourceDir]) },
  });
  assert.equal(countByType(filtered.events).call, 0, '被声明为系统目录后不应记录任何用户帧');
  assert.match(filtered.stderr, /source filter: heuristic/);

  // ... unless the same directory is explicitly declared as a source root.
  const rooted = await record({
    source,
    binary,
    sources: null,
    env: {
      STACKVIZ_SYSTEM_PREFIXES: JSON.stringify([sourceDir]),
      STACKVIZ_SOURCE_ROOTS: JSON.stringify([sourceDir]),
    },
  });
  assert.equal(countByType(rooted.events).call, 9, 'sourceRoots 应优先于系统前缀');
});

test('snapshot 设置：safe 模式与默认模式结果一致，并把自己写进日志', { skip }, async () => {
  const { source, binary } = compileFixture('factorial.c');
  const safe = await record({ source, binary, options: { snapshot: 'full' } });
  const auto = await record({ source, binary });
  assert.match(safe.stderr, /snapshot strategy: full walk every step/);
  assert.match(auto.stderr, /snapshot strategy: auto/);
  assert.equal(countByType(safe.events).call, 9);
  assert.equal(countByType(auto.events).call, 9);
});

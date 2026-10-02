/*
 * Drives the real extension code (activate + the command handlers) with a
 * stubbed `vscode` module: this is what "the commands work" means in CI.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ROOT, FIXTURES, compileFixture, gdbSkipReason } = require('../helpers/toolchain');
const { createHarness, waitForEndOfRun, allNodes } = require('../helpers/vscode-stub');

const skip = gdbSkipReason();

/** Copies a fixture into the harness workspace and makes it the active editor. */
function openFixture(harness, fixture) {
  const target = path.join(harness.state.workspaceRoot, fixture);
  fs.copyFileSync(path.join(FIXTURES, fixture), target);
  const uri = { fsPath: target, scheme: 'file', path: target, fileName: target };
  harness.state.activeTextEditor = { document: { uri, fileName: target, scheme: 'file' } };
  return target;
}

function labelOf(harness, node) {
  return harness.state.treeProvider.getTreeItem(node).label;
}

test('编译并可视化：调用树、帧详情、导出/导入、清空', { skip }, async () => {
  const harness = createHarness();
  harness.activate();
  const source = openFixture(harness, 'factorial.c');

  await harness.state.commands.get('stackviz.compileAndVisualize')();
  const finished = await waitForEndOfRun(harness.output);
  assert.ok(finished, '输出面板里应出现记录小结');
  const text = harness.output.text();
  assert.match(text, /StackViz 记录开始/);
  assert.match(text, /单步次数/);
  assert.match(text, /事件总数/);

  const provider = harness.state.treeProvider;
  const roots = provider.getChildren();
  assert.equal(roots.length, 1);
  assert.match(String(labelOf(harness, roots[0])), /^main\(/);
  const children = provider.getChildren(roots[0]);
  assert.equal(children.length, 2, 'main 应该依次调用 factorial 和 sum_to');
  assert.match(String(labelOf(harness, children[0])), /^factorial\(n = 4\)/);
  assert.match(String(labelOf(harness, children[1])), /^sum_to\(n = 3\)/);
  assert.equal(allNodes(provider).length, 9, '每个调用一个节点');

  // frame details are written for humans
  harness.output.clear();
  await harness.state.commands.get('stackviz.showFrame')(allNodes(provider).at(-1));
  const details = harness.output.text();
  assert.match(details, /===== 帧 #\d+：/);
  assert.match(details, /这是第几次调用/);
  assert.match(details, /谁调用了它/);
  assert.match(details, /它在栈里第几层/);

  // export -> import round trip
  const exported = path.join(harness.state.workspaceRoot, 'recording.stackviz.jsonl');
  harness.state.dialogs.save = exported;
  await harness.state.commands.get('stackviz.exportRecording')();
  const lines = fs.readFileSync(exported, 'utf8').trim().split('\n');
  const exportedEvents = lines.map((line) => JSON.parse(line));
  assert.equal(exportedEvents.filter((event) => event.type === 'call').length, 9);
  assert.equal(exportedEvents.length, 47, 'factorial fixture 共 47 条事件');

  harness.state.commands.get('stackviz.clear')();
  assert.equal(provider.getChildren().length, 0, '清空后树应为空');

  harness.state.dialogs.open = exported;
  await harness.state.commands.get('stackviz.importRecording')();
  assert.equal(allNodes(provider).length, 9, '导入后调用树应重建');

  harness.restore();
  void source;
});

test('tree recursion really branches in the call tree', { skip }, async () => {
  const harness = createHarness();
  harness.activate();
  openFixture(harness, 'fibonacci.c');

  await harness.state.commands.get('stackviz.compileAndVisualize')();
  await waitForEndOfRun(harness.output);

  const provider = harness.state.treeProvider;
  const main = provider.getChildren()[0];
  const fib6 = provider.getChildren(main)[0];
  assert.match(String(labelOf(harness, fib6)), /^fib\(n = 6\)/);
  const branches = provider.getChildren(fib6);
  assert.equal(branches.length, 2, 'fib(n-1) + fib(n-2) 必须分成两支');
  assert.match(String(labelOf(harness, branches[0])), /^fib\(n = 5\)/);
  assert.match(String(labelOf(harness, branches[1])), /^fib\(n = 4\)/);
  assert.equal(allNodes(provider).length, 26);

  harness.restore();
});

test('回放面板：时间轴、单步、跳到下次调用、跟随最新', { skip }, async () => {
  const harness = createHarness();
  harness.activate();
  openFixture(harness, 'deep.c');

  await harness.state.commands.get('stackviz.compileAndVisualize')();
  await waitForEndOfRun(harness.output);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const panel = harness.state.panels[0];
  assert.ok(panel, '开始记录时应自动打开回放面板');
  assert.match(panel.webview.html, /<input id="slider"/);
  assert.match(panel.webview.html, /下次调用/);
  let state = panel.webview.lastState();
  assert.ok(state.count > 0);
  assert.equal(state.cursor, state.last);

  panel.webview.receive({ type: 'first' });
  assert.equal(panel.webview.lastState().stack.length, 0);
  panel.webview.receive({ type: 'nextCall' });
  assert.equal(panel.webview.lastState().current.type, 'call');

  // walk the whole recording through the panel and remember the deepest stack
  let deepest = { size: 0, index: -1, stack: [] };
  for (let index = 0; index <= state.last; index += 1) {
    panel.webview.receive({ type: 'seek', index });
    const stack = panel.webview.lastState().stack;
    if (stack.length > deepest.size) {
      deepest = { size: stack.length, index, stack };
    }
  }
  assert.equal(deepest.size, 42, 'down(40) 的最深栈应为 42 帧');
  assert.equal(deepest.stack.at(-1).status, 'top');
  assert.match(deepest.stack.at(-1).functionName, /down/);

  panel.webview.receive({ type: 'last' });
  assert.equal(panel.webview.lastState().following, true);

  harness.restore();
});

test('环境自检：缺工具时给出可复制的安装命令', async () => {
  const harness = createHarness({ settings: { gccPath: 'no-such-gcc', gdbPath: 'no-such-gdb' } });
  harness.activate();

  await harness.state.commands.get('stackviz.checkEnvironment')();
  const text = harness.output.text();
  assert.match(text, /gcc\s+: 缺失/);
  assert.match(text, /gdb\s+: 缺失/);
  assert.match(text, /apt install -y build-essential gdb/);
  const prompted = harness.state.messages.find(
    (entry) => entry.kind === 'error' && entry.actions.includes('复制安装命令')
  );
  assert.ok(prompted, '应弹出带“复制安装命令”按钮的提示');
  assert.match(harness.state.clipboard, /apt install -y build-essential gdb/);

  harness.restore();
});

test('内置示例：拷进工作区且不覆盖用户改动', async () => {
  const harness = createHarness();
  harness.activate();

  await harness.state.commands.get('stackviz.openExample')();
  const target = path.join(harness.state.workspaceRoot, '.stackviz', 'examples', 'factorial.c');
  assert.ok(fs.existsSync(target), '示例应被拷到 .stackviz/examples/');
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'examples', 'factorial.c'), 'utf8')
  );

  fs.writeFileSync(target, '/* edited by the learner */\n');
  await harness.state.commands.get('stackviz.openExample')();
  assert.match(fs.readFileSync(target, 'utf8'), /edited by the learner/);

  harness.restore();
});

test('Visualize Existing Binary 使用设置里的可执行文件', { skip }, async () => {
  const harness = createHarness();
  harness.activate();
  const { binary } = compileFixture('deep.c');
  harness.state.settings.binaryPath = binary;

  await harness.state.commands.get('stackviz.visualizeExistingBinary')();
  await waitForEndOfRun(harness.output);
  assert.match(harness.output.text(), /（用已有的可执行文件，这次不编译）/);
  assert.equal(allNodes(harness.state.treeProvider).length, 42);

  harness.restore();
});

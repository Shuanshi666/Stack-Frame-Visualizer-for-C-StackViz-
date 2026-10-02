/* Shared helpers: paths, gcc/gdb availability, compiling fixtures. */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const DRIVER = path.join(ROOT, 'python', 'gdb_stackviz.py');

const COMPILE_FLAGS = [
  '-g',
  '-O0',
  '-fno-omit-frame-pointer',
  '-fno-optimize-sibling-calls',
];

function runQuietly(command, args) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
  return result.status === 0;
}

/** gdb is only useful to us when it was built with Python 3. */
function hasGdb() {
  if (!runQuietly('gdb', ['--version'])) {
    return false;
  }
  const probe = cp.spawnSync(
    'gdb',
    ['-q', '-nx', '-batch', '-ex', "python print('stackviz-python-ok')"],
    { encoding: 'utf8', timeout: 30000 }
  );
  return Boolean(probe.stdout && probe.stdout.includes('stackviz-python-ok'));
}

function hasGcc() {
  return runQuietly('gcc', ['--version']);
}

/** Reason why the gdb based tests cannot run, or undefined when they can. */
function gdbSkipReason() {
  if (!hasGcc()) {
    return 'gcc 不可用（先安装 build-essential）';
  }
  if (!hasGdb()) {
    return 'gdb 不可用或没有 Python 3 支持（先安装 gdb）';
  }
  return undefined;
}

let workDir;
function scratchDir() {
  if (!workDir) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackviz-test-'));
  }
  return workDir;
}

/**
 * Compiles a fixture with the exact flags the extension uses and returns the
 * path of the executable.
 */
function compileFixture(fixture, extra = []) {
  const source = path.join(FIXTURES, fixture);
  const binary = path.join(scratchDir(), fixture.replace(/\.c$/, '') + '.out');
  const result = cp.spawnSync('gcc', [...COMPILE_FLAGS, ...extra, '-o', binary, source], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`gcc failed for ${fixture}:\n${result.stderr}`);
  }
  return { source, binary };
}

function fixturePath(fixture) {
  return path.join(FIXTURES, fixture);
}

function cleanup() {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
}

module.exports = {
  ROOT,
  FIXTURES,
  DRIVER,
  COMPILE_FLAGS,
  hasGdb,
  hasGcc,
  gdbSkipReason,
  compileFixture,
  fixturePath,
  scratchDir,
  cleanup,
};

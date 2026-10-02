/*
 * Locks down properties of the gdb driver that are easy to break by accident,
 * including the one that used to disable a gdb safety net.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DRIVER, ROOT } = require('../helpers/toolchain');

const source = fs.readFileSync(DRIVER, 'utf8');

test('driver never disables the auto-load safe path', () => {
  assert.equal(source.includes('safe-path /'), false, 'set auto-load safe-path / must not come back');
  assert.match(source, /set auto-load off/, 'the driver should switch auto-loading off instead');
});

test('driver keeps a bounded, documented option set', () => {
  for (const key of ['maxSteps', 'maxDepth', 'recordLocals', 'maxArrayItems', 'sources', 'snapshot']) {
    assert.match(source, new RegExp(`"${key}":`), `DEFAULT_OPTIONS should contain ${key}`);
  }
  assert.match(source, /FULL_RESYNC_EVERY = \d+/);
  assert.match(source, /STACKVIZ_PORT/);
  assert.match(source, /STACKVIZ_SOURCES/);
});

test('driver is plain Python 3 with the gdb module as its only import', () => {
  const imports = source
    .split('\n')
    .filter((line) => /^(import|from) /.test(line))
    .map((line) => line.split(/\s+/)[1]);
  for (const name of imports) {
    assert.ok(
      ['json', 'os', 're', 'socket', 'sys', 'time', 'gdb'].includes(name),
      `unexpected import: ${name}`
    );
  }
});

test('package metadata and the license file agree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.equal(manifest.license, 'MIT');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) \d{4} .+/);
  assert.match(manifest.activationEvents.join(' '), /onView:stackviz\.callTree/);
  assert.equal(manifest.extensionKind[0], 'workspace');
});

/* .stackviz.jsonl round trip. */
const assert = require('node:assert/strict');
const test = require('node:test');

const { createHarness } = require('../helpers/vscode-stub');

const harness = createHarness();
const recording = require('../../out/recording.js');

const events = [
  { type: 'call', frameId: 1, functionName: 'main', file: '/x/a.c', line: 10, depth: 0, timestamp: 1 },
  { type: 'line', frameId: 1, functionName: 'main', file: '/x/a.c', line: 11, depth: 0, timestamp: 2 },
  { type: 'exit', frameId: 1, functionName: 'main', file: '/x/a.c', line: 12, depth: 0, timestamp: 3, message: 'ok' },
];

test('serialize writes one JSON event per line', () => {
  const text = recording.serializeRecording(events);
  assert.equal(text.split('\n').filter(Boolean).length, 3);
  assert.deepEqual(JSON.parse(text.split('\n')[0]), events[0]);
  assert.equal(recording.serializeRecording([]), '');
});

test('parse reads it back', () => {
  const parsed = recording.parseRecording(recording.serializeRecording(events));
  assert.deepEqual(parsed.events, events);
  assert.equal(parsed.skipped, 0);
});

test('parse skips blank lines, comments and junk but keeps counting', () => {
  const text = [
    '',
    '# a comment',
    JSON.stringify(events[0]),
    'this is not json',
    '{"type":"bogus","frameId":1}',
    JSON.stringify(events[1]),
    '',
  ].join('\n');
  const parsed = recording.parseRecording(text);
  assert.deepEqual(parsed.events, [events[0], events[1]]);
  assert.equal(parsed.skipped, 2);
});

test('reading and writing a file works through the (stubbed) vscode fs', async () => {
  const target = {
    fsPath: harness.state.workspaceRoot + '/round-trip.stackviz.jsonl',
    scheme: 'file',
  };
  await recording.writeRecording(target, events);
  const parsed = await recording.readRecording(target);
  assert.deepEqual(parsed.events, events);
});

test('default file name uses the timestamp', () => {
  const name = recording.defaultRecordingName(new Date(2026, 9, 2, 13, 5, 6));
  assert.equal(name, 'stackviz-20261002-130506.stackviz.jsonl');
});

test.after(() => harness.restore());

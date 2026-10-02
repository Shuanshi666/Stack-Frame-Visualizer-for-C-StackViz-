/*
 * The state machine behind the call tree, the replay cursor and the recording.
 * These are the invariants the whole UI rests on, so they are tested directly.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { StackModel } = require('../../out/stackModel.js');

function call(frameId, parentFrameId, depth, functionName = 'f', line = 10) {
  return {
    type: 'call',
    frameId,
    parentFrameId,
    functionName,
    file: '/x/a.c',
    line,
    depth,
    timestamp: frameId,
  };
}

function line(frameId, depth, functionName = 'f', lineNumber = 11) {
  return { type: 'line', frameId, functionName, file: '/x/a.c', line: lineNumber, depth, timestamp: 100 + frameId };
}

function ret(frameId, depth, functionName = 'f') {
  return { type: 'return', frameId, functionName, file: '/x/a.c', line: 12, depth, timestamp: 200 + frameId };
}

function feed(model, events) {
  for (const event of events) model.apply(event);
}

test('call/return/line build a stack and a tree', () => {
  const model = new StackModel();
  feed(model, [
    call(1, undefined, 0, 'main'),
    line(1, 0, 'main'),
    call(2, 1, 1, 'f'),
    line(2, 1, 'f'),
    call(3, 2, 2, 'f'),
    line(3, 2, 'f'),
    ret(3, 2, 'f'),
    ret(2, 1, 'f'),
  ]);

  const roots = model.rootFrames();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].functionName, 'main');

  const children = model.childrenOf(1);
  assert.equal(children.length, 1);
  assert.equal(children[0].frameId, 2);
  assert.equal(model.childrenOf(2)[0].frameId, 3); // recursion keeps separate nodes
  assert.equal(model.childrenOf(3).length, 0);

  assert.deepEqual(model.liveFrames().map((f) => f.frameId), [1]);
  assert.equal(model.topFrameId(), 1);
  assert.equal(model.hasException(2), false);
});

test('events are counted, and the recording summary ignores the cursor', () => {
  const model = new StackModel();
  feed(model, [call(1, undefined, 0, 'main'), line(1, 0, 'main'), call(2, 1, 1, 'f'), ret(2, 1, 'f'), ret(1, 0, 'main')]);
  const summary = model.summary();
  assert.equal(summary.events, 5);
  assert.deepEqual(summary.counts, { call: 2, return: 2, line: 1, exception: 0, exit: 0 });
  assert.equal(summary.maxDepth, 2);
  assert.equal(summary.steps, 1);
});

test('seeking moves the visible state into the past and back', () => {
  const model = new StackModel();
  feed(model, [call(1, undefined, 0, 'main'), line(1, 0, 'main'), call(2, 1, 1, 'f'), ret(2, 1, 'f')]);

  assert.equal(model.cursor, 3);
  assert.equal(model.isFollowing, true);

  model.seek(1); // after main's first line
  assert.deepEqual(model.liveFrames().map((f) => f.frameId), [1]);
  assert.equal(model.isFollowing, false);
  assert.equal(model.childrenOf(1).length, 0, 'the recursive call has not happened yet');

  model.seek(2);
  assert.equal(model.childrenOf(1).length, 1, 'the call is visible again');

  // new events only append while we are not following
  model.seek(0);
  model.apply(line(1, 0, 'main', 99));
  assert.equal(model.cursor, 0);
  assert.equal(model.topFrame().line, 10, 'at cursor 0 only the call event is applied');

  model.followLatest();
  assert.equal(model.cursor, model.lastEventIndex);
  assert.equal(model.isFollowing, true);
  assert.equal(model.topFrame().line, 99, 'following again applies the event that arrived meanwhile');
});

test('seek clamps instead of throwing, and -1 means "nothing applied"', () => {
  const model = new StackModel();
  feed(model, [call(1, undefined, 0, 'main')]);
  model.seek(-99);
  assert.equal(model.cursor, -1);
  assert.equal(model.liveFrames().length, 0);
  model.seek(9999);
  assert.equal(model.cursor, model.lastEventIndex);
});

test('findEvent walks forward and backward over the requested kinds', () => {
  const model = new StackModel();
  feed(model, [call(1, undefined, 0, 'main'), line(1, 0, 'main'), call(2, 1, 1, 'f'), line(2, 1, 'f'), ret(2, 1, 'f')]);
  model.seek(0);
  assert.equal(model.findEvent(['call'], true), 2);
  assert.equal(model.findEvent(['return'], true), 4);
  assert.equal(model.findEvent(['return'], false), -1);
  assert.equal(model.findEvent(['exception'], true), -1);
});

test('exceptions are attached to the frame they were reported on', () => {
  const model = new StackModel();
  feed(model, [
    call(1, undefined, 0, 'main'),
    call(2, 1, 1, 'f'),
    { type: 'exception', frameId: 2, functionName: 'f', file: '/x/a.c', line: 11, depth: 1, timestamp: 5, message: '达到 maxSteps' },
  ]);
  assert.equal(model.hasException(2), true);
  assert.deepEqual(model.exceptionNotes(2), ['达到 maxSteps']);
  assert.deepEqual(model.exceptions().map((mark) => mark.index), [2]);
});

test('the visible state survives a full replay from the start', () => {
  const model = new StackModel();
  const events = [call(1, undefined, 0, 'main')];
  for (let index = 1; index <= 30; index += 1) {
    events.push(call(index + 1, index, index, 'down'));
    events.push(line(index + 1, index, 'down'));
  }
  feed(model, events);
  const depthAtEnd = model.liveFrames().length;
  model.seek(0);
  assert.equal(model.liveFrames().length, 1);
  model.followLatest();
  assert.equal(model.liveFrames().length, depthAtEnd);
  assert.equal(depthAtEnd, 31);
});

test('reset and loadRecording replace the whole recording', () => {
  const model = new StackModel();
  feed(model, [call(1, undefined, 0, 'main'), call(2, 1, 1, 'f')]);
  model.loadRecording([call(9, undefined, 0, 'other')]);
  assert.equal(model.rootFrames()[0].functionName, 'other');
  assert.equal(model.childrenOf(1).length, 0);
  assert.equal(model.eventCount, 1);
  model.reset();
  assert.equal(model.eventCount, 0);
  assert.equal(model.rootFrames().length, 0);
});

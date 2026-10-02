/*
 * Runs python/gdb_stackviz.py the way the extension does: a TCP listener on
 * 127.0.0.1, gdb started with "-x", NDJSON events coming back.
 */
const cp = require('child_process');
const net = require('net');

const { DRIVER, ROOT } = require('./toolchain');

/**
 * @returns {Promise<{events: object[], stderr: string, code: number, wallMs: number}>}
 */
async function record({ binary, source, options = {}, sources, env = {}, timeoutMs = 300000 }) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const events = [];
  const sockets = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim().length > 0) {
          events.push(JSON.parse(line));
        }
      }
    });
    socket.on('error', () => {});
  });

  const childEnv = {
    ...process.env,
    STACKVIZ_PORT: String(port),
    STACKVIZ_OPTIONS: JSON.stringify({
      maxSteps: 5000,
      maxDepth: 2000,
      recordLocals: true,
      maxArrayItems: 10,
      ...options,
    }),
    ...env,
  };
  const effectiveSources = sources === undefined ? [source] : sources;
  if (effectiveSources !== null) {
    childEnv.STACKVIZ_SOURCES = JSON.stringify(effectiveSources);
  }

  const started = Date.now();
  const child = cp.spawn('gdb', ['-q', '-nx', '-batch', '-x', DRIVER, '--args', binary], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  for (const socket of sockets) {
    socket.destroy();
  }
  server.close();

  return { events, stderr, code, wallMs: Date.now() - started };
}

function countByType(events) {
  const counts = { call: 0, return: 0, line: 0, exception: 0, exit: 0 };
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  return counts;
}

/** Events without timestamps, so two runs can be compared. */
function normalized(events) {
  return events.map((event) => {
    const copy = { ...event };
    delete copy.timestamp;
    return copy;
  });
}

module.exports = { record, countByType, normalized };

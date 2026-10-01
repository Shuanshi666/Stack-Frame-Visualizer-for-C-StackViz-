import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CStackEvent } from './protocol';
import { DEFAULT_MAX_PRINTED_FRAMES, eventLine, stackLines } from './render';
import { StackModel } from './stackModel';
import { NdjsonServer } from './tcpServer';
import { writePrefixedLines } from './util';

export type CompileMode = 'plugin' | 'user' | 'ask';

export interface StackVizConfig {
  compileMode: CompileMode;
  binaryPath: string;
  extraCompilerArgs: string[];
  gccPath: string;
  gdbPath: string;
  maxSteps: number;
  maxDepth: number;
  recordLocals: boolean;
  maxArrayItems: number;
}

export interface CompileResult {
  binaryPath: string;
  command: string;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

export function readConfig(resource?: vscode.Uri): StackVizConfig {
  const configuration = vscode.workspace.getConfiguration('stackviz', resource ?? null);
  const rawMode = configuration.get<string>('compileMode', 'ask');
  const compileMode: CompileMode = rawMode === 'plugin' || rawMode === 'user' ? rawMode : 'ask';
  return {
    compileMode,
    binaryPath: (configuration.get<string>('binaryPath', '') ?? '').trim(),
    extraCompilerArgs: configuration.get<string[]>('extraCompilerArgs', []) ?? [],
    gccPath: (configuration.get<string>('gccPath', 'gcc') ?? '').trim() || 'gcc',
    gdbPath: (configuration.get<string>('gdbPath', 'gdb') ?? '').trim() || 'gdb',
    maxSteps: clampNumber(configuration.get<number>('maxSteps', 5000), 1, 1_000_000, 5000),
    maxDepth: clampNumber(configuration.get<number>('maxDepth', 100), 1, 10_000, 100),
    recordLocals: configuration.get<boolean>('recordLocals', true) !== false,
    maxArrayItems: clampNumber(configuration.get<number>('maxArrayItems', 10), 0, 1000, 10)
  };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  tag: string
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      output.appendLine(`[${tag}] ${(error as Error).message}`);
      finish(-1);
      return;
    }

    child.on('error', (error) => {
      output.appendLine(`[${tag}] ${error.message}`);
      finish(-1);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      writePrefixedLines(output, tag, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      writePrefixedLines(output, tag, chunk.toString());
    });
    child.on('close', (code) => {
      finish(code ?? -1);
    });
  });
}

/**
 * Plugin compile mode, with the arguments fixed by the specification:
 *   gcc -g -O0 -fno-omit-frame-pointer -fno-optimize-sibling-calls -o <out> <src>
 */
export async function compileCFile(
  sourceFile: string,
  outputBinary: string,
  cwd: string,
  config: StackVizConfig,
  output: vscode.OutputChannel
): Promise<CompileResult> {
  await fs.promises.mkdir(path.dirname(outputBinary), { recursive: true });
  const args = [
    '-g',
    '-O0',
    '-fno-omit-frame-pointer',
    '-fno-optimize-sibling-calls',
    '-o',
    outputBinary,
    sourceFile,
    ...config.extraCompilerArgs
  ];
  const command = `${config.gccPath} ${args.join(' ')}`;
  output.appendLine(`$ ${command}`);
  const code = await runProcess(config.gccPath, args, cwd, output, 'gcc');
  if (code !== 0) {
    throw new Error(`gcc exited with code ${code}. See the "StackViz" output channel for the compiler messages.`);
  }
  return { binaryPath: outputBinary, command };
}

export interface SessionStartOptions {
  extensionPath: string;
  binaryPath: string;
  workdir: string;
  sourceFile?: string;
  /** Absolute paths of the user's own C sources; library frames are hidden. */
  sourceFiles: string[];
  config: StackVizConfig;
  output: vscode.OutputChannel;
  model: StackModel;
  onExit?: (session: StackVizSession) => void;
  /** Called for every event, used to refresh the call tree. */
  onEvent?: (event: CStackEvent) => void;
}

/**
 * One gdb run: TCP server + gdb child process + event log.
 */
export class StackVizSession implements vscode.Disposable {
  private readonly server = new NdjsonServer();
  private child: cp.ChildProcess | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private finished = false;
  private eventSequence = 0;

  private constructor(
    private readonly output: vscode.OutputChannel,
    private readonly model: StackModel,
    public readonly binaryPath: string,
    private readonly onExit: ((session: StackVizSession) => void) | undefined,
    private readonly onEvent: ((event: CStackEvent) => void) | undefined
  ) {}

  public static async start(options: SessionStartOptions): Promise<StackVizSession> {
    const session = new StackVizSession(
      options.output,
      options.model,
      options.binaryPath,
      options.onExit,
      options.onEvent
    );
    await session.launch(options);
    return session;
  }

  private async launch(options: SessionStartOptions): Promise<void> {
    const scriptPath = path.join(options.extensionPath, 'python', 'gdb_stackviz.py');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`The gdb driver script is missing: ${scriptPath}`);
    }
    await fs.promises.mkdir(options.workdir, { recursive: true });

    const port = await this.server.start((event, rawLine) => this.handleMessage(event, rawLine));
    this.output.appendLine(`StackViz: listening on 127.0.0.1:${port} (waiting for gdb)`);

    const gdbOptions = JSON.stringify({
      maxSteps: options.config.maxSteps,
      maxDepth: options.config.maxDepth,
      recordLocals: options.config.recordLocals,
      maxArrayItems: options.config.maxArrayItems
    });
    const args = ['-q', '-nx', '-batch', '-x', scriptPath, '--args', options.binaryPath];
    this.output.appendLine(`$ ${options.config.gdbPath} ${args.join(' ')}`);

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(options.config.gdbPath, args, {
        cwd: options.workdir,
        env: {
          ...process.env,
          STACKVIZ_PORT: String(port),
          STACKVIZ_OPTIONS: gdbOptions,
          STACKVIZ_SOURCES: JSON.stringify(options.sourceFiles)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      this.server.stop();
      throw new Error(`Could not start gdb (${options.config.gdbPath}): ${(error as Error).message}`);
    }
    this.child = child;

    child.on('error', (error) => {
      this.output.appendLine(`[gdb] ${error.message}`);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.output.appendLine(
          '[gdb] gdb was not found. Install it with: sudo apt update && sudo apt install -y gdb build-essential'
        );
      }
      this.finish('gdb could not be started');
    });
    child.stdout?.on('data', (chunk: Buffer) => writePrefixedLines(this.output, 'gdb', chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => writePrefixedLines(this.output, 'gdb', chunk.toString()));
    child.on('close', (code, signal) => {
      this.finish(signal ? `gdb stopped by signal ${signal}` : `gdb stopped with exit code ${code}`);
    });
  }

  public stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.output.appendLine('--- StackViz: stopping (SIGTERM) ---');
      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.output.appendLine('--- StackViz: gdb did not stop, sending SIGKILL ---');
          child.kill('SIGKILL');
        }
      }, 1500);
    }
    this.server.stop();
  }

  public dispose(): void {
    this.stop();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }

  private finish(reason: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.server.stop();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    this.printSummary(reason);
    this.onExit?.(this);
  }

  private handleMessage(event: unknown, rawLine: string): void {
    if (event === undefined || typeof event !== 'object') {
      this.output.appendLine(`[stackviz] ignoring malformed event: ${rawLine.slice(0, 200)}`);
      return;
    }
    const typed = event as CStackEvent;
    if (typeof typed.type !== 'string' || typeof typed.frameId !== 'number') {
      this.output.appendLine(`[stackviz] ignoring unknown event: ${rawLine.slice(0, 200)}`);
      return;
    }
    this.model.apply(typed);
    this.logEvent(typed);
    this.onEvent?.(typed);
  }

  private logEvent(event: CStackEvent): void {
    this.eventSequence += 1;
    this.output.appendLine(eventLine(event, this.eventSequence));

    switch (event.type) {
      case 'call':
      case 'return':
        this.appendStack();
        break;
      case 'exception':
      case 'exit':
        this.appendStack();
        break;
      default:
        break;
    }
  }

  private appendStack(): void {
    const frames = this.model.liveFrames();
    if (frames.length === 0) {
      this.output.appendLine('          (call stack is empty)');
      return;
    }
    for (const line of stackLines(frames, { indent: '          ', maxFrames: DEFAULT_MAX_PRINTED_FRAMES })) {
      this.output.appendLine(line);
    }
  }

  private printSummary(reason: string): void {
    const summary = this.model.summary();
    const counts = summary.counts;
    this.output.appendLine('');
    this.output.appendLine('===== StackViz summary =====');
    this.output.appendLine(`steps    : ${summary.steps}`);
    this.output.appendLine(
      `events   : ${summary.events} (call ${counts.call}, return ${counts.return}, ` +
        `line ${counts.line}, exception ${counts.exception}, exit ${counts.exit})`
    );
    this.output.appendLine(`max depth: ${summary.maxDepth}`);
    this.output.appendLine(`duration : ${(summary.durationMs / 1000).toFixed(2)} s`);
    this.output.appendLine(`ended    : ${reason}`);
    if (summary.dropped > 0) {
      this.output.appendLine(`note     : ${summary.dropped} oldest event(s) were dropped to keep memory bounded`);
    }
    for (const note of this.model.notes) {
      this.output.appendLine(`note     : ${note}`);
    }
    this.output.appendLine('===== end of run =====');
    this.output.appendLine('');
  }
}

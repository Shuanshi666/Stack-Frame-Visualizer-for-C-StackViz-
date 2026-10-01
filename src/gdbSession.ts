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
    this.output.appendLine(`StackViz：正在监听 127.0.0.1:${port}，等待 gdb 连回来…`);

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
          '[gdb] 没有找到 gdb。安装命令：sudo apt update && sudo apt install -y gdb build-essential'
        );
      }
      this.finish('gdb 没能启动');
    });
    child.stdout?.on('data', (chunk: Buffer) => writePrefixedLines(this.output, 'gdb', chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => writePrefixedLines(this.output, 'gdb', chunk.toString()));
    child.on('close', (code, signal) => {
      this.finish(signal ? `gdb 被信号 ${signal} 结束` : `gdb 正常退出（退出码 ${code}）`);
    });
  }

  public stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.output.appendLine('--- StackViz：正在停止（SIGTERM）---');
      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.output.appendLine('--- StackViz：gdb 没有响应，改发 SIGKILL ---');
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
      this.output.appendLine(`[stackviz] 跳过一条格式不对的数据：${rawLine.slice(0, 200)}`);
      return;
    }
    const typed = event as CStackEvent;
    if (typeof typed.type !== 'string' || typeof typed.frameId !== 'number') {
      this.output.appendLine(`[stackviz] 跳过一条认不出的数据：${rawLine.slice(0, 200)}`);
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
      this.output.appendLine('          （调用栈是空的）');
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
    this.output.appendLine('===== 本次记录小结 =====');
    this.output.appendLine(`单步次数 : ${summary.steps}（程序每往前走一行算一步）`);
    this.output.appendLine(
      `事件总数 : ${summary.events}（调用 ${counts.call}、返回 ${counts.return}、` +
        `执行 ${counts.line}、异常 ${counts.exception}、结束 ${counts.exit}）`
    );
    this.output.appendLine(`最深栈深 : ${summary.maxDepth} 层`);
    this.output.appendLine(`耗时     : ${(summary.durationMs / 1000).toFixed(2)} 秒`);
    this.output.appendLine(`结束原因 : ${reason}`);
    if (summary.dropped > 0) {
      this.output.appendLine(`提示     : 为了控制内存，最早的 ${summary.dropped} 条事件已被丢弃`);
    }
    for (const note of this.model.notes) {
      this.output.appendLine(`提示     : ${note}`);
    }
    this.output.appendLine('===== 记录结束 =====');
    this.output.appendLine('');
  }
}

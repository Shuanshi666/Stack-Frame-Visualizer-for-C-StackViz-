import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export const INSTALL_COMMAND = 'sudo apt update && sudo apt install -y build-essential gdb';

export interface ProbeResult {
  path: string;
  ok: boolean;
  version?: string;
  detail?: string;
  error?: string;
}

/** Raised when a required tool is missing or unusable, with a fix attached. */
export class ToolchainError extends Error {
  constructor(message: string, public readonly installCommand: string = INSTALL_COMMAND) {
    super(message);
    this.name = 'ToolchainError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: '', spawnError: (error as Error).message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The probe simply times out.
      }
      finish({ code: -1, stdout, stderr, spawnError: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr, spawnError: error.message });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line;
}

/**
 * Probes gcc/gdb once per session and remembers the answer, so the "missing
 * tool" conversation happens before a run instead of in the middle of one.
 */
export class Toolchain {
  private readonly cache = new Map<string, ProbeResult>();

  public clear(): void {
    this.cache.clear();
  }

  public async checkGcc(command: string): Promise<ProbeResult> {
    return this.cached(`gcc:${command}`, async () => {
      const result = await run(command, ['--version'], 5000);
      if (result.spawnError) {
        return {
          path: command,
          ok: false,
          error: `找不到 gcc（${command}）：${result.spawnError}`
        };
      }
      if (result.code !== 0) {
        return { path: command, ok: false, error: `执行「${command} --version」返回了退出码 ${result.code}` };
      }
      return { path: command, ok: true, version: firstLine(result.stdout) };
    });
  }

  /**
   * gdb is only useful to us when it was built with Python 3, so the probe
   * actually runs a Python statement inside gdb.
   */
  public async checkGdb(command: string): Promise<ProbeResult> {
    return this.cached(`gdb:${command}`, async () => {
      const version = await run(command, ['--version'], 5000);
      if (version.spawnError) {
        return {
          path: command,
          ok: false,
          error: `找不到 gdb（${command}）：${version.spawnError}`
        };
      }
      if (version.code !== 0) {
        return { path: command, ok: false, error: `"${command} --version" exited with code ${version.code}` };
      }

      const marker = 'stackviz-python-ok';
      const python = await run(
        command,
        ['-q', '-nx', '-batch', '-ex', `python print('${marker}')`],
        15000
      );
      if (!python.stdout.includes(marker)) {
        return {
          path: command,
          ok: false,
          version: firstLine(version.stdout),
          error:
            `「${command}」不带 Python 3 支持，而 StackViz 的驱动脚本需要它。` +
            '请安装发行版自带的 gdb 包（默认就带 Python）。'
        };
      }
      return {
        path: command,
        ok: true,
        version: firstLine(version.stdout),
        detail: 'Python 3 支持：有'
      };
    });
  }

  private async cached(key: string, probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
    const hit = this.cache.get(key);
    if (hit) {
      return hit;
    }
    const result = await probe();
    this.cache.set(key, result);
    return result;
  }
}

export interface EnvironmentReport {
  ok: boolean;
  lines: string[];
}

function describePlatform(): string[] {
  const release = os.release();
  const isWsl = /microsoft/i.test(release);
  return [
    `平台        : ${os.platform()} ${os.arch()}（${os.type()} ${release}）`,
    `WSL2 内核   : ${isWsl ? '是' : '否'}`,
    `Node 版本   : ${process.version}`
  ];
}

function debugSymbolsLine(): string {
  const candidates = ['/usr/lib/debug/.build-id', '/usr/lib/debug'];
  const found = candidates.some((path) => {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  });
  return found
    ? 'libc6-dbg   : 已安装（有没有它都会过滤库函数帧）'
    : 'libc6-dbg   : 未安装（可选：sudo apt install -y libc6-dbg）';
}

/** Everything the "Check Environment" command prints. */
export async function checkEnvironment(
  toolchain: Toolchain,
  gccPath: string,
  gdbPath: string,
  workspaceRoot: string | undefined
): Promise<EnvironmentReport> {
  const gcc = await toolchain.checkGcc(gccPath);
  const gdb = await toolchain.checkGdb(gdbPath);

  const lines: string[] = ['===== StackViz 环境自检 =====', ...describePlatform()];
  lines.push(
    gcc.ok
      ? `gcc         : 正常 - ${gcc.version}`
      : `gcc         : 缺失 - ${gcc.error}`
  );
  lines.push(
    gdb.ok
      ? `gdb         : 正常 - ${gdb.version}（${gdb.detail}）`
      : `gdb         : 缺失 - ${gdb.error}`
  );
  lines.push(debugSymbolsLine());

  let writable = false;
  if (workspaceRoot) {
    const target = `${workspaceRoot}/.stackviz`;
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.accessSync(target, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    lines.push(`.stackviz   : ${writable ? `可写（${target}）` : `不可写（${target}）`}`);
  } else {
    lines.push('.stackviz   : 没有打开工作区文件夹');
  }

  lines.push(`gcc 路径    : ${gccPath}`);
  lines.push(`gdb 路径    : ${gdbPath}`);
  if (!gcc.ok || !gdb.ok) {
    lines.push('');
    lines.push('安装命令：');
    lines.push(`  ${INSTALL_COMMAND}`);
  } else {
    lines.push('');
    lines.push('StackViz 需要的工具都齐了。');
  }
  lines.push('===== 环境自检结束 =====');

  return { ok: gcc.ok && gdb.ok && writable, lines };
}

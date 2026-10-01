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
          error: `gcc was not found (${command}): ${result.spawnError}`
        };
      }
      if (result.code !== 0) {
        return { path: command, ok: false, error: `"${command} --version" exited with code ${result.code}` };
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
          error: `gdb was not found (${command}): ${version.spawnError}`
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
            `"${command}" does not support the Python 3 commands StackViz needs. ` +
            'Install the gdb package of your distribution (it ships with Python enabled).'
        };
      }
      return {
        path: command,
        ok: true,
        version: firstLine(version.stdout),
        detail: 'python 3 support: yes'
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
    `platform    : ${os.platform()} ${os.arch()} (${os.type()} ${release})`,
    `wsl         : ${isWsl ? 'yes (WSL2 kernel)' : 'no'}`,
    `node        : ${process.version}`
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
    ? 'libc6-dbg   : installed (library frames are filtered out either way)'
    : 'libc6-dbg   : not installed (optional: sudo apt install -y libc6-dbg)';
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

  const lines: string[] = ['===== StackViz environment =====', ...describePlatform()];
  lines.push(
    gcc.ok
      ? `gcc         : OK - ${gcc.version}`
      : `gcc         : MISSING - ${gcc.error}`
  );
  lines.push(
    gdb.ok
      ? `gdb         : OK - ${gdb.version} (${gdb.detail})`
      : `gdb         : MISSING - ${gdb.error}`
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
    lines.push(`.stackviz   : ${writable ? `writable (${target})` : `NOT writable (${target})`}`);
  } else {
    lines.push('.stackviz   : no workspace folder is open');
  }

  lines.push(`gcc path    : ${gccPath}`);
  lines.push(`gdb path    : ${gdbPath}`);
  if (!gcc.ok || !gdb.ok) {
    lines.push('');
    lines.push('Install the toolchain with:');
    lines.push(`  ${INSTALL_COMMAND}`);
  } else {
    lines.push('');
    lines.push('Everything StackViz needs is available.');
  }
  lines.push('===== end of environment =====');

  return { ok: gcc.ok && gdb.ok && writable, lines };
}

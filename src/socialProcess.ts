import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly failure?: 'unavailable' | 'timeout' | 'disk-limit' | 'output-limit' | 'process';
  readonly error?: Error;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxDiskBytes?: number;
  readonly maxFileBytes?: number;
}

const active = new Map<ChildProcess, { stop: () => void; closed: Promise<void> }>();
let shuttingDown = false;

export async function stopSocialProcesses(): Promise<void> {
  shuttingDown = true;
  const running = [...active.values()];
  for (const process of running) process.stop();
  await Promise.all(running.map((process) => process.closed));
}

async function directorySize(directory: string): Promise<{ total: number; largest: number }> {
  let bytes = 0;
  let largest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(path);
      bytes += nested.total;
      largest = Math.max(largest, nested.largest);
    } else if (entry.isFile()) {
      const size = (await lstat(path).catch(() => null))?.size ?? 0;
      bytes += size;
      largest = Math.max(largest, size);
    }
  }
  return { total: bytes, largest };
}

/** Capture child output without a shell; callers decide when to log diagnostics. */
export async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (shuttingDown) return { stdout: '', stderr: '', exitCode: null, failure: 'process' };
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure: ProcessResult['failure'];
    let processError: Error | undefined;
    let closed = false;

    const stop = (reason: NonNullable<ProcessResult['failure']>): void => {
      if (failure || closed) return;
      failure = reason;
      // yt-dlp may be running FFmpeg. Kill the whole process tree before cleanup.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore', shell: false,
        });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', (code) => { if (code !== 0) child.kill('SIGKILL'); });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };

    const capture = (stream: 'stdout' | 'stderr', data: string): void => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > 4 * 1024 * 1024) { stop('output-limit'); return; }
      if (stream === 'stdout') stdout += data;
      else stderr += data;
    };
    let resolveClosed!: () => void;
    active.set(child, {
      stop: () => stop('process'),
      closed: new Promise<void>((done) => { resolveClosed = done; }),
    });
    child.stdout.setEncoding('utf8').on('data', (data: string) => capture('stdout', data));
    child.stderr.setEncoding('utf8').on('data', (data: string) => capture('stderr', data));
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    let checking = false;
    const diskCheck = options.cwd && options.maxDiskBytes !== undefined
      ? setInterval(() => {
        if (checking || failure) return;
        checking = true;
        void directorySize(options.cwd!).then(({ total, largest }) => {
          if (total > options.maxDiskBytes! || largest > (options.maxFileBytes ?? Infinity)) stop('disk-limit');
        }).catch(() => stop('process')).finally(() => { checking = false; });
      }, 500)
      : undefined;

    child.on('error', (error: NodeJS.ErrnoException) => {
      processError = error;
      failure ??= error.code === 'ENOENT' ? 'unavailable' : 'process';
    });
    child.on('close', (exitCode) => {
      closed = true;
      clearTimeout(timeout);
      clearInterval(diskCheck);
      active.delete(child);
      resolveClosed();
      resolve({ stdout, stderr, exitCode, failure, error: processError });
    });
  });
}

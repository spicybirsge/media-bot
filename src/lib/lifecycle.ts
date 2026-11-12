/** Tracks owned archive jobs so shutdown can cancel work and await its cleanup. */
export class ArchiveLifecycle {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  get signal(): AbortSignal { return this.controller.signal; }

  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    const result = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return job(this.signal);
    });
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }

  async shutdown(stopProcesses: () => Promise<void>): Promise<void> {
    this.controller.abort(new Error('Bot is shutting down'));
    try {
      await stopProcesses();
    } finally {
      await Promise.allSettled([...this.pending]);
    }
  }
}

export const archiveLifecycle = new ArchiveLifecycle();

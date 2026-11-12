/** Rejections never poison the queue or stop later messages. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      let cancelled = false;
      const abortQueued = (): void => {
        cancelled = true;
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abortQueued, { once: true });
      this.tail = this.tail.then(async () => {
        signal?.removeEventListener('abort', abortQueued);
        if (cancelled) return;
        // Once started, let the job handle cancellation and finish its cleanup
        // before settling the caller's promise or allowing the next job to run.
        try {
          signal?.throwIfAborted();
          resolve(await job());
        } catch (error) { reject(error); }
      });
    });
  }
}

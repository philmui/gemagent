/** Runs asynchronous lifecycle work in issue order, even after a rejected task. */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

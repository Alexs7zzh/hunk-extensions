/** Keep a bounded window of work in flight and consume results in input order.
 * Settling the window on failure keeps resource cleanup behind all users.
 */
export async function forEachOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  build: (value: T, index: number) => Promise<R>,
  consume: (result: R, index: number) => void,
) {
  const pending = new Map<number, Promise<R>>();
  const start = (index: number) => {
    const operation = Promise.resolve().then(() =>
      build(values[index]!, index),
    );
    // A later result can fail while an earlier result is still being consumed.
    void operation.catch(() => {});
    pending.set(index, operation);
  };
  for (let index = 0; index < Math.min(concurrency, values.length); index++)
    start(index);
  try {
    for (let index = 0; index < values.length; index++) {
      const result = await pending.get(index)!;
      pending.delete(index);
      consume(result, index);
      if (index + concurrency < values.length) start(index + concurrency);
    }
  } finally {
    await Promise.allSettled(pending.values());
  }
}

/** Join independent reads without letting cleanup race a surviving sibling. */
export async function together<T extends readonly unknown[]>(operations: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  try {
    return (await Promise.all(operations)) as T;
  } catch (error) {
    await Promise.allSettled(operations);
    throw error;
  }
}

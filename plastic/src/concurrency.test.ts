import { expect, test } from "bun:test";
import { forEachOrdered, together } from "./concurrency";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("advances the window before the slowest file finishes, with bounded ordered results", async () => {
  const slow = gate();
  const advanced = gate();
  const consumed: number[] = [];
  let active = 0;
  let peak = 0;
  const operation = forEachOrdered(
    [0, 1, 2, 3, 4, 5],
    4,
    async (index) => {
      peak = Math.max(peak, ++active);
      if (index === 3) await slow.promise;
      if (index === 4) advanced.release();
      active--;
      return index;
    },
    (index) => {
      consumed.push(index);
    },
  );
  try {
    await advanced.promise;
    expect(consumed.length).toBeGreaterThan(0);
    expect(consumed).toEqual([0, 1, 2].slice(0, consumed.length));
    expect(peak).toBeLessThanOrEqual(4);
  } finally {
    slow.release();
    await operation;
  }
  expect(consumed).toEqual([0, 1, 2, 3, 4, 5]);
});

test("waits for in-flight users before propagating failure", async () => {
  const slow = gate();
  const started = gate();
  let settled = false;
  const operation = forEachOrdered(
    [0, 1],
    2,
    async (index) => {
      if (index === 0) throw new Error("failed");
      started.release();
      await slow.promise;
    },
    () => {},
  );
  void operation.catch(() => {
    settled = true;
  });
  await started.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  slow.release();
  await expect(operation).rejects.toThrow("failed");
});

test("paired reads settle their sibling before reporting failure", async () => {
  const slow = gate();
  let settled = false;
  const operation = together([
    Promise.reject(new Error("failed")),
    slow.promise,
  ]);
  void operation.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  slow.release();
  await expect(operation).rejects.toThrow("failed");
});

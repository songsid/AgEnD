import { performance } from "node:perf_hooks";
/** Total elapsed budget, including queue/await time. A late result never changes the verdict. */
export function withinBudget<T>(operation: Promise<T>, deadline: number, now = () => performance.now()): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (value: T | undefined, error?: unknown): void => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const check = (): void => {
      const remaining = deadline - now();
      if (remaining <= 0) settle(undefined, new Error("budget expired"));
      else timer = setTimeout(check, Math.max(1, Math.ceil(remaining)));
    };
    check();
    operation.then(value => now() >= deadline ? settle(undefined, new Error("budget expired")) : settle(value), error => settle(undefined, error));
  });
}

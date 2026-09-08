/** Race the work as well as signalling cooperative cancellation. No retries. */
export async function withRuntimeDeadline<T>(
  controller: AbortController,
  timeoutMs: number,
  execute: () => T | Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(
        new Error("Workflow timed out. Review the failed run before retrying."),
        { code: "runtime_timeout" },
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(execute), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

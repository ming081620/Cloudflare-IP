type LogLevel = 'info' | 'warn' | 'error';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logEvent(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ts: new Date().toISOString(), ...fields });
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

/**
 * The only place in the worker allowed to call ctx.waitUntil. Every background task
 * routes through here so a rejection is logged instead of vanishing: the response has
 * already been returned by then, so the top-level handler in index.ts cannot catch it.
 */
export function backgroundTask(ctx: ExecutionContext, task: string, run: () => Promise<unknown>): void {
  ctx.waitUntil(
    run().catch((error) => {
      logEvent('error', 'background_task_failed', { task, error: describeError(error) });
    })
  );
}

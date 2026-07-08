import { PUBLIC_WORKER_CACHE_TAGS } from './utils';

export async function purgePublicWorkerCache(ctx?: ExecutionContext): Promise<void> {
  if (!ctx?.cache) {
    return;
  }

  try {
    const result = await ctx.cache.purge({ tags: [...PUBLIC_WORKER_CACHE_TAGS] });
    if (!result.success) {
      console.warn(JSON.stringify({ level: 'warn', message: 'worker_cache_purge_failed', errors: result.errors }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'worker_cache_purge_error', error: error instanceof Error ? error.message : String(error) }));
  }
}

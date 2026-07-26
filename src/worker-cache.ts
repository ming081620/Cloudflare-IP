import { describeError, logEvent } from './observability';
import { PUBLIC_HTML_CACHE_TAG, PUBLIC_LATEST_CACHE_TAG } from './utils';

async function purgeTags(tags: string[], ctx?: ExecutionContext): Promise<void> {
  if (!ctx?.cache) {
    logEvent('warn', 'worker_cache_unavailable', { tags });
    return;
  }

  try {
    const result = await ctx.cache.purge({ tags });
    if (!result.success) {
      logEvent('warn', 'worker_cache_purge_failed', { tags, errors: result.errors });
    }
  } catch (error) {
    logEvent('warn', 'worker_cache_purge_error', { tags, error: describeError(error) });
  }
}

/**
 * Only the JSON feed. The page is static and served by the assets binding, so it changes on
 * deploy and never on data — purging its tag on every upload continuously invalidated a
 * 600-second cache for no benefit.
 */
export async function purgePublicDataCache(ctx?: ExecutionContext): Promise<void> {
  await purgeTags([PUBLIC_LATEST_CACHE_TAG], ctx);
}

/** For after a deploy, where the HTML genuinely did change. Exposed via the admin API. */
export async function purgeAllPublicCache(ctx?: ExecutionContext): Promise<void> {
  await purgeTags([PUBLIC_HTML_CACHE_TAG, PUBLIC_LATEST_CACHE_TAG], ctx);
}

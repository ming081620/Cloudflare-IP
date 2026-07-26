import { handleApi } from './api';
import { claimAggregateLease } from './database';
import { rebuildPublicData, runScheduledMaintenance } from './public-api';
import { handleSpeedTest } from './speedtest';
import { describeError, logEvent } from './observability';
import type { Env } from './types';
import { jsonResponse, textResponse } from './utils';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      // `/` and every other static path are served by the assets binding before the worker is
      // invoked at all; wrangler.jsonc routes only /api/* and /__speedtest here. That also
      // retires the old HEAD / branch, which answered 200 with cacheable text/html headers and
      // no body — inconsistent with GET's content-length.
      if (url.pathname === '/__speedtest') {
        return handleSpeedTest(request, env);
      }
      if (url.pathname.startsWith('/api/')) {
        return handleApi(request, env, ctx);
      }
      return textResponse('Not Found', 404);
    } catch (error) {
      logEvent('error', 'request_failed', { path: url.pathname, error: describeError(error) });
      return jsonResponse({ success: false, error: '服务器内部错误' }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Deliberately awaited and unguarded: ctx.waitUntil would report a throwing rebuild
    // as a successful cron invocation, hiding it from Cloudflare's scheduled-failure surface.
    await runScheduledMaintenance(env);
    // Cron is the authoritative writer, so it takes the refresh lease by force rather than
    // skipping when an upload happens to hold it.
    await claimAggregateLease(env.DB, 60, true);
    await rebuildPublicData(env, ctx, { syncDns: true });
  }
};

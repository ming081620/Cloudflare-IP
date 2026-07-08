import { handleApi } from './api';
import { renderHtml } from './html';
import { rebuildPublicData } from './public-api';
import { handleSpeedTest } from './speedtest';
import type { Env } from './types';
import { cacheableHtmlResponse, publicHtmlHeaders, textResponse } from './utils';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'HEAD' && url.pathname === '/') {
        return new Response(null, {
          headers: publicHtmlHeaders()
        });
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return cacheableHtmlResponse(renderHtml());
      }
      if (url.pathname === '/__speedtest') {
        return handleSpeedTest(request);
      }
      if (url.pathname.startsWith('/api/')) {
        return handleApi(request, env, ctx);
      }
      return textResponse('Not Found', 404);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'request_failed', error: error instanceof Error ? error.message : String(error) }));
      return new Response(JSON.stringify({ success: false, error: '服务器内部错误' }), {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(rebuildPublicData(env, ctx));
  }
};

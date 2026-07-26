import { logEvent } from './observability';
import type { Env } from './types';
import { rateLimitedResponse } from './utils';

const DEFAULT_BYTES = 100 * 1024 * 1024;
const MIN_BYTES = 1024;
/** The OpenWrt client asks for 100 MB per run; the rest is headroom, not an allowance. */
const MAX_BYTES = 128 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

export async function handleSpeedTest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD' }
    });
  }

  // curl sends no sec-fetch-* headers, so the real client is unaffected. Browsers always
  // send them on secure contexts, which blocks third-party pages from burning egress via
  // their visitors. Previously this endpoint was open to every origin.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new Response('Forbidden', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // cfst issues -dn 8 downloads over several minutes, so 20/min is far above real usage.
  const clientIp = request.headers.get('cf-connecting-ip') ?? '';
  if (clientIp && env.SPEEDTEST_LIMITER) {
    const { success } = await env.SPEEDTEST_LIMITER.limit({ key: `st:${clientIp}` });
    if (!success) {
      logEvent('warn', 'rate_limited', { limiter: 'SPEEDTEST_LIMITER', key: `st:${clientIp}` });
      return rateLimitedResponse();
    }
  }

  const url = new URL(request.url);
  const bytes = parseBytes(url.searchParams.get('bytes'));
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes),
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex'
  };

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }

  return new Response(createByteStream(bytes), { headers });
}

function parseBytes(value: string | null): number {
  if (!value) {
    return DEFAULT_BYTES;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BYTES;
  }
  return Math.min(Math.max(parsed, MIN_BYTES), MAX_BYTES);
}

function createByteStream(totalBytes: number): ReadableStream<Uint8Array> {
  let remaining = totalBytes;
  const chunk = new Uint8Array(CHUNK_SIZE);

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_SIZE, remaining);
      controller.enqueue(size === CHUNK_SIZE ? chunk : chunk.subarray(0, size));
      remaining -= size;
    }
  });
}

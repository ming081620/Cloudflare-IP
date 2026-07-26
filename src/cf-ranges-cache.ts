import { bundledRanges, mergeRanges, parseCidrList, validateFetchedRanges, type ParsedRanges } from './cf-ranges';
import { describeError, logEvent } from './observability';
import type { Env } from './types';

const RANGES_KV_KEY = 'cf:ranges:v1';
const RANGES_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RefreshResult {
  updated: boolean;
  v4: number;
  v6: number;
  reason?: string;
}

interface StoredRanges {
  fetched_at: string;
  v4: string[];
  v6: string[];
}

let cached: ParsedRanges | undefined;

/**
 * Bundled ranges unioned with whatever the last successful refresh stored in KV. Never
 * fetches: refreshCloudflareRanges runs from the cron handler only, so the request path
 * keeps no network dependency and degrades to the bundled list if KV is unavailable.
 */
export async function loadCloudflareRanges(env: Env): Promise<ParsedRanges> {
  if (cached) {
    return cached;
  }

  try {
    const stored = await env.SPEED_TEST_KV.get<StoredRanges>(RANGES_KV_KEY, 'json');
    if (stored && Array.isArray(stored.v4) && Array.isArray(stored.v6)) {
      cached = mergeRanges(bundledRanges(), parseCidrList([...stored.v4, ...stored.v6]));
      return cached;
    }
  } catch (error) {
    logEvent('warn', 'cf_ranges_kv_read_failed', { error: describeError(error) });
  }

  cached = bundledRanges();
  return cached;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function refreshCloudflareRanges(env: Env): Promise<RefreshResult> {
  try {
    const [v4Response, v6Response] = await Promise.all([
      fetch('https://www.cloudflare.com/ips-v4', { headers: { accept: 'text/plain' } }),
      fetch('https://www.cloudflare.com/ips-v6', { headers: { accept: 'text/plain' } })
    ]);
    if (!v4Response.ok || !v6Response.ok) {
      const reason = `http_${v4Response.status}_${v6Response.status}`;
      logEvent('warn', 'cf_ranges_refresh_failed', { reason });
      return { updated: false, v4: 0, v6: 0, reason };
    }

    const v4 = splitLines(await v4Response.text());
    const v6 = splitLines(await v6Response.text());

    const reason = validateFetchedRanges(v4, v6);
    if (reason) {
      logEvent('warn', 'cf_ranges_refresh_rejected', { reason, v4: v4.length, v6: v6.length });
      return { updated: false, v4: v4.length, v6: v6.length, reason };
    }

    const payload: StoredRanges = { fetched_at: new Date().toISOString(), v4, v6 };
    await env.SPEED_TEST_KV.put(RANGES_KV_KEY, JSON.stringify(payload), { expirationTtl: RANGES_TTL_SECONDS });
    cached = undefined;
    logEvent('info', 'cf_ranges_refreshed', { v4: v4.length, v6: v6.length });
    return { updated: true, v4: v4.length, v6: v6.length };
  } catch (error) {
    logEvent('warn', 'cf_ranges_refresh_failed', { error: describeError(error) });
    return { updated: false, v4: 0, v6: 0, reason: 'fetch_failed' };
  }
}

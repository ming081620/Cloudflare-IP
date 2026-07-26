import { describeError, logEvent } from './observability';
import { checkKv } from './storage';
import type { Env } from './types';

/**
 * Roughly three cron intervals. Aggregates older than this mean the scheduled rebuild has been
 * failing silently, which was previously invisible.
 */
const AGGREGATE_STALE_SECONDS = 95 * 60;

interface Probe {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

async function probe(run: () => Promise<void>): Promise<Probe> {
  const started = Date.now();
  try {
    await run();
    return { ok: true, latency_ms: Date.now() - started };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, error: describeError(error) };
  }
}

/**
 * Reports on the dependencies the crowdtest path actually needs, and returns 503 when any of
 * them is unhealthy so an external uptime check turns every silent failure into an alert.
 *
 * The previous version only reported `kv_ok` and never touched D1 — the database the entire
 * public path depends on. It also could not distinguish a deploy that is missing ADMIN_TOKEN,
 * which typechecks fine and then 401s every admin route forever.
 */
export async function handleHealth(env: Env): Promise<Response> {
  const [kv, d1] = await Promise.all([
    probe(async () => {
      if (!(await checkKv(env.SPEED_TEST_KV))) {
        throw new Error('kv_read_failed');
      }
    }),
    probe(async () => {
      await env.DB.prepare('SELECT 1').first();
    })
  ]);

  let aggregates: { total: number; built_at: string | null; age_seconds: number | null } = {
    total: 0,
    built_at: null,
    age_seconds: null
  };

  if (d1.ok) {
    try {
      // Cheap, and doubles as the staleness signal — far more useful than a bare ping.
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS total, MAX(built_at) AS built_at FROM aggregates`
      ).first<{ total: number; built_at: string | null }>();
      const builtAt = row?.built_at || null;
      aggregates = {
        total: row?.total ?? 0,
        built_at: builtAt,
        age_seconds: builtAt ? Math.max(0, Math.round((Date.now() - Date.parse(builtAt)) / 1000)) : null
      };
    } catch (error) {
      logEvent('warn', 'health_aggregate_probe_failed', { error: describeError(error) });
    }
  }

  const dnsSync = env.DNS_API_TOKEN && env.DNS_ZONE_ID ? 'enabled' : 'disabled';
  const adminApi = env.ADMIN_TOKEN ? 'enabled' : 'disabled';
  const stale = aggregates.age_seconds !== null && aggregates.age_seconds > AGGREGATE_STALE_SECONDS;

  const problems: string[] = [];
  if (!kv.ok) {
    problems.push('kv_unavailable');
  }
  if (!d1.ok) {
    problems.push('d1_unavailable');
  }
  if (stale) {
    problems.push('aggregates_stale');
  }
  if (adminApi === 'disabled') {
    problems.push('admin_token_missing');
  }

  const status = problems.length ? 'degraded' : 'ok';
  if (problems.length) {
    logEvent('error', 'health_degraded', { problems, aggregate_age_seconds: aggregates.age_seconds });
  }

  return new Response(
    JSON.stringify({
      success: problems.length === 0,
      data: {
        status,
        problems,
        time: new Date().toISOString(),
        checks: { kv, d1 },
        aggregates,
        dns_sync: dnsSync,
        admin_api: adminApi
      }
    }),
    {
      // 503 so a plain uptime monitor alerts without needing to parse the body.
      status: problems.length ? 503 : 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    }
  );
}

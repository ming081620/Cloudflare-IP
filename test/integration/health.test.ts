import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleHealth } from '../../src/health';

interface HealthBody {
  success: boolean;
  data: {
    status: string;
    problems: string[];
    checks: { kv: { ok: boolean }; d1: { ok: boolean } };
    aggregates: { total: number; built_at: string | null; age_seconds: number | null };
    dns_sync: string;
    admin_api: string;
  };
}

async function health(overrides: Partial<typeof env> = {}): Promise<{ status: number; body: HealthBody }> {
  const response = await handleHealth({ ...env, ...overrides } as typeof env);
  return { status: response.status, body: (await response.json()) as HealthBody };
}

async function seedAggregate(builtAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO aggregates (key, ip_version, province_code, province_name, carrier, hostname, ip, port,
       record_type, speed, latency, loss, colo, nickname, upload_id, updated_at, built_at)
     VALUES ('gd:ct:v4', 'v4', 'gd', 'gd', 'ct', 'gd.ct.test', '104.16.1.1', 443, 'A', 10, 20, 0, 'HKG',
             'n', 'u1', ?1, ?1)`
  )
    .bind(builtAt)
    .run();
}

describe('handleHealth', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM aggregates').run();
  });

  it('reports ok and 200 when D1, KV and the admin token are all present', async () => {
    await seedAggregate(new Date().toISOString());

    const { status, body } = await health({ ADMIN_TOKEN: 'set' } as Partial<typeof env>);

    expect(status).toBe(200);
    expect(body.data.status).toBe('ok');
    expect(body.data.checks.d1.ok).toBe(true);
    expect(body.data.checks.kv.ok).toBe(true);
    expect(body.data.aggregates.total).toBe(1);
  });

  it('returns 503 when aggregates are stale, so an uptime check alerts', async () => {
    // Three cron intervals without a successful rebuild.
    await seedAggregate(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());

    const { status, body } = await health({ ADMIN_TOKEN: 'set' } as Partial<typeof env>);

    expect(status).toBe(503);
    expect(body.data.problems).toContain('aggregates_stale');
  });

  it('flags a deploy that is missing ADMIN_TOKEN instead of silently 401ing forever', async () => {
    await seedAggregate(new Date().toISOString());

    const { status, body } = await health({ ADMIN_TOKEN: undefined } as Partial<typeof env>);

    expect(status).toBe(503);
    expect(body.data.problems).toContain('admin_token_missing');
    expect(body.data.admin_api).toBe('disabled');
  });

  it('reports whether DNS sync is configured', async () => {
    await seedAggregate(new Date().toISOString());

    const disabled = await health({ ADMIN_TOKEN: 'set' } as Partial<typeof env>);
    expect(disabled.body.data.dns_sync).toBe('disabled');

    const enabled = await health({ ADMIN_TOKEN: 'set', DNS_API_TOKEN: 't', DNS_ZONE_ID: 'z' } as Partial<typeof env>);
    expect(enabled.body.data.dns_sync).toBe('enabled');
  });

  it('does not report staleness before the first rebuild has ever run', async () => {
    const { body } = await health({ ADMIN_TOKEN: 'set' } as Partial<typeof env>);

    expect(body.data.aggregates.age_seconds).toBeNull();
    expect(body.data.problems).not.toContain('aggregates_stale');
  });
});

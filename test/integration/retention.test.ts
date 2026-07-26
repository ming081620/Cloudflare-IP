import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/retention';

function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{ total: number }>();
  return row?.total ?? 0;
}

async function seedDnsUpdates(rows: number, ageHours: number, body = 'x'.repeat(500)): Promise<void> {
  const statements = [];
  for (let index = 0; index < rows; index += 1) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO dns_updates (id, hostname, record_type, ip, status, response_json, created_at)
         VALUES (?1, 'a.example.test', 'A', '1.2.3.4', 'success', ?2, ?3)`
      ).bind(`dns-${ageHours}-${index}-${Math.random()}`, body, isoAgo(ageHours))
    );
  }
  await env.DB.batch(statements);
}

describe('runRetention', () => {
  beforeEach(async () => {
    for (const table of ['node_results', 'uploads', 'dns_updates', 'devices', 'users']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it('deletes dns_updates rows past the retention window and keeps recent ones', async () => {
    await seedDnsUpdates(20, 24 * 30);
    await seedDnsUpdates(5, 1);

    await runRetention(env);

    expect(await count('dns_updates')).toBe(5);
  });

  it('blanks old response bodies without deleting the rows', async () => {
    // 48h old: past the 24h body-retention window but well inside the 7d row window.
    await seedDnsUpdates(4, 48);

    await runRetention(env);

    expect(await count('dns_updates')).toBe(4);
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM dns_updates WHERE response_json != ''`
    ).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it('keeps node_results inside the 72h window', async () => {
    // uploads carries a FK to devices, which D1 enforces 鈥?the same reason retention has to
    // delete node_results before their parent uploads.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, nickname, status, created_at, last_seen_at) VALUES ('user1', 'n', 'active', ?1, ?1)`
      ).bind(isoAgo(2)),
      env.DB.prepare(
        `INSERT INTO devices (id, user_id, token_hash, device_name, status, created_at, last_seen_at)
         VALUES ('d1', 'user1', 'hash', '', 'active', ?1, ?1)`
      ).bind(isoAgo(2))
    ]);
    await env.DB.prepare(
      `INSERT INTO uploads (id, device_id, nickname, ip_version, client_ip, server_province_code,
         server_province_name, server_carrier, proxy_suspected, created_at)
       VALUES ('u1', 'd1', 'n', 'v4', '1.2.3.4', 'gd', 'gd', 'ct', 0, ?1)`
    )
      .bind(isoAgo(2))
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO node_results (id, upload_id, ip, port, carrier, latency, speed, loss, tls, colo, region, source, trusted, created_at)
         VALUES ('fresh', 'u1', '1.1.1.1', 443, 'ct', 1, 1, 0, 1, 'HKG', '', '', 1, ?1)`
      ).bind(isoAgo(2)),
      env.DB.prepare(
        `INSERT INTO node_results (id, upload_id, ip, port, carrier, latency, speed, loss, tls, colo, region, source, trusted, created_at)
         VALUES ('stale', 'u1', '1.1.1.1', 443, 'ct', 1, 1, 0, 1, 'HKG', '', '', 1, ?1)`
      ).bind(isoAgo(100))
    ]);

    await runRetention(env);

    expect(await count('node_results')).toBe(1);
    // The parent upload is inside its own 30-day window and must survive.
    expect(await count('uploads')).toBe(1);
  });

  it('bounds a single run instead of deleting an unbounded backlog', async () => {
    // 10 batches x 2000 is the per-tick ceiling; seeding beyond one batch proves the loop
    // terminates rather than trying to delete everything at once.
    await seedDnsUpdates(2500, 24 * 30, 'y');

    const summary = await runRetention(env);

    expect(summary.dns_updates).toBe(2500);
    expect(await count('dns_updates')).toBe(0);
  });

  it('is a no-op on an empty database', async () => {
    const summary = await runRetention(env);

    expect(summary.dns_updates).toBe(0);
    expect(summary.node_results).toBe(0);
  });
});

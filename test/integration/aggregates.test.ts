import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAggregates, rebuildAggregates } from '../../src/database';

const ROOT = 'example.test';
const CF_IP = '104.16.132.229';
const CF_IP_2 = '172.67.1.1';

function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

interface SeedUpload {
  deviceId?: string;
  nickname?: string;
  ipVersion?: 'v4' | 'v6';
  province?: string;
  carrier?: string;
  createdAt?: string;
  proxySuspected?: 0 | 1;
  deviceStatus?: string;
  userStatus?: string;
  nodes?: Array<{ ip?: string; speed?: number; latency?: number; colo?: string; trusted?: 0 | 1; createdAt?: string }>;
}

/** Creates a user + device + upload + node_results in one go. */
async function seedUpload(input: SeedUpload = {}): Promise<string> {
  const deviceId = input.deviceId ?? nextId('dev');
  const nickname = input.nickname ?? nextId('nick');
  const createdAt = input.createdAt ?? isoAgo(1);
  const uploadId = nextId('up');
  const userId = `user-${deviceId}`;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, nickname, status, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)`
  )
    .bind(userId, nickname, input.userStatus ?? 'active', createdAt)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, user_id, token_hash, device_name, status, created_at, last_seen_at)
     VALUES (?1, ?2, 'hash', '', ?3, ?4, ?4)`
  )
    .bind(deviceId, userId, input.deviceStatus ?? 'active', createdAt)
    .run();

  await env.DB.prepare(
    `INSERT INTO uploads (
       id, device_id, nickname, ip_version, client_ip, server_province_code, server_province_name,
       server_carrier, proxy_suspected, created_at
     ) VALUES (?1, ?2, ?3, ?4, '1.2.3.4', ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      uploadId,
      deviceId,
      nickname,
      input.ipVersion ?? 'v4',
      input.province ?? 'gd',
      input.province ?? 'gd',
      input.carrier ?? 'ct',
      input.proxySuspected ?? 0,
      createdAt
    )
    .run();

  for (const node of input.nodes ?? [{}]) {
    await env.DB.prepare(
      `INSERT INTO node_results (
         id, upload_id, ip, port, carrier, latency, speed, loss, tls, colo, region, source, trusted, created_at,
         cf_range_ok, dns_eligible
       ) VALUES (?1, ?2, ?3, 443, ?4, ?5, ?6, 0, 1, ?7, '', '', ?8, ?9, 1, 1)`
    )
      .bind(
        nextId('node'),
        uploadId,
        node.ip ?? CF_IP,
        input.carrier ?? 'ct',
        node.latency ?? 40,
        node.speed ?? 50,
        node.colo ?? 'HKG',
        node.trusted ?? 1,
        node.createdAt ?? createdAt
      )
      .run();
  }

  return uploadId;
}

async function reset(): Promise<void> {
  for (const table of ['node_results', 'uploads', 'aggregates', 'devices', 'users', 'dns_updates']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('rebuildAggregates', () => {
  beforeEach(reset);

  it('excludes uploads older than the 24h window', async () => {
    await seedUpload({ createdAt: isoAgo(48), nodes: [{ createdAt: isoAgo(48) }] });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates).toHaveLength(0);
  });

  it('produces one aggregate per device even when two uploads share a timestamp', async () => {
    // The old join matched latest_uploads on created_at equality, so both rows matched and
    // the device was counted twice.
    const sharedTimestamp = isoAgo(1);
    await seedUpload({ deviceId: 'dup-device', nickname: 'dup', createdAt: sharedTimestamp, nodes: [{ speed: 50 }] });
    await seedUpload({ deviceId: 'dup-device', nickname: 'dup', createdAt: sharedTimestamp, nodes: [{ speed: 60 }] });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates).toHaveLength(1);
  });

  it('keeps a province whose best node ranks below the global top 1000', async () => {
    // The old LIMIT 1000 applied before the per-key dedupe, so a slow province vanished
    // entirely once faster ones filled the window. Seeded in one batch to keep this quick.
    const createdAt = isoAgo(1);
    const statements = [];
    for (let index = 0; index < 1100; index += 1) {
      const deviceId = `fast-${index}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO users (id, nickname, status, created_at, last_seen_at) VALUES (?1, ?2, 'active', ?3, ?3)`
        ).bind(`user-${deviceId}`, deviceId, createdAt),
        env.DB.prepare(
          `INSERT INTO devices (id, user_id, token_hash, device_name, status, created_at, last_seen_at)
           VALUES (?1, ?2, 'hash', '', 'active', ?3, ?3)`
        ).bind(deviceId, `user-${deviceId}`, createdAt),
        env.DB.prepare(
          `INSERT INTO uploads (id, device_id, nickname, ip_version, client_ip, server_province_code,
             server_province_name, server_carrier, proxy_suspected, created_at)
           VALUES (?1, ?2, ?3, 'v4', '1.2.3.4', 'zj', 'zj', 'ct', 0, ?4)`
        ).bind(`up-${deviceId}`, deviceId, deviceId, createdAt),
        env.DB.prepare(
          `INSERT INTO node_results (id, upload_id, ip, port, carrier, latency, speed, loss, tls, colo,
             region, source, trusted, created_at, cf_range_ok, dns_eligible)
           VALUES (?1, ?2, ?3, 443, 'ct', 40, ?4, 0, 1, 'HKG', '', '', 1, ?5, 1, 1)`
        ).bind(`node-${deviceId}`, `up-${deviceId}`, CF_IP, 500 + index, createdAt)
      );
    }
    await env.DB.batch(statements);
    await seedUpload({ deviceId: 'slow', nickname: 'slow', province: 'xz', nodes: [{ speed: 1, ip: CF_IP_2 }] });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates.map((item) => item.province_code)).toContain('xz');
  });

  it('does not empty the table when a rebuild finds no rows', async () => {
    await seedUpload({ province: 'gd' });
    const first = await rebuildAggregates(env.DB, ROOT);
    expect(first).toHaveLength(1);

    // Simulate the window going quiet: every upload ages out.
    await env.DB.prepare('UPDATE uploads SET created_at = ?1').bind(isoAgo(72)).run();
    await env.DB.prepare('UPDATE node_results SET created_at = ?1').bind(isoAgo(72)).run();

    await rebuildAggregates(env.DB, ROOT);

    // An empty result is a query fault, not "no data" 鈥?the serving path must survive it.
    expect(await readAggregates(env.DB)).toHaveLength(1);
  });

  it('excludes proxy-suspected, unknown-colo, blocked-device and blocked-user data', async () => {
    await seedUpload({ province: 'bj', proxySuspected: 1 });
    await seedUpload({ province: 'sh', nodes: [{ colo: 'N/A' }] });
    await seedUpload({ province: 'tj', nodes: [{ colo: '' }] });
    await seedUpload({ province: 'cq', deviceStatus: 'blocked' });
    await seedUpload({ province: 'ha', userStatus: 'blocked' });
    await seedUpload({ province: 'hb', nodes: [{ trusted: 0 }] });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates).toHaveLength(0);
  });

  it('is deterministic when two nodes tie on speed and latency', async () => {
    await seedUpload({ deviceId: 'tie-a', nickname: 'tie-a', nodes: [{ ip: CF_IP, speed: 50, latency: 40 }] });
    await seedUpload({ deviceId: 'tie-b', nickname: 'tie-b', nodes: [{ ip: CF_IP_2, speed: 50, latency: 40 }] });

    const first = await rebuildAggregates(env.DB, ROOT);
    const second = await rebuildAggregates(env.DB, ROOT);

    expect(first[0].ip).toBe(second[0].ip);
  });

  it('picks the fastest eligible node for the province', async () => {
    await seedUpload({
      province: 'gd',
      nodes: [
        { ip: CF_IP, speed: 20, latency: 60 },
        { ip: CF_IP_2, speed: 90, latency: 30 }
      ]
    });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].ip).toBe(CF_IP_2);
    expect(aggregates[0].hostname).toBe(`gd.ct.${ROOT}`);
  });

  it('names IPv6 aggregates with the v6 hostname scheme', async () => {
    await seedUpload({ province: 'zj', ipVersion: 'v6', nodes: [{ ip: '2606:4700:3119::ac40:99e5' }] });

    const aggregates = await rebuildAggregates(env.DB, ROOT);

    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].hostname).toBe(`zj.ct.v6.${ROOT}`);
    expect(aggregates[0].record_type).toBe('AAAA');
  });
});

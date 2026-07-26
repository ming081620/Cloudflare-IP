import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimAggregateLease, loadKeySupport, rebuildAggregates } from '../../src/database';
import { rebuildPublicData, runScheduledMaintenance } from '../../src/public-api';

describe('loadKeySupport', () => {
  beforeEach(async () => {
    for (const table of ['node_results', 'uploads', 'aggregates', 'devices', 'users', 'device_pins']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it('runs against an empty database', async () => {
    const support = await loadKeySupport(env.DB, 24);
    expect(support.size).toBe(0);
  });

  it('counts distinct devices and network prefixes per key', async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, nickname, status, created_at, last_seen_at) VALUES ('u1','a','active',?1,?1)`).bind(now),
      env.DB.prepare(`INSERT INTO users (id, nickname, status, created_at, last_seen_at) VALUES ('u2','b','active',?1,?1)`).bind(now),
      env.DB.prepare(`INSERT INTO devices (id,user_id,token_hash,device_name,status,created_at,last_seen_at) VALUES ('d1','u1','h','','active',?1,?1)`).bind(now),
      env.DB.prepare(`INSERT INTO devices (id,user_id,token_hash,device_name,status,created_at,last_seen_at) VALUES ('d2','u2','h','','active',?1,?1)`).bind(now),
      env.DB.prepare(
        `INSERT INTO uploads (id,device_id,nickname,ip_version,client_ip,server_province_code,server_province_name,server_carrier,proxy_suspected,created_at,cf_client_ip_prefix,trust_level)
         VALUES ('up1','d1','a','v4','1.2.3.4','gd','广东','ct',0,?1,'1.2.3.0/24','confirmed')`
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO uploads (id,device_id,nickname,ip_version,client_ip,server_province_code,server_province_name,server_carrier,proxy_suspected,created_at,cf_client_ip_prefix,trust_level)
         VALUES ('up2','d2','b','v4','5.6.7.8','gd','广东','ct',0,?1,'5.6.7.0/24','confirmed')`
      ).bind(now)
    ]);

    const support = await loadKeySupport(env.DB, 24);
    const gd = support.get('gd:ct:v4');

    expect(gd).toBeDefined();
    expect(gd!.devices).toBe(2);
    expect(gd!.prefixes).toBe(2);
  });

  it('lets rebuildAggregates run end to end without throwing', async () => {
    // The cron path calls this; a failure here previously surfaced only as a 500 with no log.
    await expect(rebuildAggregates(env.DB, 'example.test')).resolves.toBeInstanceOf(Array);
  });

  it('runs the whole scheduled sequence the cron handler performs', async () => {
    // Mirrors src/index.ts's scheduled(): maintenance, forced lease, rebuild with DNS sync.
    await runScheduledMaintenance(env);
    await claimAggregateLease(env.DB, 60, true);
    await expect(rebuildPublicData(env, undefined, { syncDns: true })).resolves.toBeInstanceOf(Array);
  });
});

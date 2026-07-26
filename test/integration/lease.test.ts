import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimAggregateLease } from '../../src/database';

describe('claimAggregateLease', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM system_state').run();
  });

  it('grants the lease to exactly one of several concurrent callers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimAggregateLease(env.DB, 60)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a second claim while the lease is held', async () => {
    expect(await claimAggregateLease(env.DB, 60)).toBe(true);
    expect(await claimAggregateLease(env.DB, 60)).toBe(false);
  });

  it('grants the lease again once it has expired', async () => {
    // A zero-second cooldown expires immediately, which is also the documented "rebuild on
    // every upload" setting.
    expect(await claimAggregateLease(env.DB, 0)).toBe(true);
    expect(await claimAggregateLease(env.DB, 60)).toBe(true);
  });

  it('lets the cron take the lease by force', async () => {
    expect(await claimAggregateLease(env.DB, 60)).toBe(true);
    expect(await claimAggregateLease(env.DB, 60)).toBe(false);

    // Cron must never be skipped just because an upload happened to hold the lease.
    expect(await claimAggregateLease(env.DB, 60, true)).toBe(true);
  });
});

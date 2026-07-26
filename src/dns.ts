import { isCloudflareIp } from './cf-ranges';
import { loadCloudflareRanges } from './cf-ranges-cache';
import {
  listActiveDnsTargets,
  readSystemState,
  recentlyUpdatedDns,
  recordDnsUpdate,
  writeSystemState,
  type DnsTarget
} from './database';
import { describeError, logEvent } from './observability';
import type { Env, PublicAggregate } from './types';
import { isIpv4Address, isIpv6Address } from './utils';

const DNS_UPDATE_MIN_INTERVAL_MINUTES = 30;

/**
 * Cloudflare's API quota is 1200 requests per 5 minutes for the whole user, shared by every
 * token on the account. Once exhausted the API answers 10429 — and a run that keeps going digs
 * the hole deeper. In 2026-07 the per-hostname listing pattern produced a self-sustaining storm
 * (178k failed calls over 19 days): failures never satisfied the 30-minute success throttle, so
 * every rebuild retried every hostname. The first 429 now aborts the run and pauses DNS work.
 */
const DNS_BACKOFF_STATE_KEY = 'dns:backoff_until';
const DNS_BACKOFF_MINUTES = 30;

/** A challenger must be this much faster to unseat a still-fresh incumbent. */
const DNS_CHALLENGER_SPEED_RATIO = 1.2;
const DNS_INCUMBENT_MIN_AGE_MINUTES = 120;

/** One page covers the ~200 managed records; the cap only bounds a runaway zone. */
const DNS_LIST_PAGE_SIZE = 500;
const DNS_LIST_MAX_PAGES = 20;

interface ZoneRecordGroup {
  /** Every record id sharing name|type; duplicates can exist if records were created by hand. */
  ids: string[];
  /** Content of the first record, used for the no-op check. */
  content: string;
}

type MutationOutcome = 'done' | 'rate_limited';

export async function updateDnsForAggregates(env: Env, aggregates: PublicAggregate[]): Promise<void> {
  if (!env.DNS_API_TOKEN || !env.DNS_ZONE_ID) {
    logEvent('warn', 'dns_sync_disabled', {
      has_token: Boolean(env.DNS_API_TOKEN),
      has_zone: Boolean(env.DNS_ZONE_ID),
      pending_aggregates: aggregates.length
    });
    return;
  }

  const backoffUntil = await readSystemState(env.DB, DNS_BACKOFF_STATE_KEY);
  if (backoffUntil && Date.parse(backoffUntil) > Date.now()) {
    logEvent('warn', 'dns_sync_backoff_active', { until: backoffUntil, pending_aggregates: aggregates.length });
    return;
  }

  // Defence in depth, and a retroactive one: the aggregate window is 24h, so rows inserted
  // before the ingest-side check shipped are still live. This blocks them on the next run.
  const ranges = await loadCloudflareRanges(env);
  const writable: PublicAggregate[] = [];
  for (const aggregate of aggregates) {
    // Candidate rows are visible on the panel but have not earned enough independent
    // corroboration to steer a record.
    if (aggregate.trust_level && aggregate.trust_level !== 'confirmed') {
      logEvent('info', 'dns_skipped_uncorroborated', {
        hostname: aggregate.hostname,
        trust_level: aggregate.trust_level,
        support_devices: aggregate.support_devices,
        support_rule: aggregate.support_rule
      });
      continue;
    }

    const familyOk = aggregate.record_type === 'AAAA' ? isIpv6Address(aggregate.ip) : isIpv4Address(aggregate.ip);
    if (!familyOk || !isCloudflareIp(aggregate.ip, ranges)) {
      logEvent('error', 'dns_blocked_non_cloudflare_ip', {
        hostname: aggregate.hostname,
        record_type: aggregate.record_type,
        ip: aggregate.ip,
        upload_id: aggregate.upload_id
      });
      await recordDnsUpdate(env.DB, aggregate.hostname, aggregate.record_type, aggregate.ip, 'blocked_non_cloudflare_ip', '');
      continue;
    }
    writable.push(aggregate);
  }

  // One zone-wide listing replaces the per-hostname GET that used to precede every write and
  // delete: reconciliation now costs O(changed records) API calls instead of O(hostnames).
  const listing = await listZoneDnsRecords(env);
  if (!listing.ok) {
    // A single log row for the whole run — the per-hostname variant of this insert is what
    // grew dns_updates by 200k rows during the storm.
    await recordDnsUpdate(env.DB, '*', 'ZONE', '', 'list_failed', listing.detail);
    if (listing.rateLimited) {
      await tripDnsBackoff(env.DB);
    }
    return;
  }

  const desiredTargets = new Set(writable.map((aggregate) => targetKey(aggregate)));

  for (const aggregate of writable) {
    const existing = listing.records.get(targetKey(aggregate));
    if (existing && existing.content === aggregate.ip) {
      // Upstream is already correct: no API call, no log row.
      continue;
    }
    if (existing && !(await challengerMayReplace(env, aggregate, existing.content))) {
      continue;
    }
    if (await recentlyUpdatedDns(env.DB, aggregate.hostname, aggregate.record_type, aggregate.ip, DNS_UPDATE_MIN_INTERVAL_MINUTES)) {
      continue;
    }
    if ((await upsertDnsRecord(env, aggregate, existing?.ids[0])) === 'rate_limited') {
      await tripDnsBackoff(env.DB);
      return;
    }
  }

  await deleteStaleDnsRecords(env, desiredTargets, listing.records);
}

/**
 * Churn damping. Taking over a hostname that already points somewhere else requires being
 * meaningfully faster AND letting the incumbent hold for a while first, so a successful
 * poisoner needs sustained effort rather than one lucky request — and the maintainer gets
 * hours of warning from the dns_skipped_churn log.
 *
 * An incumbent that has vanished from the aggregate window is replaced freely; this only
 * governs contested handovers.
 */
async function challengerMayReplace(env: Env, aggregate: PublicAggregate, incumbentIp: string): Promise<boolean> {
  const incumbent = await env.DB.prepare(
    `SELECT speed, updated_at FROM aggregates WHERE key = ?1 AND ip = ?2`
  )
    .bind(aggregate.key, incumbentIp)
    .first<{ speed: number; updated_at: string }>();

  if (!incumbent) {
    return true;
  }

  const incumbentAgeMinutes = (Date.now() - Date.parse(incumbent.updated_at)) / 60000;
  if (!Number.isFinite(incumbentAgeMinutes) || incumbentAgeMinutes >= DNS_INCUMBENT_MIN_AGE_MINUTES) {
    return true;
  }
  if (aggregate.speed >= incumbent.speed * DNS_CHALLENGER_SPEED_RATIO) {
    return true;
  }

  logEvent('info', 'dns_skipped_churn', {
    hostname: aggregate.hostname,
    incumbent_ip: incumbentIp,
    incumbent_speed: incumbent.speed,
    challenger_ip: aggregate.ip,
    challenger_speed: aggregate.speed,
    incumbent_age_minutes: Math.round(incumbentAgeMinutes)
  });
  return false;
}

async function listZoneDnsRecords(
  env: Env
): Promise<{ ok: true; records: Map<string, ZoneRecordGroup> } | { ok: false; rateLimited: boolean; detail: string }> {
  const records = new Map<string, ZoneRecordGroup>();
  for (let page = 1; page <= DNS_LIST_MAX_PAGES; page += 1) {
    const url = `https://api.cloudflare.com/client/v4/zones/${env.DNS_ZONE_ID}/dns_records?per_page=${DNS_LIST_PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, { headers: dnsApiHeaders(env) });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, rateLimited: isRateLimited(response, text), detail: text };
    }
    const data = parseCloudflareList(text);
    if (!data) {
      return { ok: false, rateLimited: false, detail: text };
    }
    for (const record of data.result ?? []) {
      if ((record.type !== 'A' && record.type !== 'AAAA') || !record.name) {
        continue;
      }
      const key = `${record.name}|${record.type}`;
      const existing = records.get(key);
      if (existing) {
        existing.ids.push(record.id);
      } else {
        records.set(key, { ids: [record.id], content: record.content ?? '' });
      }
    }
    const totalPages = data.result_info?.total_pages ?? 1;
    if (page >= totalPages) {
      break;
    }
  }
  return { ok: true, records };
}

async function upsertDnsRecord(env: Env, aggregate: PublicAggregate, recordId: string | undefined): Promise<MutationOutcome> {
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${env.DNS_ZONE_ID}/dns_records`;
  const body = JSON.stringify({
    type: aggregate.record_type,
    name: aggregate.hostname,
    content: aggregate.ip,
    ttl: 300,
    proxied: false,
    comment: `cf-ip-speed-panel auto update: ${aggregate.province_name} ${aggregate.carrier_label}`
  });

  const response = recordId
    ? await fetch(`${endpoint}/${recordId}`, { method: 'PUT', headers: dnsApiHeaders(env), body })
    : await fetch(endpoint, { method: 'POST', headers: dnsApiHeaders(env), body });
  const responseText = await response.text();
  await recordDnsUpdate(env.DB, aggregate.hostname, aggregate.record_type, aggregate.ip, response.ok ? 'success' : 'update_failed', responseText);
  return !response.ok && isRateLimited(response, responseText) ? 'rate_limited' : 'done';
}

async function deleteStaleDnsRecords(env: Env, desiredTargets: Set<string>, zoneRecords: Map<string, ZoneRecordGroup>): Promise<void> {
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${env.DNS_ZONE_ID}/dns_records`;
  const activeTargets = await listActiveDnsTargets(env.DB);
  for (const target of activeTargets) {
    if (desiredTargets.has(targetKey(target))) {
      continue;
    }
    const existing = zoneRecords.get(targetKey(target));
    if (!existing) {
      // Keeps listActiveDnsTargets converging: the delete_success row retires the target.
      await recordDnsUpdate(env.DB, target.hostname, target.record_type, '', 'delete_success', 'record already absent');
      continue;
    }
    for (const recordId of existing.ids) {
      const response = await fetch(`${endpoint}/${recordId}`, { method: 'DELETE', headers: dnsApiHeaders(env) });
      const responseText = await response.text();
      await recordDnsUpdate(env.DB, target.hostname, target.record_type, '', response.ok ? 'delete_success' : 'delete_failed', responseText);
      if (!response.ok && isRateLimited(response, responseText)) {
        await tripDnsBackoff(env.DB);
        return;
      }
    }
  }
}

function dnsApiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.DNS_API_TOKEN}`,
    'content-type': 'application/json'
  };
}

function isRateLimited(response: Response, body: string): boolean {
  return response.status === 429 || body.includes('"code":10429') || body.includes('"code": 10429');
}

async function tripDnsBackoff(db: D1Database): Promise<void> {
  const until = new Date(Date.now() + DNS_BACKOFF_MINUTES * 60 * 1000).toISOString();
  await writeSystemState(db, DNS_BACKOFF_STATE_KEY, until);
  logEvent('warn', 'dns_sync_backoff_tripped', { until });
}

function parseCloudflareList(
  text: string
): { result?: Array<{ id: string; name?: string; type?: string; content?: string }>; result_info?: { total_pages?: number } } | null {
  try {
    return JSON.parse(text) as {
      result?: Array<{ id: string; name?: string; type?: string; content?: string }>;
      result_info?: { total_pages?: number };
    };
  } catch (error) {
    logEvent('warn', 'dns_list_parse_failed', { error: describeError(error) });
    return null;
  }
}

function targetKey(target: Pick<DnsTarget, 'hostname' | 'record_type'>): string {
  return `${target.hostname}|${target.record_type}`;
}

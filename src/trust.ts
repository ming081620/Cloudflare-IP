import type { Carrier, DirectCheckResult, GeoSource, ServerGeo, TrustLevel } from './types';

/**
 * Server-side trust decisions, derived exclusively from `request.cf`.
 *
 * Deliberately free of runtime imports so the regression runner can load it directly, and
 * deliberately pure so the whole model is table-testable without D1 or a Request.
 */

export interface HardVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * Mirrors the advisory heuristic the OpenWrt client already applies to its own egress
 * (cf-ip-speed-client around line 297). A client-side check can simply be omitted from a
 * forged payload, so the authoritative copy has to live here.
 *
 * Word boundaries matter: a bare /cloud/ substring also matches legitimate Chinese
 * residential AS names that happen to contain it.
 */
const HOSTING_ORG_PATTERN =
  /alibaba|aliyun|amazon|\baws\b|google|microsoft|azure|tencent|huawei|oracle|digitalocean|linode|akamai|vultr|hetzner|\bovh\b|contabo|choopa|leaseweb|m247|cogent|hurricane|\bcloud\b|hosting|colocation|data\s?cent(?:er|re)|\bidc\b|\bvps\b|dedicated\s+server/i;

/** Hosting and transit ASNs that must never be accepted as a residential contributor. */
const HOSTING_ASNS = new Set([
  14061, // DigitalOcean
  16509, 14618, // Amazon
  15169, 396982, // Google
  8075, // Microsoft
  16276, // OVH
  24940, // Hetzner
  20473, // Vultr/Choopa
  63949, // Akamai/Linode
  45102, 37963, // Alibaba
  45090, 132203, // Tencent
  55990, 136907, // Huawei
  31898, // Oracle
  23724 // CHINANET IDC
]);

/**
 * The one verdict a client cannot influence. Callers must AND this into any trust decision
 * *after* merging client-supplied geo, so no request-body field can flip it.
 */
export function serverHardVerdict(cf: Pick<ServerGeo, 'country' | 'asn' | 'asOrganization'>): HardVerdict {
  const reasons: string[] = [];

  if (cf.country !== 'CN') {
    reasons.push('cf_country_not_cn');
  }
  if (HOSTING_ORG_PATTERN.test(cf.asOrganization ?? '')) {
    reasons.push('cf_org_is_hosting');
  }
  if (cf.asn !== undefined && HOSTING_ASNS.has(cf.asn)) {
    reasons.push('cf_asn_is_hosting');
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * The whole trust model in one sentence: *client input may select among values the server
 * could not determine, and may never overrule a value the server did determine.* Every rule
 * below is a mechanical application of it.
 */
export interface DeviceHistoryGeo {
  province_code: string;
  province_name: string;
  carrier: Carrier;
  cf_asn?: number;
  geo_source: GeoSource;
}

export interface TrustInput {
  /** From request.cf only, before any client-supplied geo has been merged in. */
  cf: ServerGeo;
  directCheck: DirectCheckResult;
  /** Server-observed history for this device; never rows whose geo came from a client claim. */
  history?: DeviceHistoryGeo;
  pin?: { province_code: string; carrier: Carrier };
  /** ASN → carrier from the carrier_asns table. Authoritative when it hits. */
  carrierByAsn?: (asn: number | undefined) => Carrier | undefined;
  /** Province lookup, injected so this module stays free of runtime imports. */
  detectProvince: (...values: Array<string | undefined>) => { code: string; name: string };
  deviceAgeHours: number;
  priorConfirmedUploads: number;
}

export interface TrustOutcome {
  geo: ServerGeo;
  tier: TrustLevel;
  geo_source: GeoSource;
  geo_conflict: boolean;
  reasons: string[];
}

const TIER_RANK: Record<TrustLevel, number> = { confirmed: 2, candidate: 1, untrusted: 0 };

function cap(current: TrustLevel, ceiling: TrustLevel): TrustLevel {
  return TIER_RANK[ceiling] < TIER_RANK[current] ? ceiling : current;
}

/**
 * Pure: no D1, no Request. That keeps the entire model table-testable with no infrastructure,
 * which matters because it is the control that decides what steers real DNS records.
 */
export function decideTrust(input: TrustInput): TrustOutcome {
  const reasons: string[] = [];
  const { cf, directCheck } = input;

  const untrusted = (geoSource: GeoSource, conflict = false): TrustOutcome => ({
    geo: cf,
    tier: 'untrusted',
    geo_source: geoSource,
    geo_conflict: conflict,
    reasons
  });

  // 1. The verdict no payload field can flip.
  const hard = serverHardVerdict(cf);
  if (!hard.ok) {
    reasons.push(...hard.reasons);
    return untrusted('none');
  }

  // 2. The client may lower trust, never raise it.
  if (directCheck.proxy_suspected) {
    reasons.push('client_reported_proxy');
    return untrusted('none');
  }
  if (directCheck.egress_country && directCheck.egress_country !== 'CN') {
    reasons.push('client_egress_not_cn');
    return untrusted('none');
  }

  let tier: TrustLevel = 'confirmed';

  // 3. Carrier: ASN is authoritative, the organization string is a downgrade.
  let carrier = input.carrierByAsn?.(cf.asn);
  if (!carrier) {
    carrier = cf.carrier;
    if (carrier !== 'other') {
      reasons.push('carrier_from_org_string');
      tier = cap(tier, 'candidate');
    }
  }
  if (!carrier || carrier === 'other') {
    reasons.push('carrier_unknown');
    return untrusted('none');
  }

  // 4. Province, first hit wins.
  let province: { code: string; name: string } | undefined;
  let geoSource: GeoSource = 'none';

  if (input.pin) {
    province = { code: input.pin.province_code, name: cf.province_name };
    carrier = input.pin.carrier;
    geoSource = 'pin';
  } else {
    const fromCf = input.detectProvince(cf.region, cf.city);
    if (fromCf.code !== 'unknown') {
      province = fromCf;
      geoSource = 'cf';
    } else if (input.history && (input.history.cf_asn === cf.asn || input.history.carrier === carrier)) {
      province = { code: input.history.province_code, name: input.history.province_name };
      carrier = input.history.carrier;
      geoSource = 'device_history';
    } else {
      const claimed = input.detectProvince(directCheck.egress_region, directCheck.egress_city);
      if (claimed.code !== 'unknown') {
        province = claimed;
        geoSource = 'client_narrow';
        reasons.push('province_from_client');
        tier = cap(tier, 'candidate');
      }
    }
  }

  if (!province) {
    reasons.push('province_unknown');
    return untrusted('none');
  }

  // 5. Conflict detection. This is the attack signature: a legitimate client has no reason to
  // assert a province the edge already resolved differently.
  let conflict = false;
  const cfProvince = input.detectProvince(cf.region, cf.city);
  if (cfProvince.code !== 'unknown') {
    const claimed = input.detectProvince(directCheck.egress_region, directCheck.egress_city);
    if (claimed.code !== 'unknown' && claimed.code !== cfProvince.code) {
      reasons.push('geo_conflict_hard');
      conflict = true;
      return untrusted(geoSource, true);
    }
  }

  // 6. A brand-new device has no track record to lean on.
  if (input.deviceAgeHours < 24 || input.priorConfirmedUploads < 1) {
    reasons.push('new_device');
    tier = cap(tier, 'candidate');
  }

  return {
    geo: { ...cf, province_code: province.code, province_name: province.name, carrier },
    tier,
    geo_source: geoSource,
    geo_conflict: conflict,
    reasons
  };
}

export interface KeySupportEvidence {
  devices: number;
  prefixes: number;
  oldest_device_age_hours: number;
  best_device_confirmed_uploads: number;
  best_device_active_days: number;
  /** >1 means the contributor has flip-flopped between provinces or carriers. */
  best_device_distinct_keys: number;
  pinned: number;
}

export interface SupportVerdict {
  /** Whether this key may steer a DNS record. */
  eligible: boolean;
  /** 'R1' | 'R2' | 'R3' | 'none' — which rule granted it. */
  rule: string;
  tier: TrustLevel;
}

const R2_MIN_DEVICE_AGE_HOURS = 7 * 24;
const R2_MIN_CONFIRMED_UPLOADS = 5;
const R2_MIN_ACTIVE_DAYS = 3;

/**
 * A key becomes DNS-eligible under any one of three rules.
 *
 * R1 — independent agreement: two or more devices on two or more distinct network prefixes.
 * R2 — established sole contributor: one device, but a week old with a real track record and
 *      no history of switching province or carrier. This is the realistic path for provinces
 *      with a single contributor (Tibet, Qinghai, Ningxia).
 * R3 — admin pin: instant, manual, for a brand-new sole contributor in an uncovered province.
 *
 * Accepted product cost: a new sole contributor waits up to seven days, or needs a pin. That
 * province had no record before them, so this delays a gain rather than causing a regression.
 */
export function judgeKeySupport(evidence: KeySupportEvidence): SupportVerdict {
  if (evidence.pinned) {
    return { eligible: true, rule: 'R3', tier: 'confirmed' };
  }

  if (evidence.devices >= 2 && evidence.prefixes >= 2) {
    return { eligible: true, rule: 'R1', tier: 'confirmed' };
  }

  if (
    evidence.oldest_device_age_hours >= R2_MIN_DEVICE_AGE_HOURS &&
    evidence.best_device_confirmed_uploads >= R2_MIN_CONFIRMED_UPLOADS &&
    evidence.best_device_active_days >= R2_MIN_ACTIVE_DAYS &&
    evidence.best_device_distinct_keys <= 1
  ) {
    return { eligible: true, rule: 'R2', tier: 'confirmed' };
  }

  // Shown on the panel with a 候选 badge so contributors learn why their province is not live.
  return { eligible: false, rule: 'none', tier: 'candidate' };
}

/**
 * Plausibility ceilings for a single node measurement. Values above these cannot come from a
 * real consumer line and are the mechanism by which an unbounded `speed` wins the aggregate
 * ORDER BY, so they are rejected outright rather than clamped — a clamped value would still
 * be stored, still be wrong, and still win.
 */
export const NODE_HARD_LIMITS = {
  /** MB/s. Well above any Chinese consumer line, but finite. */
  maxSpeed: 1000,
  /** ms. Anything slower is not a usable node anyway. */
  maxLatency: 5000
} as const;

/** Softer bounds: plausible-but-suspicious measurements are stored, just not DNS-eligible. */
export const NODE_SOFT_LIMITS = {
  maxSpeed: 200,
  maxLoss: 5,
  /**
   * Cloudflare edge ports. cfst only ever tests these, so anything else means the payload
   * was not produced by the real client.
   */
  allowedPorts: new Set([80, 443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880]),
  /**
   * A node cannot be meaningfully faster to reach than the uploader's own measured RTT to
   * the Cloudflare edge. clientTcpRtt comes from request.cf and cannot be forged.
   */
  minLatencyRatioOfEdgeRtt: 0.3
} as const;

export type NodeVerdict = 'ok' | 'drop' | 'demote';

export interface NodePlausibility {
  verdict: NodeVerdict;
  reason?: string;
}

/**
 * Decides what to do with one measurement. Never throws and never rejects the enclosing
 * request: the deployed OpenWrt client posts with a bare `curl -fsS` (no retry, no timeout),
 * so a 4xx silently discards a legitimate user's whole test run.
 */
export function judgeNode(
  node: { speed: number; latency: number; loss: number; port: number; colo?: string },
  options: { isCloudflareIp: boolean; clientTcpRtt?: number }
): NodePlausibility {
  if (!options.isCloudflareIp) {
    return { verdict: 'drop', reason: 'not_cloudflare_ip' };
  }
  if (node.speed > NODE_HARD_LIMITS.maxSpeed) {
    return { verdict: 'drop', reason: 'speed_implausible' };
  }
  if (node.latency > NODE_HARD_LIMITS.maxLatency) {
    return { verdict: 'drop', reason: 'latency_implausible' };
  }

  if (node.speed <= 0) {
    return { verdict: 'demote', reason: 'speed_not_positive' };
  }
  if (node.latency <= 0) {
    return { verdict: 'demote', reason: 'latency_not_positive' };
  }
  if (node.speed > NODE_SOFT_LIMITS.maxSpeed) {
    return { verdict: 'demote', reason: 'speed_above_expected' };
  }
  if (node.loss > NODE_SOFT_LIMITS.maxLoss) {
    return { verdict: 'demote', reason: 'loss_too_high' };
  }
  if (!NODE_SOFT_LIMITS.allowedPorts.has(node.port)) {
    return { verdict: 'demote', reason: 'unexpected_port' };
  }
  if (!node.colo || !/^[A-Z]{3}$/.test(node.colo.trim().toUpperCase()) || node.colo.trim().toUpperCase() === 'XXX') {
    return { verdict: 'demote', reason: 'colo_unknown' };
  }
  if (
    typeof options.clientTcpRtt === 'number' &&
    options.clientTcpRtt > 0 &&
    node.latency < options.clientTcpRtt * NODE_SOFT_LIMITS.minLatencyRatioOfEdgeRtt
  ) {
    return { verdict: 'demote', reason: 'latency_below_edge_rtt' };
  }

  return { verdict: 'ok' };
}

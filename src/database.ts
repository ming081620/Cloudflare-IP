import { ipPrefix } from './cf-ranges';
import { logEvent } from './observability';
import { judgeKeySupport } from './trust';
import type { Carrier, DirectCheckResult, GeoSource, IpVersion, NodeRecord, PublicAggregate, RegisterResult, ServerGeo, TrustLevel } from './types';
import { carrierLabel } from './utils';

const DEVICE_TOKEN_BYTES = 24;
const AGGREGATE_WINDOW_HOURS = 24;
const IPV6_GEO_CALIBRATION_HOURS = 6;
const RESERVED_NICKNAME = '一万AI分享';
const RESERVED_NICKNAME_DEVICE_IDS = new Set([
  '0bf89a67-9be2-4521-8ebb-d83c0954ed07',
  '6adf90ff-f824-4589-b182-31f15f808100'
]);
const NICKNAME_DENY_PATTERNS = [
  /习近平|毛泽东|邓小平|江泽民|胡锦涛|李强|蔡英文|赖清德|川普|特朗普|拜登/i,
  /共产党|国民党|民进党|台独|港独|藏独|疆独|法轮功|六四|天安门/i,
  /操你|傻逼|煞笔|妈逼|尼玛|去死|垃圾|废物|畜生/i,
  /黄片|色情|约炮|裸聊|嫖|卖淫|援交|强奸|乱伦|自慰|肛交|口交/i,
  /admin|administrator|root|official|system|support|cloudflare|官方|管理员|客服|系统|站长/i
];

interface RegisterInput {
  nickname: string;
  deviceName?: string;
  /** cf-connecting-ip, recorded so abuse response can group by network. */
  clientIp?: string;
}

interface UploadInput {
  deviceId: string;
  nickname: string;
  ipVersion: IpVersion;
  serverGeo: ServerGeo;
  clientRegion?: string;
  clientCarrier?: Carrier;
  directCheck: DirectCheckResult;
  /** serverHardVerdict().ok — derived from request.cf only, never from the payload. */
  sourceTrusted: boolean;
  trustReasons: string[];
  geoSource: GeoSource;
  /** True when the client claimed a province the server had already resolved differently. */
  geoConflict: boolean;
  /** cf-connecting-ip. Distinct from directCheck.egress_ip, which is the client's claim. */
  clientIp?: string;
  clientVersion?: string;
  nodes: NodeRecord[];
}

interface StoredDevice {
  id: string;
  user_id: string;
  token_hash: string;
  nickname: string;
  status: string;
}

interface AggregateRow {
  key: string;
  ip_version: IpVersion;
  province_code: string;
  province_name: string;
  carrier: Carrier;
  hostname: string;
  ip: string;
  port: number;
  record_type: 'A' | 'AAAA';
  speed: number;
  latency: number;
  loss: number;
  colo?: string;
  nickname: string;
  upload_id: string;
  updated_at: string;
}

export interface DnsTarget {
  hostname: string;
  record_type: 'A' | 'AAAA';
}

export async function registerDevice(db: D1Database, input: RegisterInput): Promise<RegisterResult | { error: string; status: number }> {
  const nickname = normalizeNickname(input.nickname);
  if (!nickname) {
    return { error: '昵称不能为空，只能包含中文、英文、数字、下划线和短横线，长度 2-24 个字符', status: 400 };
  }
  if (await isDisallowedNickname(db, nickname)) {
    return { error: '昵称包含不适合公开展示的内容，请更换昵称', status: 400 };
  }

  const existing = await db.prepare('SELECT id, status FROM users WHERE nickname = ?1').bind(nickname).first<{ id: string; status: string }>();
  if (existing?.status !== undefined && existing.status !== 'active') {
    return { error: '该昵称不可用，请更换昵称', status: 403 };
  }
  if (existing && nickname === RESERVED_NICKNAME) {
    return { error: '该测试昵称仅允许已授权设备使用，请更换昵称', status: 409 };
  }
  if (existing) {
    return { error: '昵称已被占用，请更换昵称', status: 409 };
  }

  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const deviceToken = createToken();
  const tokenHash = await sha256(deviceToken);
  const now = new Date().toISOString();

  const clientIp = input.clientIp ?? '';

  await db.batch([
    db.prepare('INSERT INTO users (id, nickname, status, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(userId, nickname, 'active', now, now),
    db
      .prepare(
        `INSERT INTO devices (id, user_id, token_hash, device_name, status, created_at, last_seen_at, created_ip, created_ip_prefix)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(deviceId, userId, tokenHash, input.deviceName ?? '', 'active', now, now, clientIp, ipPrefix(clientIp))
  ]);

  return {
    user_id: userId,
    nickname,
    device_id: deviceId,
    device_token: deviceToken
  };
}

export async function validateDevice(db: D1Database, deviceId: string, deviceToken: string): Promise<StoredDevice | null> {
  const row = await db
    .prepare(
      `SELECT devices.id, devices.user_id, devices.token_hash, devices.status, users.nickname
       FROM devices
       JOIN users ON users.id = devices.user_id
       WHERE devices.id = ?1 AND users.status = 'active' AND devices.status = 'active'`
    )
    .bind(deviceId)
    .first<StoredDevice>();
  if (!row || row.status !== 'active') {
    return null;
  }
  if (row.nickname === RESERVED_NICKNAME && !RESERVED_NICKNAME_DEVICE_IDS.has(row.id)) {
    return null;
  }
  const tokenHash = await sha256(deviceToken);
  return tokenHash === row.token_hash ? row : null;
}

export async function calibrateIpv6Geo(db: D1Database, deviceId: string, serverGeo: ServerGeo): Promise<ServerGeo> {
  if (serverGeo.country !== 'CN' || serverGeo.carrier === 'other') {
    return serverGeo;
  }

  const since = new Date(Date.now() - IPV6_GEO_CALIBRATION_HOURS * 60 * 60 * 1000).toISOString();
  const recentIpv4 = await db
    .prepare(
      `SELECT server_province_code, server_province_name, server_carrier, cf_region, cf_city, cf_asn
       FROM uploads
       WHERE device_id = ?1
         AND ip_version = 'v4'
         AND proxy_suspected = 0
         AND server_province_code != 'unknown'
         AND server_carrier IN ('ct', 'cm', 'cu')
         AND created_at >= ?2
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(deviceId, since)
    .first<{
      server_province_code: string;
      server_province_name: string;
      server_carrier: Carrier;
      cf_region?: string;
      cf_city?: string;
      cf_asn?: number;
    }>();

  if (!recentIpv4) {
    return serverGeo;
  }
  const sameNetwork = recentIpv4.server_carrier === serverGeo.carrier
    || (recentIpv4.cf_asn !== undefined && recentIpv4.cf_asn === serverGeo.asn);
  if (!sameNetwork) {
    return serverGeo;
  }

  return {
    ...serverGeo,
    region: recentIpv4.cf_region || serverGeo.region,
    city: recentIpv4.cf_city || serverGeo.city,
    province_code: recentIpv4.server_province_code,
    province_name: recentIpv4.server_province_name,
    carrier: recentIpv4.server_carrier
  };
}

export async function recordPublicUpload(db: D1Database, input: UploadInput): Promise<string> {
  const uploadId = crypto.randomUUID();
  const now = new Date().toISOString();
  const proxySuspected = input.directCheck.proxy_suspected ? 1 : 0;
  const serverCarrier = input.serverGeo.carrier;
  const serverProvinceCode = input.serverGeo.province_code;
  // sourceTrusted comes from request.cf alone and is ANDed in last, so no request-body field
  // can promote an upload into the set that steers DNS.
  const uploadTrusted =
    input.sourceTrusted && proxySuspected === 0 && serverCarrier !== 'other' && serverProvinceCode !== 'unknown';

  const clientIp = input.clientIp ?? input.serverGeo.ip;
  const trustLevel: TrustLevel = uploadTrusted ? 'confirmed' : 'untrusted';

  const statements = [
    db
      .prepare(
        `INSERT INTO uploads (
          id, device_id, nickname, ip_version, client_ip, cf_country, cf_region, cf_city, cf_asn, cf_as_organization,
          server_province_code, server_province_name, server_carrier, client_region, client_carrier,
          proxy_suspected, route_interface, egress_ip, egress_asn, direct_check_json, created_at,
          cf_client_ip_prefix, cf_colo, cf_client_tcp_rtt, geo_source, geo_conflict, trust_level, trust_reasons, client_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                  ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)`
      )
      .bind(
        uploadId,
        input.deviceId,
        input.nickname,
        input.ipVersion,
        clientIp,
        input.serverGeo.country ?? '',
        input.serverGeo.region ?? '',
        input.serverGeo.city ?? '',
        input.serverGeo.asn ?? null,
        input.serverGeo.asOrganization ?? '',
        serverProvinceCode,
        input.serverGeo.province_name,
        serverCarrier,
        input.clientRegion ?? '',
        input.clientCarrier ?? '',
        proxySuspected,
        input.directCheck.route_interface ?? '',
        input.directCheck.egress_ip ?? '',
        input.directCheck.egress_asn ?? '',
        JSON.stringify(input.directCheck),
        now,
        ipPrefix(clientIp),
        input.serverGeo.colo ?? '',
        input.serverGeo.clientTcpRtt ?? null,
        input.geoSource,
        input.geoConflict ? 1 : 0,
        trustLevel,
        input.trustReasons.join(','),
        input.clientVersion ?? ''
      ),
    db.prepare('UPDATE devices SET last_seen_at = ?1 WHERE id = ?2').bind(now, input.deviceId),
    db.prepare('UPDATE users SET last_seen_at = ?1 WHERE nickname = ?2').bind(now, input.nickname)
  ];

  for (const node of input.nodes) {
    const nodeEligible = node.dns_eligible !== false;
    statements.push(
      db
        .prepare(
          `INSERT INTO node_results (
            id, upload_id, ip, port, carrier, latency, speed, loss, tls, colo, region, source, trusted, created_at,
            cf_range_ok, dns_eligible, demote_reason
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
        )
        .bind(
          crypto.randomUUID(),
          uploadId,
          node.ip,
          node.port,
          node.carrier,
          node.latency,
          node.speed,
          node.loss,
          node.tls ? 1 : 0,
          node.colo ?? '',
          node.region ?? '',
          node.source ?? '',
          // trusted still gates aggregation: it needs BOTH a trustworthy source and a
          // plausible measurement. dns_eligible records only the latter, so the admin view
          // can tell "we distrust your network" apart from "we distrust this reading".
          uploadTrusted && nodeEligible ? 1 : 0,
          now,
          // Every node that survives parsing passed the Cloudflare-range check; the ones that
          // did not were dropped and never reach here.
          1,
          nodeEligible ? 1 : 0,
          node.demote_reason ?? ''
        )
    );
  }

  await db.batch(statements);
  return uploadId;
}

/** ASN → carrier, loaded once per isolate. The table changes about never. */
let carrierAsnCache: Map<number, Carrier> | undefined;

export async function loadCarrierAsns(db: D1Database): Promise<Map<number, Carrier>> {
  if (carrierAsnCache) {
    return carrierAsnCache;
  }
  const rows = await db.prepare('SELECT asn, carrier FROM carrier_asns').all<{ asn: number; carrier: Carrier }>();
  carrierAsnCache = new Map((rows.results ?? []).map((row) => [row.asn, row.carrier]));
  return carrierAsnCache;
}

export interface DeviceStanding {
  age_hours: number;
  confirmed_uploads: number;
}

export async function loadDeviceStanding(db: D1Database, deviceId: string): Promise<DeviceStanding> {
  const row = await db
    .prepare(
      `SELECT
         devices.created_at,
         (SELECT COUNT(*) FROM uploads WHERE uploads.device_id = devices.id AND uploads.trust_level = 'confirmed') AS confirmed_uploads
       FROM devices WHERE devices.id = ?1`
    )
    .bind(deviceId)
    .first<{ created_at: string; confirmed_uploads: number }>();

  if (!row) {
    return { age_hours: 0, confirmed_uploads: 0 };
  }
  return {
    age_hours: Math.max(0, (Date.now() - Date.parse(row.created_at)) / 3600000),
    confirmed_uploads: row.confirmed_uploads ?? 0
  };
}

export async function loadDevicePin(db: D1Database, deviceId: string): Promise<{ province_code: string; carrier: Carrier } | undefined> {
  const row = await db
    .prepare('SELECT province_code, carrier FROM device_pins WHERE device_id = ?1')
    .bind(deviceId)
    .first<{ province_code: string; carrier: Carrier }>();
  return row ?? undefined;
}

/**
 * Server-observed geo history for a device. Only reads rows whose province came from the edge
 * or an admin pin — reading client-attributed rows would let one poisoned upload calibrate
 * every later one.
 */
export async function loadDeviceHistoryGeo(db: D1Database, deviceId: string, sinceHours: number) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT server_province_code AS province_code, server_province_name AS province_name,
              server_carrier AS carrier, cf_asn, geo_source
       FROM uploads
       WHERE device_id = ?1
         AND created_at >= ?2
         AND geo_source IN ('cf', 'pin', 'attested')
         AND server_province_code != 'unknown'
         AND server_carrier IN ('ct', 'cm', 'cu')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(deviceId, since)
    .first<{ province_code: string; province_name: string; carrier: Carrier; cf_asn?: number; geo_source: GeoSource }>();
}

export async function countRecentDevicesForPrefix(db: D1Database, prefix: string, windowHours: number): Promise<number> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM devices WHERE created_ip_prefix = ?1 AND created_at >= ?2')
    .bind(prefix, since)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function isPrefixBlocked(db: D1Database, prefix: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM blocked_prefixes WHERE prefix = ?1').bind(prefix).first<{ hit: number }>();
  return Boolean(row);
}

export async function blockPrefix(db: D1Database, prefix: string, reason: string): Promise<void> {
  await db
    .prepare('INSERT INTO blocked_prefixes (prefix, reason, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(prefix) DO UPDATE SET reason = excluded.reason')
    .bind(prefix, reason, new Date().toISOString())
    .run();
}

export async function unblockPrefix(db: D1Database, prefix: string): Promise<void> {
  await db.prepare('DELETE FROM blocked_prefixes WHERE prefix = ?1').bind(prefix).run();
}

export interface TrustReportRow {
  province_code: string;
  carrier: Carrier;
  ip_version: IpVersion;
  uploads: number;
  devices: number;
  prefixes: number;
  confirmed: number;
  untrusted: number;
  conflicts: number;
  geo_from_cf: number;
  geo_from_client: number;
}

/**
 * Answers the question the enforce/shadow decision hinges on: for each (province, carrier,
 * version), how much of the data is server-attributed versus client-attributed, and how many
 * genuinely independent networks stand behind it.
 */
export async function trustReport(db: D1Database, windowHours: number): Promise<TrustReportRow[]> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `SELECT
         server_province_code AS province_code,
         server_carrier AS carrier,
         ip_version,
         COUNT(*) AS uploads,
         COUNT(DISTINCT device_id) AS devices,
         COUNT(DISTINCT NULLIF(cf_client_ip_prefix, '')) AS prefixes,
         SUM(CASE WHEN trust_level = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN trust_level = 'untrusted' THEN 1 ELSE 0 END) AS untrusted,
         SUM(geo_conflict) AS conflicts,
         SUM(CASE WHEN geo_source = 'cf' THEN 1 ELSE 0 END) AS geo_from_cf,
         SUM(CASE WHEN geo_source = 'client_narrow' THEN 1 ELSE 0 END) AS geo_from_client
       FROM uploads
       WHERE created_at >= ?1
       GROUP BY server_province_code, server_carrier, ip_version
       ORDER BY uploads DESC`
    )
    .bind(since)
    .all<TrustReportRow>();
  return rows.results ?? [];
}

export async function rebuildAggregates(db: D1Database, rootDomain: string): Promise<PublicAggregate[]> {
  const since = new Date(Date.now() - AGGREGATE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      // The IPv6 province/carrier back-fill that used to live here as a recent_v4 CTE is gone:
      // calibrateIpv6Geo already applies it at write time, with stricter rules (6h window, and
      // it requires country='CN'). Having both meant a row could be stored under one province
      // and aggregated under another.
      `WITH latest_uploads AS (
         SELECT id, nickname, ip_version, server_province_code, server_province_name, server_carrier
         FROM (
           SELECT
             uploads.id,
             uploads.nickname,
             uploads.ip_version,
             uploads.server_province_code,
             uploads.server_province_name,
             uploads.server_carrier,
             ROW_NUMBER() OVER (
               PARTITION BY uploads.device_id, uploads.ip_version
               ORDER BY uploads.created_at DESC, uploads.id DESC
             ) AS recency
           FROM uploads
           JOIN devices ON devices.id = uploads.device_id
           JOIN users ON users.id = devices.user_id
           WHERE uploads.created_at >= ?1
             AND devices.status = 'active'
             AND users.status = 'active'
             AND uploads.proxy_suspected = 0
             AND uploads.server_province_code != 'unknown'
             AND uploads.server_carrier IN ('ct', 'cm', 'cu')
         )
         WHERE recency = 1
       ),
       ranked AS (
         SELECT
           latest_uploads.id AS upload_id,
           latest_uploads.nickname,
           latest_uploads.ip_version,
           latest_uploads.server_province_code,
           latest_uploads.server_province_name,
           latest_uploads.server_carrier,
           node_results.ip,
           node_results.port,
           node_results.speed,
           node_results.latency,
           node_results.loss,
           node_results.colo,
           node_results.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY latest_uploads.server_province_code, latest_uploads.server_carrier, latest_uploads.ip_version
             ORDER BY node_results.speed DESC, node_results.latency ASC, node_results.ip ASC
           ) AS rank
         FROM node_results
         JOIN latest_uploads ON latest_uploads.id = node_results.upload_id
         WHERE node_results.trusted = 1
           AND node_results.created_at >= ?1
           AND TRIM(UPPER(node_results.colo)) NOT IN ('', 'N/A')
       )
       SELECT
         upload_id, nickname, ip_version, server_province_code, server_province_name, server_carrier,
         ip, port, speed, latency, loss, colo, created_at
       FROM ranked
       WHERE rank = 1
       ORDER BY server_province_code ASC, server_carrier ASC, ip_version ASC
       LIMIT 500`
    )
    .bind(since)
    .all<{
      upload_id: string;
      nickname: string;
      ip_version: IpVersion;
      server_province_code: string;
      server_province_name: string;
      server_carrier: Carrier;
      ip: string;
      port: number;
      speed: number;
      latency: number;
      loss: number;
      colo?: string;
      created_at: string;
    }>();

  // The query now returns at most one row per key, so this is a straight projection rather
  // than a dedupe pass.
  const aggregates: PublicAggregate[] = (rows.results ?? []).map((row) => {
    const ipVersion = row.ip_version === 'v6' ? 'v6' : 'v4';
    return {
      key: `${row.server_province_code}:${row.server_carrier}:${ipVersion}`,
      ip_version: ipVersion,
      province_code: row.server_province_code,
      province_name: row.server_province_name,
      carrier: row.server_carrier,
      carrier_label: carrierLabel(row.server_carrier),
      hostname:
        ipVersion === 'v6'
          ? `${row.server_province_code}.${row.server_carrier}.v6.${rootDomain}`
          : `${row.server_province_code}.${row.server_carrier}.${rootDomain}`,
      ip: row.ip,
      port: row.port,
      record_type: ipVersion === 'v6' ? 'AAAA' : 'A',
      speed: row.speed,
      latency: row.latency,
      loss: row.loss,
      colo: row.colo ?? '',
      nickname: row.nickname,
      upload_id: row.upload_id,
      updated_at: row.created_at
    };
  });

  // Corroboration: decide which keys have enough independent backing to steer DNS. Rows that
  // fall short stay in the table and on the panel as candidates, they just do not reach dns.ts.
  const support = await loadKeySupport(db, AGGREGATE_WINDOW_HOURS);
  for (const aggregate of aggregates) {
    const evidence = support.get(aggregate.key);
    const verdict = evidence
      ? judgeKeySupport(evidence)
      : { eligible: false, rule: 'none', tier: 'candidate' as const };
    aggregate.trust_level = verdict.tier;
    aggregate.support_rule = verdict.rule;
    aggregate.support_devices = evidence?.devices ?? 0;
  }

  if (!aggregates.length) {
    // An empty result is a query fault far more often than it is a genuine "no data", and the
    // old unconditional DELETE turned it into an outage: /api/public/latest fell through to an
    // empty table and the DNS reconciler deleted every record. Keep serving what we have.
    logEvent('warn', 'aggregates_empty_skipped', { window_hours: AGGREGATE_WINDOW_HOURS });
    return await readAggregates(db);
  }

  // Generation stamp instead of DELETE-then-insert: the upsert and the prune of last
  // generation's rows go in one batch, which D1 runs as a transaction, so the table is never
  // observed empty. It also avoids a ~190-parameter `key NOT IN (...)` list.
  const builtAt = new Date().toISOString();
  await db.batch([
    ...aggregates.map((item) =>
      db
        .prepare(
          `INSERT INTO aggregates (
              key, ip_version, province_code, province_name, carrier, hostname, ip, port, record_type,
              speed, latency, loss, colo, nickname, upload_id, updated_at, built_at,
              trust_level, support_devices, support_rule
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ON CONFLICT(key) DO UPDATE SET
              ip_version = excluded.ip_version,
              province_code = excluded.province_code,
              province_name = excluded.province_name,
              carrier = excluded.carrier,
              hostname = excluded.hostname,
              ip = excluded.ip,
              port = excluded.port,
              record_type = excluded.record_type,
              speed = excluded.speed,
              latency = excluded.latency,
              loss = excluded.loss,
              colo = excluded.colo,
              nickname = excluded.nickname,
              upload_id = excluded.upload_id,
              updated_at = excluded.updated_at,
              built_at = excluded.built_at,
              trust_level = excluded.trust_level,
              support_devices = excluded.support_devices,
              support_rule = excluded.support_rule`
        )
        .bind(
          item.key,
          item.ip_version,
          item.province_code,
          item.province_name,
          item.carrier,
          item.hostname,
          item.ip,
          item.port,
          item.record_type,
          item.speed,
          item.latency,
          item.loss,
          item.colo ?? '',
          item.nickname,
          item.upload_id,
          item.updated_at,
          builtAt,
          item.trust_level ?? 'candidate',
          item.support_devices ?? 0,
          item.support_rule ?? 'none'
        )
    ),
    db.prepare('DELETE FROM aggregates WHERE built_at != ?1').bind(builtAt)
  ]);

  return aggregates;
}

export interface KeySupport {
  key: string;
  devices: number;
  prefixes: number;
  /** Longest-standing contributor for this key, used by the sole-contributor rule. */
  oldest_device_age_hours: number;
  best_device_confirmed_uploads: number;
  best_device_active_days: number;
  best_device_distinct_keys: number;
  pinned: number;
}

/**
 * Corroboration evidence per (province, carrier, ip_version).
 *
 * Counting devices alone is useless: registration is unauthenticated and free, so device
 * supply is unbounded. Distinct `cf_client_ip_prefix` is the discriminating signal — an
 * attacker on one residential line can mint fifty devices and still has one prefix.
 */
export async function loadKeySupport(db: D1Database, windowHours: number): Promise<Map<string, KeySupport>> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `WITH scoped AS (
         SELECT
           uploads.server_province_code || ':' || uploads.server_carrier || ':' || uploads.ip_version AS key,
           uploads.device_id,
           NULLIF(uploads.cf_client_ip_prefix, '') AS prefix,
           devices.created_at AS device_created_at
         FROM uploads
         JOIN devices ON devices.id = uploads.device_id
         WHERE uploads.created_at >= ?1
           AND uploads.trust_level IN ('confirmed', 'legacy')
           AND uploads.server_province_code != 'unknown'
           AND uploads.server_carrier IN ('ct', 'cm', 'cu')
       ),
       device_stats AS (
         SELECT
           uploads.device_id,
           COUNT(*) AS confirmed_uploads,
           COUNT(DISTINCT substr(uploads.created_at, 1, 10)) AS active_days,
           COUNT(DISTINCT uploads.server_province_code || ':' || uploads.server_carrier) AS distinct_keys
         FROM uploads
         WHERE uploads.trust_level IN ('confirmed', 'legacy')
         GROUP BY uploads.device_id
       )
       SELECT
         scoped.key,
         COUNT(DISTINCT scoped.device_id) AS devices,
         COUNT(DISTINCT scoped.prefix) AS prefixes,
         MAX((julianday('now') - julianday(scoped.device_created_at)) * 24.0) AS oldest_device_age_hours,
         MAX(COALESCE(device_stats.confirmed_uploads, 0)) AS best_device_confirmed_uploads,
         MAX(COALESCE(device_stats.active_days, 0)) AS best_device_active_days,
         MIN(COALESCE(device_stats.distinct_keys, 1)) AS best_device_distinct_keys,
         MAX(CASE WHEN device_pins.device_id IS NOT NULL THEN 1 ELSE 0 END) AS pinned
       FROM scoped
       LEFT JOIN device_stats ON device_stats.device_id = scoped.device_id
       LEFT JOIN device_pins ON device_pins.device_id = scoped.device_id
       GROUP BY scoped.key`
    )
    .bind(since)
    .all<KeySupport>();

  return new Map((rows.results ?? []).map((row) => [row.key, row]));
}

export async function readAggregates(db: D1Database): Promise<PublicAggregate[]> {
  const rows = await db.prepare('SELECT * FROM aggregates ORDER BY province_code ASC, carrier ASC, ip_version ASC').all<AggregateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    carrier_label: carrierLabel(row.carrier)
  }));
}

export async function writePublicCache(kv: KVNamespace, aggregates: PublicAggregate[]): Promise<void> {
  const payload = {
    success: true,
    updated_at: new Date().toISOString(),
    total: aggregates.length,
    aggregates
  };
  await kv.put('public:latest', JSON.stringify(payload));
}

export async function readPublicCache(kv: KVNamespace): Promise<unknown | null> {
  return kv.get('public:latest', 'json');
}

const AGGREGATE_LEASE_KEY = 'aggregate:lease_until';

/**
 * Single-statement compare-and-swap over system_state. Returns true when this caller took the
 * lease, false when another one holds it.
 *
 * Concurrent uploads used to each run a full rebuild plus a write to the single `public:latest`
 * KV key, which Cloudflare throttles to roughly one write per second — inside waitUntil, where
 * the failure is invisible. Losing this race costs at most `cooldownSeconds` of staleness, and
 * the cron is the authoritative writer regardless.
 *
 * ISO-8601 UTC strings sort lexicographically exactly as they sort chronologically, and every
 * timestamp in this codebase comes from toISOString(), so string comparison is safe here.
 */
export async function claimAggregateLease(db: D1Database, cooldownSeconds: number, force = false): Promise<boolean> {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + cooldownSeconds * 1000).toISOString();

  if (force) {
    await writeSystemState(db, AGGREGATE_LEASE_KEY, until);
    return true;
  }

  const row = await db
    .prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE system_state.value <= ?3
       RETURNING value`
    )
    .bind(AGGREGATE_LEASE_KEY, until, now)
    .first<{ value: string }>();

  return Boolean(row);
}

export async function recordDnsUpdate(db: D1Database, hostname: string, recordType: string, ip: string, status: string, response: string): Promise<void> {
  await db
    .prepare('INSERT INTO dns_updates (id, hostname, record_type, ip, status, response_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(crypto.randomUUID(), hostname, recordType, ip, status, response.slice(0, 4000), new Date().toISOString())
    .run();
}

/**
 * True when this exact (hostname, type, ip) was already *attempted* inside the window.
 *
 * Previously this only counted rows with status='success', which meant that once every write
 * started failing the throttle stopped engaging entirely and every hostname was retried on
 * every rebuild — a self-sustaining rate-limit storm. Counting attempts makes the throttle
 * hold precisely when it matters most. A changed IP has a different key and is still written
 * immediately, and a record deleted since the attempt is still rewritten.
 */
export async function recentlyUpdatedDns(db: D1Database, hostname: string, recordType: string, ip: string, minutes: number): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT attempt.id
       FROM dns_updates attempt
       WHERE attempt.hostname = ?1
         AND attempt.record_type = ?2
         AND attempt.ip = ?3
         AND attempt.created_at >= ?4
         AND NOT EXISTS (
           SELECT 1
           FROM dns_updates deleted
           WHERE deleted.hostname = attempt.hostname
             AND deleted.record_type = attempt.record_type
             AND deleted.status = 'delete_success'
             AND deleted.created_at >= attempt.created_at
         )
       LIMIT 1`
    )
    .bind(hostname, recordType, ip, since)
    .first();
  return Boolean(row);
}

export async function listActiveDnsTargets(db: D1Database): Promise<DnsTarget[]> {
  const rows = await db
    .prepare(
      `SELECT latest_success.hostname, latest_success.record_type
       FROM (
         SELECT dns_updates.hostname, dns_updates.record_type, MAX(dns_updates.created_at) AS updated_at
         FROM dns_updates
         WHERE dns_updates.status = 'success'
         GROUP BY dns_updates.hostname, dns_updates.record_type
       ) latest_success
       LEFT JOIN (
         SELECT dns_updates.hostname, dns_updates.record_type, MAX(dns_updates.created_at) AS deleted_at
         FROM dns_updates
         WHERE dns_updates.status = 'delete_success'
         GROUP BY dns_updates.hostname, dns_updates.record_type
       ) latest_delete
         ON latest_delete.hostname = latest_success.hostname
        AND latest_delete.record_type = latest_success.record_type
       WHERE latest_delete.deleted_at IS NULL OR latest_delete.deleted_at < latest_success.updated_at`
    )
    .all<DnsTarget>();
  return rows.results ?? [];
}

/** Coordination row store from migration 0005 — ops state that must survive log sampling. */
export async function readSystemState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM system_state WHERE key = ?1').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function writeSystemState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO system_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function listRecentUploads(db: D1Database, limit: number): Promise<unknown[]> {
  const rows = await db
    .prepare(
      `SELECT
        uploads.id,
        uploads.device_id,
        uploads.nickname,
        uploads.ip_version,
        uploads.client_ip,
        uploads.server_province_code,
        uploads.server_province_name,
        uploads.server_carrier,
        uploads.proxy_suspected,
        uploads.egress_ip,
        uploads.egress_asn,
        uploads.created_at,
        uploads.cf_client_ip_prefix,
        uploads.cf_colo,
        uploads.cf_client_tcp_rtt,
        uploads.geo_source,
        uploads.geo_conflict,
        uploads.trust_level,
        uploads.trust_reasons,
        uploads.client_version,
        devices.status AS device_status,
        users.status AS user_status
       FROM uploads
       JOIN devices ON devices.id = uploads.device_id
       JOIN users ON users.id = devices.user_id
       ORDER BY uploads.created_at DESC
       LIMIT ?1`
    )
    .bind(limit)
    .all();
  return rows.results ?? [];
}

export async function blockDevice(db: D1Database, deviceId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE devices SET status = ?1 WHERE id = ?2').bind('blocked', deviceId),
    db.prepare('INSERT INTO admin_events (id, action, target_type, target_id, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(
      crypto.randomUUID(),
      'block',
      'device',
      deviceId,
      reason,
      now
    )
  ]);
}

export async function blockNickname(db: D1Database, nickname: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE users SET status = ?1 WHERE nickname = ?2').bind('blocked', nickname),
    db.prepare('UPDATE devices SET status = ?1 WHERE user_id IN (SELECT id FROM users WHERE nickname = ?2)').bind('blocked', nickname),
    db.prepare('INSERT INTO admin_events (id, action, target_type, target_id, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(
      crypto.randomUUID(),
      'block',
      'nickname',
      nickname,
      reason,
      now
    )
  ]);
}

export async function listBadWords(db: D1Database): Promise<unknown[]> {
  const rows = await db.prepare('SELECT pattern, reason, created_at FROM bad_words ORDER BY created_at DESC').all();
  return rows.results ?? [];
}

export async function addBadWord(db: D1Database, pattern: string, reason: string): Promise<void> {
  const normalized = pattern.trim();
  await db.batch([
    db.prepare('DELETE FROM bad_words WHERE pattern = ?1').bind(normalized),
    db.prepare('INSERT INTO bad_words (id, pattern, reason, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      crypto.randomUUID(),
      normalized,
      reason,
      new Date().toISOString()
    )
  ]);
}

export async function removeBadWord(db: D1Database, pattern: string): Promise<void> {
  await db.prepare('DELETE FROM bad_words WHERE pattern = ?1').bind(pattern.trim()).run();
}

export function normalizeNickname(value: string): string {
  const nickname = value.trim();
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}$/.test(nickname)) {
    return '';
  }
  return nickname;
}

async function isDisallowedNickname(db: D1Database, nickname: string): Promise<boolean> {
  if (nickname === RESERVED_NICKNAME) {
    return false;
  }
  if (NICKNAME_DENY_PATTERNS.some((pattern) => pattern.test(nickname))) {
    return true;
  }
  const words = await db.prepare('SELECT pattern FROM bad_words').all<{ pattern: string }>();
  return (words.results ?? []).some((row) => row.pattern && nickname.toLowerCase().includes(row.pattern.toLowerCase()));
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createToken(): string {
  const bytes = new Uint8Array(DEVICE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

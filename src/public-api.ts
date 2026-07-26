import { ipPrefix, isCloudflareIp, type ParsedRanges } from './cf-ranges';
import { loadCloudflareRanges, refreshCloudflareRanges } from './cf-ranges-cache';
import {
  calibrateIpv6Geo,
  claimAggregateLease,
  countRecentDevicesForPrefix,
  isPrefixBlocked,
  loadCarrierAsns,
  loadDeviceHistoryGeo,
  loadDevicePin,
  loadDeviceStanding,
  readAggregates,
  readPublicCache,
  rebuildAggregates,
  recordPublicUpload,
  registerDevice,
  validateDevice,
  writePublicCache
} from './database';
import { updateDnsForAggregates } from './dns';
import { detectCarrier, detectProvince, detectServerGeo } from './geo';
import { backgroundTask, logEvent } from './observability';
import { runRetention } from './retention';
import { decideTrust, judgeNode, serverHardVerdict, type TrustOutcome } from './trust';
import type { Carrier, DirectCheckResult, Env, GeoSource, IpVersion, NodeRecord, PublicAggregate, PublicUploadPayload, RateLimiter, ServerGeo, UploadNodeInput } from './types';
import {
  cacheableJsonResponse,
  isIpv4Address,
  isIpv6Address,
  jsonResponse,
  normalizeCarrier,
  normalizeIpVersion,
  PUBLIC_LATEST_CACHE_CONTROL,
  PUBLIC_LATEST_CACHE_TAG,
  rateLimitedResponse,
  sortNodes
} from './utils';
import { purgePublicDataCache } from './worker-cache';
import { booleanOrDefault, isRecord, numberOrDefault, readJson, stringOrUndefined } from './parse';

const MAX_PUBLIC_UPLOAD_NODES = 50;
const DEFAULT_ROOT_DOMAIN = '6610000.xyz';
const DEFAULT_REPO_URL = 'https://github.com/10000ge10000/cf-ip-speed-panel';
const MAX_DEVICES_PER_PREFIX = 5;
const MAX_DEVICES_PER_PREFIX_WINDOW_HOURS = 24;
/**
 * The one knob for upload-driven refresh: 0 rebuilds on every upload, Infinity leaves it to
 * the cron. 60s keeps a new contributor's result visible within a minute while collapsing
 * bursts into a single rebuild.
 */
const AGGREGATE_REFRESH_COOLDOWN_SECONDS = 60;
/** "The same box tested over v4 on the same network recently", not "sometime yesterday". */
const DEVICE_HISTORY_WINDOW_HOURS = 6;

export async function handlePublicApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/public/register') {
    return handleRegister(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/public/upload') {
    return handlePublicUpload(request, env, ctx);
  }
  if (request.method === 'GET' && url.pathname === '/api/public/latest') {
    return handlePublicLatest(env);
  }

  return jsonResponse({ success: false, error: '公开 API 路径不存在' }, 404);
}

/**
 * DNS reconciliation is deliberately opt-in and off the upload path: per-upload DNS work is
 * what blew the account-wide API quota in 2026-07 and wedged DNS sync behind permanent 10429s.
 * Uploads refresh the panel data only; DNS converges from the 30-minute cron, which matches
 * the per-record update throttle anyway. Admin actions opt in for immediate effect.
 */
export async function rebuildPublicData(env: Env, ctx?: ExecutionContext, options?: { syncDns?: boolean }): Promise<PublicAggregate[]> {
  const aggregates = await rebuildAggregates(env.DB, env.DNS_ROOT_DOMAIN ?? DEFAULT_ROOT_DOMAIN);
  await writePublicCache(env.SPEED_TEST_KV, aggregates);
  if (options?.syncDns) {
    await updateDnsForAggregates(env, aggregates);
  }
  await purgePublicDataCache(ctx);
  return aggregates;
}

/**
 * Upload-path entry point. Coalesces bursts behind a short lease so a wave of routers finishing
 * at the same time produces one rebuild rather than one per upload. A skipped refresh is only
 * ever up to AGGREGATE_REFRESH_COOLDOWN_SECONDS of staleness; the cron rebuilds unconditionally.
 */
export async function maybeRefreshAggregates(env: Env, ctx?: ExecutionContext): Promise<void> {
  if (!(await claimAggregateLease(env.DB, AGGREGATE_REFRESH_COOLDOWN_SECONDS))) {
    return;
  }
  await rebuildPublicData(env, ctx);
}

/** Cron-only work. Kept off the request path so uploads never depend on an outbound fetch. */
export async function runScheduledMaintenance(env: Env): Promise<void> {
  await refreshCloudflareRanges(env);
  await runRetention(env);
}

/**
 * Degrades open with a warning when the binding is absent, so `wrangler dev` and the
 * regression runner keep working. The regression suite asserts the bindings exist in
 * wrangler.jsonc, which is what guarantees production has them.
 */
async function withinRateLimit(limiter: RateLimiter | undefined, key: string, name: string): Promise<boolean> {
  if (!limiter) {
    logEvent('warn', 'rate_limiter_unavailable', { limiter: name });
    return true;
  }
  const { success } = await limiter.limit({ key });
  if (!success) {
    logEvent('warn', 'rate_limited', { limiter: name, key });
  }
  return success;
}

/**
 * Registration is the expensive-to-abuse action: it is unauthenticated and writes two rows.
 * The 60s limiter blunts bursts; this daily per-prefix quota is what actually stops sustained
 * device-farming, which a 60-second window cannot.
 */
async function registrationAllowed(env: Env, clientIp: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const prefix = ipPrefix(clientIp);
  if (!prefix) {
    return { ok: true };
  }

  if (await isPrefixBlocked(env.DB, prefix)) {
    logEvent('warn', 'register_blocked_prefix', { prefix });
    return { ok: false, error: '该网络已被限制注册', status: 403 };
  }

  if (!(await withinRateLimit(env.REGISTER_LIMITER, `reg:${prefix}`, 'REGISTER_LIMITER'))) {
    return { ok: false, error: '注册过于频繁，请稍后重试', status: 429 };
  }

  const recent = await countRecentDevicesForPrefix(env.DB, prefix, MAX_DEVICES_PER_PREFIX_WINDOW_HOURS);
  if (recent >= MAX_DEVICES_PER_PREFIX) {
    logEvent('warn', 'register_prefix_quota_exceeded', { prefix, recent });
    return { ok: false, error: '该网络注册设备过多，请稍后重试', status: 429 };
  }

  return { ok: true };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ nickname?: unknown; device_name?: unknown }>(request);
  if (!body.ok) {
    return jsonResponse({ success: false, error: body.error }, 400);
  }

  const clientIp = request.headers.get('cf-connecting-ip') ?? '';
  const allowed = await registrationAllowed(env, clientIp);
  if (!allowed.ok) {
    return allowed.status === 429 ? rateLimitedResponse() : jsonResponse({ success: false, error: allowed.error }, allowed.status);
  }

  const nickname = stringOrUndefined(body.value.nickname);
  const result = await registerDevice(env.DB, {
    nickname: nickname ?? '',
    deviceName: stringOrUndefined(body.value.device_name),
    clientIp
  });
  if ('error' in result) {
    return jsonResponse({ success: false, error: result.error }, result.status);
  }
  return jsonResponse({ success: true, message: '注册成功，请保存 device_token', ...result });
}

async function handlePublicUpload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<PublicUploadPayload>(request);
  if (!body.ok) {
    return jsonResponse({ success: false, error: body.error }, 400);
  }

  const payload = body.value;
  const deviceId = stringOrUndefined(payload.device_id);
  const deviceToken = stringOrUndefined(payload.device_token);
  const nickname = stringOrUndefined(payload.nickname);
  const clientIp = request.headers.get('cf-connecting-ip') ?? '';

  if (clientIp && !(await withinRateLimit(env.UPLOAD_LIMITER, `ip:${clientIp}`, 'UPLOAD_LIMITER'))) {
    return rateLimitedResponse();
  }

  let effectiveDeviceId = deviceId;
  let effectiveNickname = nickname;
  let issuedDeviceToken: string | undefined;

  if (deviceId && deviceToken) {
    if (!(await withinRateLimit(env.UPLOAD_LIMITER, `dev:${deviceId}`, 'UPLOAD_LIMITER'))) {
      return rateLimitedResponse();
    }
    const device = await validateDevice(env.DB, deviceId, deviceToken);
    if (!device) {
      return jsonResponse({ success: false, error: '设备凭据无效' }, 401);
    }
    effectiveNickname = device.nickname;
  } else {
    if (!nickname) {
      return jsonResponse({ success: false, error: '首次公开上传必须提供 nickname' }, 400);
    }
    // The auto-register branch is the same unauthenticated write as /api/public/register,
    // so it must share its quota rather than route around it.
    const allowed = await registrationAllowed(env, clientIp);
    if (!allowed.ok) {
      return allowed.status === 429 ? rateLimitedResponse() : jsonResponse({ success: false, error: allowed.error }, allowed.status);
    }
    const registered = await registerDevice(env.DB, {
      nickname,
      deviceName: stringOrUndefined(payload.device_name),
      clientIp
    });
    if ('error' in registered) {
      return jsonResponse({ success: false, error: registered.error }, registered.status);
    }
    effectiveDeviceId = registered.device_id;
    effectiveNickname = registered.nickname;
    issuedDeviceToken = registered.device_token;
  }

  const ipVersion = normalizeIpVersion(payload.ip_version);

  // The raw Cloudflare view, captured before any client-supplied geo is merged in, so the
  // hard verdict below cannot be influenced by the request body.
  const cfGeo = detectServerGeo(request);
  const hardVerdict = serverHardVerdict(cfGeo);

  const ranges = await loadCloudflareRanges(env);
  const parsed = parsePublicNodes(payload, ipVersion, ranges, cfGeo.clientTcpRtt);
  if (!parsed.ok) {
    return jsonResponse({ success: false, error: parsed.error }, 400);
  }

  const directCheck = parseDirectCheck(payload.direct_check);
  const resolved = applyDirectCheckGeo(cfGeo, directCheck);
  let geoSource = resolved.source;
  let serverGeo = resolved.geo;
  if (ipVersion === 'v6') {
    const calibrated = await calibrateIpv6Geo(env.DB, effectiveDeviceId ?? '', serverGeo);
    if (calibrated.province_code !== serverGeo.province_code || calibrated.carrier !== serverGeo.carrier) {
      geoSource = 'device_history';
    }
    serverGeo = calibrated;
  }

  /*
   * The stricter model runs alongside the current one and its verdict is recorded, but it does
   * not govern anything until TRUST_ENFORCE=enforce. Read
   * `GET /api/admin/trust-report` before flipping: the risk is v6 uploads whose carrier only
   * ever came from the client's egress_org, which would lose attribution.
   */
  const shadow = await evaluateTrust(env, request, cfGeo, directCheck, effectiveDeviceId ?? '');
  const enforcing = (env.TRUST_ENFORCE ?? 'shadow') === 'enforce';
  if (enforcing) {
    serverGeo = shadow.geo;
    geoSource = shadow.geo_source;
  } else if (shadow.tier !== 'confirmed' || shadow.geo_conflict) {
    logEvent('info', 'trust_shadow_divergence', {
      device_id: effectiveDeviceId,
      shadow_tier: shadow.tier,
      shadow_geo_source: shadow.geo_source,
      shadow_reasons: shadow.reasons,
      shadow_province: shadow.geo.province_code,
      current_province: serverGeo.province_code,
      ip_version: ipVersion
    });
  }

  if (!hardVerdict.ok) {
    logEvent('info', 'upload_untrusted_source', {
      device_id: effectiveDeviceId,
      reasons: hardVerdict.reasons,
      cf_country: cfGeo.country,
      cf_asn: cfGeo.asn
    });
  }
  if (resolved.conflict) {
    // The client asserted a different province than the edge observed. Legitimate clients
    // have no reason to do this; it is the shape a forged payload takes.
    logEvent('warn', 'upload_geo_conflict', {
      device_id: effectiveDeviceId,
      cf_province: cfGeo.province_code,
      claimed_province: resolved.geo.province_code,
      cf_region: cfGeo.region,
      claimed_region: directCheck.egress_region
    });
  }
  if (parsed.dropped) {
    logEvent('warn', 'upload_nodes_dropped', {
      device_id: effectiveDeviceId,
      dropped: parsed.dropped,
      kept: parsed.nodes.length,
      reasons: parsed.warnings.slice(0, 5)
    });
  }

  const uploadId = await recordPublicUpload(env.DB, {
    deviceId: effectiveDeviceId ?? '',
    nickname: effectiveNickname ?? '',
    ipVersion,
    serverGeo,
    clientRegion: stringOrUndefined(payload.client_region ?? payload.region),
    clientCarrier: normalizeCarrier(payload.client_carrier ?? payload.carrier),
    directCheck,
    sourceTrusted: hardVerdict.ok,
    trustReasons: hardVerdict.reasons,
    geoSource,
    geoConflict: resolved.conflict,
    clientIp,
    clientVersion: stringOrUndefined(payload.client_version),
    nodes: parsed.nodes
  });

  backgroundTask(ctx, 'refresh_aggregates', () => maybeRefreshAggregates(env, ctx));

  return jsonResponse({
    success: true,
    message: '公开上传成功',
    upload_id: uploadId,
    device_id: effectiveDeviceId,
    ...(issuedDeviceToken ? { device_token: issuedDeviceToken } : {}),
    nickname: effectiveNickname,
    ip_version: ipVersion,
    server_geo: serverGeo,
    direct_check: directCheck,
    total: parsed.nodes.length,
    dropped: parsed.dropped,
    warnings: parsed.warnings
  });
}

/**
 * Deployment identity travels with the payload so the static page can render its own links.
 * The page used to hardcode this project's hostnames and repository, which meant a fork's
 * panel told its users to install the upstream's packages.
 */
function deploymentInfo(env: Env): { root_domain: string; repo_url: string } {
  return {
    root_domain: env.DNS_ROOT_DOMAIN ?? DEFAULT_ROOT_DOMAIN,
    repo_url: env.REPO_URL ?? DEFAULT_REPO_URL
  };
}

async function handlePublicLatest(env: Env): Promise<Response> {
  const deployment = deploymentInfo(env);
  const cached = await readPublicCache(env.SPEED_TEST_KV);
  if (cached) {
    return cacheableJsonResponse(
      { ...(cached as { success: true } & Record<string, unknown>), ...deployment },
      PUBLIC_LATEST_CACHE_CONTROL,
      PUBLIC_LATEST_CACHE_TAG
    );
  }
  const aggregates = await readAggregates(env.DB);
  return cacheableJsonResponse({
    success: true,
    updated_at: new Date().toISOString(),
    total: aggregates.length,
    ...deployment,
    aggregates
  }, PUBLIC_LATEST_CACHE_CONTROL, PUBLIC_LATEST_CACHE_TAG);
}

interface ParsedNodes {
  ok: true;
  nodes: NodeRecord[];
  dropped: number;
  warnings: string[];
}

/**
 * Malformed nodes are dropped individually rather than failing the request. The deployed
 * OpenWrt client uploads with a bare `curl -fsS` — no retry, no timeout — so a 4xx throws
 * away a legitimate user's entire test run. Returning 200 with `dropped` also denies an
 * attacker a validation oracle.
 */
function parsePublicNodes(
  payload: PublicUploadPayload,
  ipVersion: IpVersion,
  ranges: ParsedRanges,
  clientTcpRtt?: number
): ParsedNodes | { ok: false; error: string } {
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    return { ok: false, error: 'nodes 必须是非空数组' };
  }

  const inheritedCarrier = normalizeCarrier(payload.carrier);
  const inheritedRegion = stringOrUndefined(payload.region);
  const inheritedSource = stringOrUndefined(payload.source);
  const now = new Date().toISOString();
  const nodes: NodeRecord[] = [];
  const warnings: string[] = [];
  let dropped = 0;

  // Bound the work before parsing: the cap used to be applied after the whole array was
  // parsed and sorted, so a 200k-element array was fully processed and then discarded.
  const candidates = payload.nodes.slice(0, MAX_PUBLIC_UPLOAD_NODES * 4);
  if (payload.nodes.length > candidates.length) {
    dropped += payload.nodes.length - candidates.length;
    warnings.push(`nodes 超过上限，仅处理前 ${candidates.length} 条`);
  }

  for (const [index, item] of candidates.entries()) {
    const parsed = parsePublicNode(item as UploadNodeInput, ipVersion, inheritedCarrier, inheritedRegion, inheritedSource, now, index);
    if (!parsed.ok) {
      dropped += 1;
      warnings.push(parsed.error);
      continue;
    }

    const verdict = judgeNode(parsed.node, {
      isCloudflareIp: isCloudflareIp(parsed.node.ip, ranges),
      clientTcpRtt
    });
    if (verdict.verdict === 'drop') {
      dropped += 1;
      warnings.push(`nodes[${index}] 已丢弃：${verdict.reason}`);
      continue;
    }

    nodes.push({
      ...parsed.node,
      dns_eligible: verdict.verdict === 'ok',
      demote_reason: verdict.reason
    });
  }

  return {
    ok: true,
    nodes: sortNodes(nodes, 'speed').slice(0, MAX_PUBLIC_UPLOAD_NODES),
    dropped,
    warnings: warnings.slice(0, 20)
  };
}

function parsePublicNode(
  item: UploadNodeInput,
  ipVersion: IpVersion,
  inheritedCarrier: Carrier,
  inheritedRegion: string | undefined,
  inheritedSource: string | undefined,
  updatedAt: string,
  index: number
): { ok: true; node: NodeRecord } | { ok: false; error: string } {
  const ip = stringOrUndefined(item.ip);
  if (!ip || (ipVersion === 'v6' ? !isIpv6Address(ip) : !isIpv4Address(ip))) {
    return { ok: false, error: `nodes[${index}].ip 必须是合法 ${ipVersion === 'v6' ? 'IPv6' : 'IPv4'} 地址` };
  }

  const port = numberOrDefault(item.port, 443);
  const latency = numberOrDefault(item.latency, Number.NaN);
  const speed = numberOrDefault(item.speed, Number.NaN);
  const loss = numberOrDefault(item.loss, 0);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `nodes[${index}].port 必须是 1-65535 的整数` };
  }
  if (!Number.isFinite(latency) || latency < 0) {
    return { ok: false, error: `nodes[${index}].latency 必须是非负数字` };
  }
  if (!Number.isFinite(speed) || speed < 0) {
    return { ok: false, error: `nodes[${index}].speed 必须是非负数字` };
  }
  if (!Number.isFinite(loss) || loss < 0 || loss > 100) {
    return { ok: false, error: `nodes[${index}].loss 必须是 0-100 的数字` };
  }

  return {
    ok: true,
    node: {
      ip,
      port,
      carrier: item.carrier ? normalizeCarrier(item.carrier) : inheritedCarrier,
      latency,
      speed,
      loss,
      tls: booleanOrDefault(item.tls, true),
      colo: stringOrUndefined(item.colo),
      region: stringOrUndefined(item.region) ?? inheritedRegion,
      source: stringOrUndefined(item.source) ?? inheritedSource,
      updated_at: updatedAt
    }
  };
}

function parseDirectCheck(value: unknown): DirectCheckResult {
  const source = isRecord(value) ? value : {};
  const routeInterface = stringOrUndefined(source.route_interface);
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((item): item is string => typeof item === 'string') : [];
  const suspiciousInterface = routeInterface ? /^(tun|utun|clash|mihomo|sing-box|wg|tailscale|zerotier)/i.test(routeInterface) : false;
  const proxySuspected = booleanOrDefault(source.proxy_suspected, false) || suspiciousInterface;

  if (suspiciousInterface && !warnings.includes('路由出口疑似代理接口')) {
    warnings.push('路由出口疑似代理接口');
  }

  return {
    proxy_suspected: proxySuspected,
    route_interface: routeInterface,
    egress_ip: stringOrUndefined(source.egress_ip),
    egress_asn: stringOrUndefined(source.egress_asn),
    egress_country: stringOrUndefined(source.egress_country),
    egress_org: stringOrUndefined(source.egress_org),
    egress_region: stringOrUndefined(source.egress_region),
    egress_city: stringOrUndefined(source.egress_city),
    wan_interface: stringOrUndefined(source.wan_interface),
    warnings
  };
}

/** Gathers the D1-backed inputs decideTrust needs, keeping decideTrust itself pure. */
async function evaluateTrust(
  env: Env,
  request: Request,
  cfGeo: ServerGeo,
  directCheck: DirectCheckResult,
  deviceId: string
): Promise<TrustOutcome> {
  const [carrierAsns, standing, pin, history] = await Promise.all([
    loadCarrierAsns(env.DB),
    deviceId ? loadDeviceStanding(env.DB, deviceId) : Promise.resolve({ age_hours: 0, confirmed_uploads: 0 }),
    deviceId ? loadDevicePin(env.DB, deviceId) : Promise.resolve(undefined),
    deviceId ? loadDeviceHistoryGeo(env.DB, deviceId, DEVICE_HISTORY_WINDOW_HOURS) : Promise.resolve(null)
  ]);

  return decideTrust({
    cf: cfGeo,
    directCheck,
    history: history ?? undefined,
    pin,
    carrierByAsn: (asn) => (asn === undefined ? undefined : carrierAsns.get(asn)),
    detectProvince,
    deviceAgeHours: standing.age_hours,
    priorConfirmedUploads: standing.confirmed_uploads
  });
}

interface GeoResolution {
  geo: ServerGeo;
  source: GeoSource;
  /** The client claimed a province the server had already resolved to something else. */
  conflict: boolean;
}

/**
 * Lets the router narrow its own attribution when its WAN egress differs from what the edge
 * sees. It must never overwrite `ip`, `asn` or `asOrganization`: `uploads.client_ip` is the
 * only reliable identifier abuse response has, and the client's claimed egress IP is already
 * preserved separately in `uploads.egress_ip`.
 *
 * The province and carrier overrides that remain here are still client-influenced; they are
 * contained by `serverHardVerdict`, which is ANDed in after this merge. The returned `source`
 * and `conflict` are what the trust report uses to size the eventual switch to server-only
 * attribution.
 */
function applyDirectCheckGeo(serverGeo: ServerGeo, directCheck: DirectCheckResult): GeoResolution {
  const serverResolved = serverGeo.province_code !== 'unknown';

  if (directCheck.proxy_suspected || directCheck.egress_country !== 'CN') {
    return { geo: serverGeo, source: serverResolved ? 'cf' : 'none', conflict: false };
  }

  const province = detectProvince(directCheck.egress_region, directCheck.egress_city);
  if (province.code === 'unknown') {
    return { geo: serverGeo, source: serverResolved ? 'cf' : 'none', conflict: false };
  }

  const conflict = serverResolved && province.code !== serverGeo.province_code;
  const carrier = directCheck.egress_org ? detectCarrier(directCheck.egress_org) : serverGeo.carrier;

  return {
    geo: {
      ...serverGeo,
      region: directCheck.egress_region ?? serverGeo.region,
      city: directCheck.egress_city ?? serverGeo.city,
      province_code: province.code,
      province_name: province.name,
      carrier
    },
    // When the edge already knew the province, the client is not narrowing anything — it is
    // overruling. That is the attack signature, so it is recorded distinctly.
    source: serverResolved ? 'cf' : 'client_narrow',
    conflict
  };
}

import { readHistoryIndex, readLatest, readRawLatest, writeLatest } from './storage';
import { handleAdminApi } from './admin-api';
import { handleHealth } from './health';
import { logEvent } from './observability';
import { handlePublicApi } from './public-api';
import type { Carrier, DomainMapping, Env, HistorySummary, NodeRecord, UploadNodeInput, UploadPayload } from './types';
import {
  buildDataset,
  carrierLabel,
  isBearerAuthorized,
  isCarrier,
  isIpAddress,
  isIpv6Address,
  jsonResponse,
  normalizeCarrier,
  parseLimit,
  sortNodes
} from './utils';
import { booleanOrDefault, numberOrDefault, stringOrUndefined } from './parse';

const MAX_UPLOAD_NODES = 100;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/public/')) {
    return handlePublicApi(request, env, ctx);
  }
  if (url.pathname.startsWith('/api/admin/')) {
    return handleAdminApi(request, env, ctx);
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return handleHealth(env);
  }

  if (LEGACY_PATHS.has(url.pathname)) {
    const legacy = await handleLegacy(request, env, url);
    if (legacy) {
      return legacy;
    }
  }
  return jsonResponse({ success: false, error: 'API 路径不存在' }, 404);
}

/**
 * The KV-backed endpoints that predate the crowdtest path. Nothing in the product uses them:
 * the panel only fetches /api/public/latest and the OpenWrt client only posts to
 * /api/public/{register,upload}. Their only known callers are scripts/upload-{linux.sh,
 * windows.ps1}, which the README never mentions.
 *
 * Instrumented rather than deleted outright so two weeks of logs can show empirically whether
 * anyone else calls them. Set LEGACY_API_ENABLED=0 to switch them off with a config change
 * instead of a deploy.
 */
const LEGACY_PATHS = new Set(['/api/nodes', '/api/raw', '/api/history', '/api/mappings', '/api/upload']);
const LEGACY_SUNSET = 'Wed, 12 Aug 2026 00:00:00 GMT';

function deprecate(response: Response, path: string): Response {
  const headers = new Headers(response.headers);
  headers.set('deprecation', 'true');
  headers.set('sunset', LEGACY_SUNSET);
  headers.set('link', '</api/public/latest>; rel="successor-version"');
  logEvent('warn', 'legacy_endpoint_used', { path });
  return new Response(response.body, { status: response.status, headers });
}

async function handleLegacy(request: Request, env: Env, url: URL): Promise<Response | null> {
  if ((env.LEGACY_API_ENABLED ?? '1') !== '1') {
    logEvent('warn', 'legacy_endpoint_disabled', { path: url.pathname });
    return jsonResponse({ success: false, error: '该接口已下线，请改用 /api/public/latest' }, 410);
  }

  const path = url.pathname;
  if (request.method === 'GET' && path === '/api/nodes') {
    return deprecate(await handleNodes(url, env), path);
  }
  if (request.method === 'GET' && path === '/api/raw') {
    return deprecate(await handleRaw(env), path);
  }
  if (request.method === 'GET' && path === '/api/history') {
    return deprecate(await handleHistory(url, env), path);
  }
  if (request.method === 'GET' && path === '/api/mappings') {
    return deprecate(await handleMappings(env), path);
  }
  if (request.method === 'POST' && path === '/api/upload') {
    return deprecate(await handleUpload(request, env), path);
  }
  return null;
}

async function handleNodes(url: URL, env: Env): Promise<Response> {
  const latest = await readLatest(env.SPEED_TEST_KV);
  if (!latest) {
    return jsonResponse({
      success: true,
      updated_at: null,
      total: 0,
      stats: { ct: 0, cm: 0, cu: 0, other: 0, best_speed: 0, best_latency: 0 },
      nodes: []
    });
  }

  const carrier = url.searchParams.get('carrier');
  const limit = parseLimit(url.searchParams.get('limit'), latest.nodes.length, MAX_UPLOAD_NODES);
  const filtered = carrier && isCarrier(carrier) ? latest.nodes.filter((node) => node.carrier === carrier) : latest.nodes;
  const nodes = sortNodes(filtered, url.searchParams.get('sort')).slice(0, limit);
  const dataset = buildDataset(nodes, latest.updated_at);
  return jsonResponse({ success: true, ...dataset });
}

async function handleRaw(env: Env): Promise<Response> {
  const raw = await readRawLatest(env.SPEED_TEST_KV);
  if (!raw) {
    return jsonResponse({ success: true, data: null, message: 'KV 中暂无 nodes:latest 数据' });
  }
  return new Response(raw, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function handleHistory(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url.searchParams.get('limit'), 20, 20);
  const history = await readHistoryIndex(env.SPEED_TEST_KV);
  return jsonResponse({ success: true, total: history.length, history: history.slice(0, limit) });
}

async function handleMappings(env: Env): Promise<Response> {
  const latest = await readLatest(env.SPEED_TEST_KV);
  if (!latest) {
    return jsonResponse({ success: true, updated_at: null, mappings: [], hosts: '' });
  }

  const domains: Record<Carrier, string | undefined> = {
    ct: env.DOMAIN_CT,
    cm: env.DOMAIN_CM,
    cu: env.DOMAIN_CU,
    other: undefined
  };
  const carriers: Carrier[] = ['ct', 'cm', 'cu'];
  const mappings: DomainMapping[] = [];

  for (const carrier of carriers) {
    const domain = domains[carrier];
    if (!domain) {
      continue;
    }
    const best = sortNodes(latest.nodes.filter((node) => node.carrier === carrier), 'speed')[0];
    if (!best) {
      continue;
    }
    mappings.push({
      carrier,
      carrier_label: carrierLabel(carrier),
      domain,
      ip: best.ip,
      port: best.port,
      record_type: isIpv6Address(best.ip) ? 'AAAA' : 'A',
      speed: best.speed,
      latency: best.latency,
      source: best.source,
      region: best.region,
      updated_at: best.updated_at
    });
  }

  const hosts = mappings.map((item) => `${item.ip} ${item.domain}`).join('\n');
  return jsonResponse({ success: true, updated_at: latest.updated_at, mappings, hosts });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const authorized = await isBearerAuthorized(request, env.UPLOAD_TOKEN);
  if (!authorized) {
    return jsonResponse({ success: false, error: '未授权：请使用 Authorization: Bearer <UPLOAD_TOKEN>' }, 401);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return jsonResponse({ success: false, error: '仅支持 application/json 上传' }, 415);
  }

  let payload: UploadPayload;
  try {
    payload = (await request.json()) as UploadPayload;
  } catch {
    return jsonResponse({ success: false, error: 'JSON 格式无效' }, 400);
  }

  const parsed = parseUploadPayload(payload);
  if (!parsed.ok) {
    return jsonResponse({ success: false, error: parsed.error }, 400);
  }

  const updatedAt = new Date().toISOString();
  const nodes = parsed.nodes
    .map((node) => ({ ...node, updated_at: updatedAt }))
    .sort((left, right) => right.speed - left.speed || left.latency - right.latency)
    .slice(0, MAX_UPLOAD_NODES);
  const dataset = buildDataset(nodes, updatedAt);
  const summary: HistorySummary = {
    key: `nodes:history:${updatedAt}`,
    uploaded_at: updatedAt,
    source: stringOrUndefined(payload.source),
    region: stringOrUndefined(payload.region),
    carrier: normalizeCarrier(payload.carrier),
    total: nodes.length,
    best_speed: dataset.stats.best_speed,
    best_latency: dataset.stats.best_latency
  };

  await writeLatest(env.SPEED_TEST_KV, dataset, summary);
  return jsonResponse({ success: true, message: '上传成功', ...dataset });
}

function parseUploadPayload(payload: UploadPayload): { ok: true; nodes: NodeRecord[] } | { ok: false; error: string } {
  if (!payload || !Array.isArray(payload.nodes)) {
    return { ok: false, error: 'nodes 必须是数组' };
  }
  if (payload.nodes.length === 0) {
    return { ok: false, error: 'nodes 不能为空' };
  }

  const inheritedCarrier = normalizeCarrier(payload.carrier);
  const inheritedSource = stringOrUndefined(payload.source);
  const inheritedRegion = stringOrUndefined(payload.region);
  const nodes: NodeRecord[] = [];

  for (const [index, item] of payload.nodes.entries()) {
    const result = parseUploadNode(item as UploadNodeInput, inheritedCarrier, inheritedSource, inheritedRegion, index);
    if (!result.ok) {
      return result;
    }
    nodes.push(result.node);
  }

  return { ok: true, nodes };
}

function parseUploadNode(
  node: UploadNodeInput,
  inheritedCarrier: Carrier,
  inheritedSource: string | undefined,
  inheritedRegion: string | undefined,
  index: number
): { ok: true; node: NodeRecord } | { ok: false; error: string } {
  const ip = stringOrUndefined(node.ip);
  if (!ip || !isIpAddress(ip)) {
    return { ok: false, error: `nodes[${index}].ip 必须是合法 IPv4 或 IPv6 地址` };
  }

  const port = numberOrDefault(node.port, 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `nodes[${index}].port 必须是 1-65535 的整数` };
  }

  const latency = numberOrDefault(node.latency, Number.NaN);
  if (!Number.isFinite(latency) || latency < 0) {
    return { ok: false, error: `nodes[${index}].latency 必须是非负数字` };
  }

  const speed = numberOrDefault(node.speed, Number.NaN);
  if (!Number.isFinite(speed) || speed < 0) {
    return { ok: false, error: `nodes[${index}].speed 必须是非负数字` };
  }

  const loss = numberOrDefault(node.loss, 0);
  if (!Number.isFinite(loss) || loss < 0 || loss > 100) {
    return { ok: false, error: `nodes[${index}].loss 必须是 0-100 的数字` };
  }

  return {
    ok: true,
    node: {
      ip,
      port,
      carrier: node.carrier ? normalizeCarrier(node.carrier) : inheritedCarrier,
      latency,
      speed,
      loss,
      tls: booleanOrDefault(node.tls, true),
      colo: stringOrUndefined(node.colo),
      region: stringOrUndefined(node.region) ?? inheritedRegion,
      source: stringOrUndefined(node.source) ?? inheritedSource,
      updated_at: ''
    }
  };
}

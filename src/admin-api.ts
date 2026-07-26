import { isCloudflareIp } from './cf-ranges';
import { loadCloudflareRanges } from './cf-ranges-cache';
import {
  addBadWord,
  blockDevice,
  blockNickname,
  blockPrefix,
  listBadWords,
  listRecentUploads,
  readAggregates,
  removeBadWord,
  trustReport,
  unblockPrefix
} from './database';
import { rebuildPublicData } from './public-api';
import type { Env } from './types';
import { isBearerAuthorized, jsonResponse, parseLimit } from './utils';
import { purgeAllPublicCache } from './worker-cache';
import { stringOrUndefined } from './parse';

export async function handleAdminApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await isBearerAuthorized(request, env.ADMIN_TOKEN))) {
    return jsonResponse({ success: false, error: '未授权' }, 401);
  }

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/admin/uploads') {
    const limit = parseLimit(url.searchParams.get('limit'), 30, 100);
    return jsonResponse({ success: true, uploads: await listRecentUploads(env.DB, limit) });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/block-device') {
    const body = await readBody(request);
    const deviceId = stringOrUndefined(body.device_id);
    if (!deviceId) {
      return jsonResponse({ success: false, error: 'device_id 必填' }, 400);
    }
    await blockDevice(env.DB, deviceId, stringOrUndefined(body.reason) ?? '');
    await rebuildPublicCacheAndDns(env, ctx);
    return jsonResponse({ success: true, message: '设备已封禁' });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/block-nickname') {
    const body = await readBody(request);
    const nickname = stringOrUndefined(body.nickname);
    if (!nickname) {
      return jsonResponse({ success: false, error: 'nickname 必填' }, 400);
    }
    await blockNickname(env.DB, nickname, stringOrUndefined(body.reason) ?? '');
    await rebuildPublicCacheAndDns(env, ctx);
    return jsonResponse({ success: true, message: '昵称已封禁' });
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/bad-words') {
    return jsonResponse({ success: true, bad_words: await listBadWords(env.DB) });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/bad-words') {
    const body = await readBody(request);
    const pattern = stringOrUndefined(body.pattern);
    if (!pattern) {
      return jsonResponse({ success: false, error: 'pattern 必填' }, 400);
    }
    await addBadWord(env.DB, pattern, stringOrUndefined(body.reason) ?? '');
    return jsonResponse({ success: true, message: '词条已添加' });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/admin/bad-words') {
    const pattern = stringOrUndefined(url.searchParams.get('pattern'));
    if (!pattern) {
      return jsonResponse({ success: false, error: 'pattern 必填' }, 400);
    }
    await removeBadWord(env.DB, pattern);
    return jsonResponse({ success: true, message: '词条已删除' });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/rebuild') {
    const aggregates = await rebuildPublicCacheAndDns(env, ctx);
    return jsonResponse({ success: true, total: aggregates.length, aggregates });
  }

  /**
   * Sizes the eventual switch to server-only geo attribution: shows, per province/carrier,
   * how much data is client-attributed and how many independent networks stand behind it.
   */
  if (request.method === 'GET' && url.pathname === '/api/admin/trust-report') {
    const hours = parseLimit(url.searchParams.get('hours'), 168, 720);
    const rows = await trustReport(env.DB, hours);
    return jsonResponse({
      success: true,
      window_hours: hours,
      totals: {
        uploads: rows.reduce((sum, row) => sum + row.uploads, 0),
        confirmed: rows.reduce((sum, row) => sum + row.confirmed, 0),
        untrusted: rows.reduce((sum, row) => sum + row.untrusted, 0),
        conflicts: rows.reduce((sum, row) => sum + row.conflicts, 0),
        client_attributed: rows.reduce((sum, row) => sum + row.geo_from_client, 0)
      },
      rows
    });
  }

  /**
   * Confirms no live DNS record points outside Cloudflare's space. Run this right after
   * deploying the ingest-side range check — the aggregate window is 24h, so rows written
   * before it shipped can still be live.
   */
  if (request.method === 'GET' && url.pathname === '/api/admin/dns-audit') {
    const ranges = await loadCloudflareRanges(env);
    const aggregates = await readAggregates(env.DB);
    const audited = aggregates.map((aggregate) => ({
      hostname: aggregate.hostname,
      record_type: aggregate.record_type,
      ip: aggregate.ip,
      nickname: aggregate.nickname,
      speed: aggregate.speed,
      updated_at: aggregate.updated_at,
      cloudflare_ip: isCloudflareIp(aggregate.ip, ranges)
    }));
    const offenders = audited.filter((row) => !row.cloudflare_ip);
    return jsonResponse({
      success: true,
      total: audited.length,
      non_cloudflare: offenders.length,
      offenders,
      aggregates: audited
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/block-prefix') {
    const body = await readBody(request);
    const prefix = stringOrUndefined(body.prefix);
    if (!prefix) {
      return jsonResponse({ success: false, error: 'prefix 必填' }, 400);
    }
    await blockPrefix(env.DB, prefix, stringOrUndefined(body.reason) ?? '');
    return jsonResponse({ success: true, message: '网段已封禁' });
  }

  // The data cache is purged automatically on every rebuild; the HTML tag only needs clearing
  // after a deploy, which is why it is a manual action rather than part of the rebuild.
  if (request.method === 'POST' && url.pathname === '/api/admin/purge-cache') {
    await purgeAllPublicCache(ctx);
    return jsonResponse({ success: true, message: '缓存已清除' });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/admin/block-prefix') {
    const prefix = stringOrUndefined(url.searchParams.get('prefix'));
    if (!prefix) {
      return jsonResponse({ success: false, error: 'prefix 必填' }, 400);
    }
    await unblockPrefix(env.DB, prefix);
    return jsonResponse({ success: true, message: '网段已解封' });
  }

  return jsonResponse({ success: false, error: '管理 API 路径不存在' }, 404);
}

/**
 * Admin actions are explicit and low-frequency, so they opt in to immediate DNS sync. This
 * used to be a byte-for-byte copy of rebuildPublicData; the copy silently missed the syncDns
 * split when DNS work moved off the upload path.
 */
function rebuildPublicCacheAndDns(env: Env, ctx?: ExecutionContext) {
  return rebuildPublicData(env, ctx, { syncDns: true });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

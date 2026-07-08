import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBearerAuthorized, isIpv6Address } from '../src/utils.ts';

const badBearer = new Request('https://example.test/api/admin/uploads', {
  headers: { authorization: 'Bearer wrong-token' }
});
assert.equal(await isBearerAuthorized(badBearer, 'right-token'), false);

const goodBearer = new Request('https://example.test/api/admin/uploads', {
  headers: { authorization: 'Bearer right-token' }
});
assert.equal(await isBearerAuthorized(goodBearer, 'right-token'), true);

const adminApiSource = readFileSync(new URL('../src/admin-api.ts', import.meta.url), 'utf8');
assert.match(adminApiSource, /await isBearerAuthorized\(request, env\.ADMIN_TOKEN\)/);
assert.doesNotMatch(adminApiSource, /timingSafeEqual/);
assert.match(adminApiSource, /handleAdminApi\(request: Request, env: Env, ctx: ExecutionContext\)/);
assert.match(adminApiSource, /rebuildPublicCacheAndDns\(env, ctx\)/);

const databaseSource = readFileSync(new URL('../src/database.ts', import.meta.url), 'utf8');
assert.match(databaseSource, /TRIM\(UPPER\(node_results\.colo\)\) NOT IN \('', 'N\/A'\)/);

const openwrtClientSource = readFileSync(new URL('../openwrt-packages/cf-ip-speed-client/files/usr/bin/cf-ip-speed-client', import.meta.url), 'utf8');
assert.match(openwrtClientSource, /has_missing_colo\(\)/);
assert.match(openwrtClientSource, /不会参与公开 DNS 优选/);

const wranglerSource = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
assert.match(wranglerSource, /"cache"\s*:\s*\{\s*"enabled"\s*:\s*true\s*\}/s);

const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8');
assert.match(utilsSource, /PUBLIC_HTML_CACHE_CONTROL = 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600'/);
assert.match(utilsSource, /PUBLIC_LATEST_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60'/);
assert.match(utilsSource, /'cache-tag': PUBLIC_HTML_CACHE_TAG/);

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert.match(indexSource, /cacheableHtmlResponse\(renderHtml\(\)\)/);
assert.match(indexSource, /publicHtmlHeaders\(\)/);
assert.match(indexSource, /rebuildPublicData\(env, ctx\)/);

const publicApiSource = readFileSync(new URL('../src/public-api.ts', import.meta.url), 'utf8');
assert.match(publicApiSource, /cacheableJsonResponse\(/);
assert.match(publicApiSource, /PUBLIC_LATEST_CACHE_TAG/);
assert.match(publicApiSource, /ctx\.waitUntil\(rebuildPublicData\(env, ctx\)\)/);

const workerCacheSource = readFileSync(new URL('../src/worker-cache.ts', import.meta.url), 'utf8');
assert.match(workerCacheSource, /ctx\.cache\.purge\(\{ tags: \[\.\.\.PUBLIC_WORKER_CACHE_TAGS\] \}\)/);
assert.match(workerCacheSource, /worker_cache_purge_failed/);
assert.match(workerCacheSource, /worker_cache_purge_error/);

const speedTestSource = readFileSync(new URL('../src/speedtest.ts', import.meta.url), 'utf8');
assert.match(speedTestSource, /'cache-control': 'no-store'/);

const validIpv6 = [
  '2606:4700:3119::ac40:99e5',
  '::1',
  '2001:db8::1'
];
const invalidIpv6 = [
  '::::',
  '1:2:3:4:5:6:7:8:9',
  '12345::',
  '2001:db8::1::2',
  '1.2.3.4:',
  'fe80::1%eth0'
];

for (const ip of validIpv6) {
  assert.equal(isIpv6Address(ip), true, `${ip} should be accepted`);
}

for (const ip of invalidIpv6) {
  assert.equal(isIpv6Address(ip), false, `${ip} should be rejected`);
}

console.log('regression checks passed');

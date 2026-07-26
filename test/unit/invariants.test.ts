import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { bundledRanges, ipPrefix, ipv4ToInt, ipv6ToGroups, isCloudflareIp, parseCidrList, validateFetchedRanges } from '../../src/cf-ranges';
import { detectCarrier, detectProvince } from '../../src/geo';
import { decideTrust, judgeKeySupport, judgeNode, serverHardVerdict } from '../../src/trust';
import { isBearerAuthorized, isIpv6Address, parseLimit } from '../../src/utils';

const repoFile = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8');

/*
 * Ported from scripts/regression.ts. Kept as one test so the assertions stay in the order they
 * were written and read top to bottom as a narrative of what the trust model guarantees.
 */
it('worker invariants', async () => {
  // ---------------------------------------------------------------------------
  // Bearer auth
  // ---------------------------------------------------------------------------
  const bearer = (token: string) =>
    new Request('https://example.test/api/admin/uploads', { headers: { authorization: token } });

  assert.equal(await isBearerAuthorized(bearer('Bearer wrong-token'), 'right-token'), false);
  assert.equal(await isBearerAuthorized(bearer('Bearer right-token'), 'right-token'), true);
  assert.equal(await isBearerAuthorized(bearer('Bearer right-token'), undefined), false, 'missing secret must fail closed');
  assert.equal(await isBearerAuthorized(bearer('right-token'), 'right-token'), false, 'prefix is required');

  // ---------------------------------------------------------------------------
  // Cloudflare address allowlist
  // ---------------------------------------------------------------------------
  const ranges = bundledRanges();

  /**
   * No-false-reject proof. Every address range the deployed fleet is told to scan must be
   * accepted, or a legitimate router's best node is silently discarded. This is why the
   * allowlist unions Cloudflare's published list with the shipped ip.txt: the shipped list is
   * wider at 104.16.0.0/12.
   */
  function boundsOfV4Cidr(cidr: string): [string, string] {
    const [address, prefixText] = cidr.split('/');
    const base = ipv4ToInt(address);
    assert.notEqual(base, null, `${cidr} must parse`);
    const size = 2 ** (32 - Number(prefixText));
    const format = (value: number) =>
      [value / 16777216, (value / 65536) % 256, (value / 256) % 256, value % 256].map((part) => Math.floor(part)).join('.');
    return [format(base!), format(base! + size - 1)];
  }

  const shippedV4 = repoFile('openwrt-packages/cf-ip-speed-client/files/etc/cf-ip-speed-client/ip.txt')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(shippedV4.length >= 20, 'shipped ip.txt should still list the Cloudflare ranges');

  for (const cidr of shippedV4) {
    for (const probe of boundsOfV4Cidr(cidr.trim())) {
      assert.equal(isCloudflareIp(probe, ranges), true, `${probe} (from ${cidr}) must be accepted`);
    }
  }

  const shippedV6 = repoFile('openwrt-packages/cf-ip-speed-client/files/etc/cf-ip-speed-client/ip-v6.txt')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (const cidr of shippedV6) {
    assert.equal(isCloudflareIp(cidr.trim().split('/')[0], ranges), true, `${cidr} base must be accepted`);
  }

  // Ranges the published list no longer covers but the fleet still scans.
  for (const ip of ['104.28.1.1', '104.30.1.1']) {
    assert.equal(isCloudflareIp(ip, ranges), true, `${ip} is scanned by deployed clients and must be accepted`);
  }
  for (const ip of ['104.16.132.229', '172.67.1.1', '162.159.1.1', '2606:4700:3119::ac40:99e5', '2400:cb00::1']) {
    assert.equal(isCloudflareIp(ip, ranges), true, `${ip} must be accepted`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '127.0.0.1', '10.0.0.1', '192.168.1.1', '203.0.113.9', '2001:db8::1', '::1', 'not-an-ip', '']) {
    assert.equal(isCloudflareIp(ip, ranges), false, `${ip} must be rejected`);
  }

  // Prefix comparison must not go through int32 coercion.
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(isCloudflareIp('198.41.255.255', ranges), true);
  assert.equal(isCloudflareIp('198.42.0.0', ranges), false);

  assert.deepEqual(ipv6ToGroups('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6ToGroups('2606:4700::'), [0x2606, 0x4700, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ipv6ToGroups('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  for (const bad of ['::::', '1:2:3:4:5:6:7:8:9', '12345::', '2001:db8::1::2', 'fe80::1%eth0', '']) {
    assert.equal(ipv6ToGroups(bad), null, `${bad} must not expand`);
  }

  // A refresh may only ever widen the allowlist inside Cloudflare's own space.
  const publishedV4 = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
  ];
  const publishedV6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
  assert.equal(validateFetchedRanges(publishedV4, publishedV6), undefined, 'the real published lists must validate');
  assert.match(validateFetchedRanges(['0.0.0.0/0', ...publishedV4], publishedV6) ?? '', /implausible_v4_prefix/);
  assert.match(validateFetchedRanges([...publishedV4, '8.8.8.0/24'], publishedV6) ?? '', /forbidden_address_covered/);
  assert.match(validateFetchedRanges(publishedV4.slice(0, 3), publishedV6) ?? '', /unexpected_v4_count/);
  assert.match(validateFetchedRanges(publishedV4.filter((c) => !c.startsWith('104.16')), publishedV6) ?? '', /anchor_missing/);
  assert.equal(isCloudflareIp('8.8.8.8', parseCidrList(['0.0.0.0/0'])), true, 'sanity: /0 covers everything');

  // ---------------------------------------------------------------------------
  // Carrier detection — a substring match here was a trust-gate bypass
  // ---------------------------------------------------------------------------
  for (const org of ['Connectivity Inc', 'Octopus Networks', 'ACTCORP', 'Direct Connect', 'Contact Networks', 'CNCF Foundation', '']) {
    assert.equal(detectCarrier(org), 'other', `"${org}" must not be classified as a Chinese carrier`);
  }
  assert.equal(detectCarrier('CHINANET-BACKBONE'), 'ct');
  assert.equal(detectCarrier('China Telecom Guangdong'), 'ct');
  assert.equal(detectCarrier('China Mobile Communications Group Co., Ltd.'), 'cm');
  assert.equal(detectCarrier('CMCC'), 'cm');
  assert.equal(detectCarrier('CHINA UNICOM China169 Backbone'), 'cu');
  assert.equal(detectCarrier('CNCGROUP Beijing province network'), 'cu');

  assert.equal(detectProvince('Guangdong').code, 'gd');
  assert.equal(detectProvince('Shanghai').code, 'sh');
  assert.equal(detectProvince('Zhejiang', 'Hangzhou').code, 'zj');
  assert.equal(detectProvince('广东省').code, 'gd');

  // A substring match here sent several Hubei/Hunan cities to Shaanxi.
  assert.equal(detectProvince(undefined, 'Xianning').code, 'unknown', 'Xianning must not match the "xian" alias');
  assert.equal(detectProvince(undefined, 'Xiantao').code, 'unknown');
  assert.equal(detectProvince(undefined, "Xi'an").code, 'sx', 'apostrophes stay inside a token');
  assert.equal(detectProvince(undefined, 'Xian').code, 'sx');

  // Shanxi and Shaanxi are one letter apart and must not collide.
  assert.equal(detectProvince('Shanxi').code, 'sn');
  assert.equal(detectProvince('Shaanxi').code, 'sx');

  // The region is more authoritative than the city; joining them let a city alias win.
  assert.equal(detectProvince('Hubei', 'Xianning').code, 'hb');
  assert.equal(detectProvince('Inner Mongolia').code, 'nm', 'multi-word aliases still match');

  // ---------------------------------------------------------------------------
  // Server hard verdict — the one decision a payload cannot influence
  // ---------------------------------------------------------------------------
  const residential = { country: 'CN', asn: 4134, asOrganization: 'CHINANET-BACKBONE' };
  assert.equal(serverHardVerdict(residential).ok, true);

  assert.equal(serverHardVerdict({ ...residential, country: 'US' }).ok, false, 'non-CN source must be untrusted');
  assert.equal(serverHardVerdict({ ...residential, country: undefined }).ok, false, 'unknown country must fail closed');
  assert.equal(serverHardVerdict({ country: 'CN', asn: 14061, asOrganization: 'DigitalOcean, LLC' }).ok, false);
  assert.equal(serverHardVerdict({ country: 'CN', asn: 45102, asOrganization: 'Alibaba US Technology' }).ok, false);
  assert.equal(serverHardVerdict({ country: 'CN', asn: 99999, asOrganization: 'Some IDC Hosting Co' }).ok, false);
  assert.deepEqual(serverHardVerdict({ country: 'US', asn: 14061, asOrganization: 'Amazon' }).reasons.sort(), [
    'cf_asn_is_hosting',
    'cf_country_not_cn',
    'cf_org_is_hosting'
  ]);

  // ---------------------------------------------------------------------------
  // decideTrust — client input may narrow, never overrule
  // ---------------------------------------------------------------------------
  const CT_ASNS = new Map([[4134, 'ct'], [9808, 'cm'], [4837, 'cu']]);

  function trustCase(overrides = {}) {
    const base = {
      cf: {
        ip: '1.2.3.4', country: 'CN', region: 'Guangdong', city: 'Guangzhou',
        asn: 4134, asOrganization: 'CHINANET-BACKBONE',
        province_code: 'gd', province_name: '广东', carrier: 'ct'
      },
      directCheck: { proxy_suspected: false, warnings: [] },
      carrierByAsn: (asn) => CT_ASNS.get(asn),
      detectProvince,
      deviceAgeHours: 200,
      priorConfirmedUploads: 10
    };
    return decideTrust({ ...base, ...overrides, cf: { ...base.cf, ...overrides.cf },
      directCheck: { ...base.directCheck, ...overrides.directCheck } });
  }

  const healthy = trustCase();
  assert.equal(healthy.tier, 'confirmed');
  assert.equal(healthy.geo_source, 'cf');
  assert.equal(healthy.geo.province_code, 'gd');

  // The proof-of-concept payload: forged CN geo from a hosting network.
  const poc = trustCase({
    cf: { country: 'JP', asn: 16509, asOrganization: 'Amazon.com, Inc.', region: 'Tokyo', city: 'Tokyo' },
    directCheck: { egress_country: 'CN', egress_region: 'Guangdong', egress_city: 'Guangzhou', egress_org: 'China Telecom' }
  });
  assert.equal(poc.tier, 'untrusted', 'the PoC source must never be trusted');

  // A client asserting a province the edge already resolved differently is the attack shape.
  const conflicting = trustCase({
    directCheck: { egress_country: 'CN', egress_region: 'Zhejiang', egress_city: 'Hangzhou' }
  });
  assert.equal(conflicting.tier, 'untrusted');
  assert.equal(conflicting.geo_conflict, true);
  assert.ok(conflicting.reasons.includes('geo_conflict_hard'));

  // Agreeing with the edge is not a conflict.
  const agreeing = trustCase({
    directCheck: { egress_country: 'CN', egress_region: 'Guangdong', egress_city: 'Guangzhou' }
  });
  assert.equal(agreeing.tier, 'confirmed');
  assert.equal(agreeing.geo_conflict, false);

  // The client may fill a gap the edge could not, but only as a candidate.
  const narrowed = trustCase({
    cf: { region: undefined, city: undefined, province_code: 'unknown', province_name: '未知' },
    directCheck: { egress_country: 'CN', egress_region: 'Zhejiang', egress_city: 'Hangzhou' }
  });
  assert.equal(narrowed.tier, 'candidate', 'client-supplied province caps at candidate');
  assert.equal(narrowed.geo_source, 'client_narrow');
  assert.equal(narrowed.geo.province_code, 'zj');

  // Device history fills the same gap at full trust, because the server observed it.
  const fromHistory = trustCase({
    cf: { region: undefined, city: undefined, province_code: 'unknown', province_name: '未知' },
    history: { province_code: 'zj', province_name: '浙江', carrier: 'ct', cf_asn: 4134, geo_source: 'cf' }
  });
  assert.equal(fromHistory.tier, 'confirmed');
  assert.equal(fromHistory.geo_source, 'device_history');

  // Client-only downgrades.
  assert.equal(trustCase({ directCheck: { proxy_suspected: true } }).tier, 'untrusted');
  assert.equal(trustCase({ directCheck: { egress_country: 'US' } }).tier, 'untrusted');

  // Falling back to the organization string is a downgrade, not a failure.
  const orgOnly = trustCase({ cf: { asn: 99999 }, carrierByAsn: () => undefined });
  assert.equal(orgOnly.tier, 'candidate');
  assert.ok(orgOnly.reasons.includes('carrier_from_org_string'));

  // A brand-new device has no track record.
  assert.equal(trustCase({ deviceAgeHours: 1 }).tier, 'candidate');
  assert.equal(trustCase({ priorConfirmedUploads: 0 }).tier, 'candidate');

  // An admin pin is instant and authoritative.
  const pinned = trustCase({
    cf: { region: undefined, city: undefined, province_code: 'unknown', province_name: '未知' },
    deviceAgeHours: 1,
    pin: { province_code: 'xz', carrier: 'cm' }
  });
  assert.equal(pinned.geo_source, 'pin');
  assert.equal(pinned.geo.province_code, 'xz');
  assert.equal(pinned.geo.carrier, 'cm');

  // ---------------------------------------------------------------------------
  // Corroboration — device count alone is meaningless, prefixes are the signal
  // ---------------------------------------------------------------------------
  const noSupport = {
    devices: 0, prefixes: 0, oldest_device_age_hours: 0,
    best_device_confirmed_uploads: 0, best_device_active_days: 0,
    best_device_distinct_keys: 1, pinned: 0
  };

  assert.equal(judgeKeySupport({ ...noSupport, devices: 2, prefixes: 2 }).rule, 'R1');
  assert.equal(judgeKeySupport({ ...noSupport, devices: 2, prefixes: 2 }).eligible, true);

  // Fifty devices behind one residential line is still one line.
  const farmed = judgeKeySupport({ ...noSupport, devices: 50, prefixes: 1 });
  assert.equal(farmed.eligible, false, 'device farming on a single prefix must not corroborate');
  assert.equal(farmed.tier, 'candidate');

  // The realistic sole-contributor path for Tibet/Qinghai/Ningxia.
  const established = judgeKeySupport({
    ...noSupport, devices: 1, prefixes: 1, oldest_device_age_hours: 8 * 24,
    best_device_confirmed_uploads: 6, best_device_active_days: 4
  });
  assert.equal(established.rule, 'R2');
  assert.equal(established.eligible, true);

  // Each R2 condition is load-bearing.
  assert.equal(judgeKeySupport({ ...noSupport, devices: 1, oldest_device_age_hours: 24, best_device_confirmed_uploads: 6, best_device_active_days: 4 }).eligible, false, 'too new');
  assert.equal(judgeKeySupport({ ...noSupport, devices: 1, oldest_device_age_hours: 8 * 24, best_device_confirmed_uploads: 2, best_device_active_days: 4 }).eligible, false, 'too few uploads');
  assert.equal(judgeKeySupport({ ...noSupport, devices: 1, oldest_device_age_hours: 8 * 24, best_device_confirmed_uploads: 6, best_device_active_days: 1 }).eligible, false, 'too few active days');
  assert.equal(
    judgeKeySupport({ ...noSupport, devices: 1, oldest_device_age_hours: 8 * 24, best_device_confirmed_uploads: 6, best_device_active_days: 4, best_device_distinct_keys: 3 }).eligible,
    false,
    'a device that has switched province or carrier does not qualify as a stable sole source'
  );

  // An admin pin is the escape hatch for a brand-new sole contributor.
  assert.equal(judgeKeySupport({ ...noSupport, devices: 1, pinned: 1 }).rule, 'R3');
  assert.equal(judgeKeySupport({ ...noSupport, devices: 1, pinned: 1 }).eligible, true);

  assert.equal(judgeKeySupport(noSupport).eligible, false);

  // ---------------------------------------------------------------------------
  // Node plausibility
  // ---------------------------------------------------------------------------
  const goodNode = { speed: 12, latency: 40, loss: 0, port: 443, colo: 'HKG' };
  assert.equal(judgeNode(goodNode, { isCloudflareIp: true }).verdict, 'ok');

  assert.equal(judgeNode(goodNode, { isCloudflareIp: false }).verdict, 'drop', 'non-Cloudflare IP must be dropped');
  assert.equal(judgeNode({ ...goodNode, speed: 999999 }, { isCloudflareIp: true }).verdict, 'drop');
  assert.equal(judgeNode({ ...goodNode, speed: 1e308 }, { isCloudflareIp: true }).verdict, 'drop');
  assert.equal(judgeNode({ ...goodNode, latency: 99999 }, { isCloudflareIp: true }).verdict, 'drop');

  // Demote, not drop: keep the contribution record but withhold DNS eligibility.
  assert.equal(judgeNode({ ...goodNode, speed: 500 }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, loss: 40 }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, port: 9999 }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, colo: 'XXX' }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, colo: '??' }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, colo: undefined }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(judgeNode({ ...goodNode, speed: 0 }, { isCloudflareIp: true }).verdict, 'demote');
  assert.equal(
    judgeNode({ ...goodNode, latency: 1 }, { isCloudflareIp: true, clientTcpRtt: 40 }).reason,
    'latency_below_edge_rtt',
    'a node cannot beat the edge RTT the uploader was measured at'
  );
  assert.equal(judgeNode(goodNode, { isCloudflareIp: true, clientTcpRtt: 40 }).verdict, 'ok');

  // ---------------------------------------------------------------------------
  // The proof-of-concept payload must be inert end to end
  // ---------------------------------------------------------------------------
  const pocGeo = { country: 'CN', asn: 14061, asOrganization: 'DigitalOcean, LLC' };
  assert.equal(serverHardVerdict(pocGeo).ok, false, 'PoC upload source must be untrusted');
  assert.equal(
    judgeNode({ speed: 999999, latency: 1, loss: 0, port: 443, colo: 'HKG' }, { isCloudflareIp: isCloudflareIp('203.0.113.9', ranges) }).verdict,
    'drop',
    'PoC node must be dropped'
  );

  // ---------------------------------------------------------------------------
  // Abuse-control grouping
  // ---------------------------------------------------------------------------
  assert.equal(ipPrefix('203.0.113.9'), '203.0.113.0/24');
  assert.equal(ipPrefix('1.2.3.4'), '1.2.3.0/24');
  assert.equal(ipPrefix('2606:4700:3119::ac40:99e5'), '2606:4700:3119::/48');
  assert.equal(ipPrefix('not-an-ip'), '', 'unparsable input must not collapse into a shared bucket');
  assert.equal(ipPrefix(''), '');
  // Addresses on one residential line must share a bucket, or a per-prefix quota is useless.
  assert.equal(ipPrefix('203.0.113.9'), ipPrefix('203.0.113.200'));
  assert.notEqual(ipPrefix('203.0.113.9'), ipPrefix('203.0.114.9'));

  // ---------------------------------------------------------------------------
  // Misc behaviour
  // ---------------------------------------------------------------------------
  assert.equal(parseLimit('abc', 30, 100), 30, 'a non-numeric limit must not reach SQL as NaN');
  assert.equal(parseLimit('500', 30, 100), 100);
  assert.equal(parseLimit(null, 30, 100), 30);
  assert.equal(parseLimit('-1', 30, 100), 30);

  for (const ip of ['2606:4700:3119::ac40:99e5', '::1', '2001:db8::1']) {
    assert.equal(isIpv6Address(ip), true, `${ip} should be accepted`);
  }
  for (const ip of ['::::', '1:2:3:4:5:6:7:8:9', '12345::', '2001:db8::1::2', '1.2.3.4:', 'fe80::1%eth0']) {
    assert.equal(isIpv6Address(ip), false, `${ip} should be rejected`);
  }

  // ---------------------------------------------------------------------------
  // Structural invariants (config and layering, not implementation text)
  // ---------------------------------------------------------------------------
  const wranglerSource = repoFile('wrangler.jsonc');
  assert.match(wranglerSource, /"cache"\s*:\s*\{\s*"enabled"\s*:\s*true\s*\}/s, 'workers cache must stay enabled');
  assert.match(wranglerSource, /"head_sampling_rate"\s*:\s*1\b/, 'sampling below 1 hides errors from every log');

  // The worker degrades open when a limiter binding is missing, so the config is what
  // guarantees production is actually protected.
  for (const limiter of ['UPLOAD_LIMITER', 'REGISTER_LIMITER', 'SPEEDTEST_LIMITER']) {
    assert.match(wranglerSource, new RegExp(`"name":\\s*"${limiter}"`), `${limiter} must be bound in wrangler.jsonc`);
  }

  // Every migration must be additive: rewriting an applied file leaves deployed databases and
  // fresh ones with different schemas.
  const migration = repoFile('migrations/0005_trust_and_ops.sql');
  assert.match(migration, /ALTER TABLE uploads ADD COLUMN cf_client_ip_prefix/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS system_state/);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN)\b/i, 'migrations must not drop existing objects');

  /**
   * DNS reconciliation must stay off the upload path. Per-upload DNS work once wedged sync
   * behind the shared 1200 req/5min API quota (178k failed 10429 calls, 2026-07): only the
   * 30-minute cron and explicit admin actions may opt in via syncDns.
   */
  assert.match(repoFile('src/index.ts'), /syncDns:\s*true/, 'cron must opt in to DNS sync');
  // Asserting the absence of the opt-in states the invariant directly, and unlike pinning the
  // exact call expression it survives renaming the background task or its entry point.
  assert.doesNotMatch(repoFile('src/public-api.ts'), /syncDns:\s*true/, 'the upload path must not opt in to DNS sync');
  assert.match(repoFile('src/admin-api.ts'), /syncDns:\s*true/, 'admin actions opt in for immediate effect');

  /**
   * Background work must go through backgroundTask(), which logs rejections. A bare
   * ctx.waitUntil resolves after the response is sent, so index.ts's try/catch cannot see it
   * and the failure is invisible.
   */
  for (const file of ['src/index.ts', 'src/public-api.ts', 'src/api.ts', 'src/admin-api.ts', 'src/dns.ts', 'src/database.ts']) {
    assert.doesNotMatch(repoFile(file), /ctx\.waitUntil\(/, `${file} must use backgroundTask() instead of ctx.waitUntil`);
  }
  assert.match(repoFile('src/observability.ts'), /ctx\.waitUntil\(/, 'observability.ts owns the single waitUntil boundary');
});

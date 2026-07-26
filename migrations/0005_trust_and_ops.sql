-- Preserve what the edge actually observed alongside what the client claimed.
-- client_ip is once again cf-connecting-ip; the client's own claim stays in egress_ip.
ALTER TABLE uploads ADD COLUMN cf_client_ip_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN cf_colo TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN cf_client_tcp_rtt INTEGER;
ALTER TABLE uploads ADD COLUMN geo_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE uploads ADD COLUMN geo_conflict INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE uploads ADD COLUMN trust_reasons TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN client_version TEXT NOT NULL DEFAULT '';

-- Separates "this measurement may steer DNS" from "this upload came from a trusted source".
-- Until now both were folded into node_results.trusted.
ALTER TABLE node_results ADD COLUMN cf_range_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_results ADD COLUMN dns_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_results ADD COLUMN demote_reason TEXT NOT NULL DEFAULT '';

-- built_at is the generation stamp the atomic rebuild needs, and doubles as the staleness
-- signal for /api/health.
ALTER TABLE aggregates ADD COLUMN built_at TEXT NOT NULL DEFAULT '';
ALTER TABLE aggregates ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE aggregates ADD COLUMN support_devices INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aggregates ADD COLUMN support_rule TEXT NOT NULL DEFAULT '';

-- Grouping key for abuse response: a 60-second rate limit cannot stop sustained
-- device-farming, but a per-prefix daily cap can.
ALTER TABLE devices ADD COLUMN created_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN created_ip_prefix TEXT NOT NULL DEFAULT '';

-- Carrier identification by ASN is authoritative; the AS-organization string is a fallback.
CREATE TABLE IF NOT EXISTS carrier_asns (
  asn INTEGER PRIMARY KEY,
  carrier TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cf_colos (
  code TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Manual escape hatch for a province whose only contributor is new (see the R3 rule).
CREATE TABLE IF NOT EXISTS device_pins (
  device_id TEXT PRIMARY KEY,
  province_code TEXT NOT NULL,
  carrier TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_prefixes (
  prefix TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Replaces RESERVED_NICKNAME_DEVICE_IDS, which was a hardcoded set in database.ts.
CREATE TABLE IF NOT EXISTS reserved_nicknames (
  nickname TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (nickname, device_id)
);

-- Coordination row store: the rebuild lease, counters that must survive log sampling.
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO reserved_nicknames (nickname, device_id, created_at) VALUES
  ('一万AI分享', '0bf89a67-9be2-4521-8ebb-d83c0954ed07', datetime('now')),
  ('一万AI分享', '6adf90ff-f824-4589-b182-31f15f808100', datetime('now'));

INSERT OR IGNORE INTO carrier_asns (asn, carrier, label, created_at) VALUES
  (4134, 'ct', 'CHINANET-BACKBONE', datetime('now')),
  (4809, 'ct', 'China Telecom Next Generation Carrier Network', datetime('now')),
  (4811, 'ct', 'China Telecom Group', datetime('now')),
  (58461, 'ct', 'China Telecom Guangdong', datetime('now')),
  (140061, 'ct', 'China Telecom Group', datetime('now')),
  (9808, 'cm', 'China Mobile CMNET', datetime('now')),
  (24400, 'cm', 'China Mobile Communications', datetime('now')),
  (56040, 'cm', 'China Mobile Guangdong', datetime('now')),
  (56041, 'cm', 'China Mobile provincial network', datetime('now')),
  (56042, 'cm', 'China Mobile provincial network', datetime('now')),
  (56044, 'cm', 'China Mobile provincial network', datetime('now')),
  (56046, 'cm', 'China Mobile provincial network', datetime('now')),
  (56047, 'cm', 'China Mobile provincial network', datetime('now')),
  (56048, 'cm', 'China Mobile provincial network', datetime('now')),
  (132525, 'cm', 'China Mobile provincial network', datetime('now')),
  (4837, 'cu', 'CHINA169-BACKBONE', datetime('now')),
  (4808, 'cu', 'CNCGROUP Beijing province network', datetime('now')),
  (9929, 'cu', 'China Unicom CUII', datetime('now')),
  (17621, 'cu', 'China Unicom Shanghai', datetime('now')),
  (17622, 'cu', 'China Unicom Guangzhou', datetime('now')),
  (17623, 'cu', 'China Unicom Shenzhen', datetime('now')),
  (17816, 'cu', 'China Unicom Guangdong', datetime('now')),
  (4538, 'cu', 'CERNET/China Unicom peering', datetime('now'));

-- Colos reachable from mainland China. Used to replace the '' / 'N/A' colo filter, which a
-- client can bypass by sending any other three-letter string.
INSERT OR IGNORE INTO cf_colos (code, note, created_at) VALUES
  ('HKG', 'Hong Kong', datetime('now')),
  ('KHH', 'Kaohsiung', datetime('now')),
  ('TPE', 'Taipei', datetime('now')),
  ('NRT', 'Tokyo', datetime('now')),
  ('KIX', 'Osaka', datetime('now')),
  ('ICN', 'Seoul', datetime('now')),
  ('SIN', 'Singapore', datetime('now')),
  ('KUL', 'Kuala Lumpur', datetime('now')),
  ('BKK', 'Bangkok', datetime('now')),
  ('MNL', 'Manila', datetime('now')),
  ('CGK', 'Jakarta', datetime('now')),
  ('HAN', 'Hanoi', datetime('now')),
  ('SGN', 'Ho Chi Minh City', datetime('now')),
  ('BOM', 'Mumbai', datetime('now')),
  ('MAA', 'Chennai', datetime('now')),
  ('LAX', 'Los Angeles', datetime('now')),
  ('SJC', 'San Jose', datetime('now')),
  ('SEA', 'Seattle', datetime('now')),
  ('FRA', 'Frankfurt', datetime('now')),
  ('AMS', 'Amsterdam', datetime('now')),
  ('LHR', 'London', datetime('now')),
  ('SYD', 'Sydney', datetime('now')),
  ('PEK', 'Beijing', datetime('now')),
  ('SHA', 'Shanghai', datetime('now')),
  ('SZX', 'Shenzhen', datetime('now')),
  ('CAN', 'Guangzhou', datetime('now')),
  ('CTU', 'Chengdu', datetime('now')),
  ('TSN', 'Tianjin', datetime('now')),
  ('WUH', 'Wuhan', datetime('now')),
  ('JNB', 'Johannesburg', datetime('now'));

-- Serves both the ROW_NUMBER() partition in the rebuild and calibrateIpv6Geo's lookup.
CREATE INDEX IF NOT EXISTS idx_uploads_device_version_created ON uploads(device_id, ip_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_prefix_created ON uploads(cf_client_ip_prefix, created_at);
CREATE INDEX IF NOT EXISTS idx_uploads_trust_created ON uploads(trust_level, created_at);
CREATE INDEX IF NOT EXISTS idx_devices_created_prefix ON devices(created_ip_prefix, created_at);
CREATE INDEX IF NOT EXISTS idx_node_results_created_at ON node_results(created_at);
CREATE INDEX IF NOT EXISTS idx_node_results_dns_eligible ON node_results(dns_eligible, speed DESC, latency ASC);
CREATE INDEX IF NOT EXISTS idx_dns_updates_created_at ON dns_updates(created_at);
CREATE INDEX IF NOT EXISTS idx_dns_updates_lookup ON dns_updates(hostname, record_type, status, created_at DESC);

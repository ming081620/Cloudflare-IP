export type Carrier = 'ct' | 'cm' | 'cu' | 'other';
export type IpVersion = 'v4' | 'v6';

/** Cloudflare's rate-limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SPEED_TEST_KV: KVNamespace;
  DB: D1Database;
  UPLOAD_TOKEN: string;
  ADMIN_TOKEN?: string;
  DNS_API_TOKEN?: string;
  DNS_ZONE_ID?: string;
  DNS_ROOT_DOMAIN?: string;
  /** Surfaced to the panel so a fork links to its own repository, not this one. */
  REPO_URL?: string;
  /** 'shadow' (default) records the stricter model's verdict; 'enforce' lets it govern. */
  TRUST_ENFORCE?: string;
  /** '0' retires the pre-crowdtest KV endpoints without a deploy. */
  LEGACY_API_ENABLED?: string;
  DOMAIN_CT?: string;
  DOMAIN_CM?: string;
  DOMAIN_CU?: string;
  /** Optional so `wrangler dev` and the regression runner work without the bindings. */
  UPLOAD_LIMITER?: RateLimiter;
  REGISTER_LIMITER?: RateLimiter;
  SPEEDTEST_LIMITER?: RateLimiter;
}

export type TrustLevel = 'confirmed' | 'candidate' | 'untrusted';

/** Where the stored province/carrier actually came from. */
export type GeoSource = 'cf' | 'device_history' | 'client_narrow' | 'pin' | 'attested' | 'none';

export interface NodeRecord {
  ip: string;
  port: number;
  carrier: Carrier;
  latency: number;
  speed: number;
  loss: number;
  tls: boolean;
  colo?: string;
  region?: string;
  source?: string;
  updated_at: string;
  /**
   * False when the measurement is plausible enough to keep as a contribution record but not
   * to steer a DNS record. Undefined on the legacy KV path, which treats every node alike.
   */
  dns_eligible?: boolean;
  /** Why the node was demoted, for the admin audit view. */
  demote_reason?: string;
}

export interface UploadNodeInput {
  ip?: unknown;
  port?: unknown;
  carrier?: unknown;
  latency?: unknown;
  speed?: unknown;
  loss?: unknown;
  tls?: unknown;
  colo?: unknown;
  region?: unknown;
  source?: unknown;
}

export interface UploadPayload {
  source?: unknown;
  region?: unknown;
  carrier?: unknown;
  nodes?: unknown;
}

export interface PublicUploadPayload extends UploadPayload {
  nickname?: unknown;
  device_id?: unknown;
  device_token?: unknown;
  device_name?: unknown;
  ip_version?: unknown;
  client_region?: unknown;
  client_carrier?: unknown;
  direct_check?: unknown;
  /** Reported by the OpenWrt client from 0.2.0 onward; absent on the deployed fleet. */
  client_version?: unknown;
}

export interface DirectCheckResult {
  proxy_suspected: boolean;
  route_interface?: string;
  egress_ip?: string;
  egress_asn?: string;
  egress_country?: string;
  egress_org?: string;
  egress_region?: string;
  egress_city?: string;
  wan_interface?: string;
  warnings: string[];
}

export interface NodesStats {
  ct: number;
  cm: number;
  cu: number;
  other: number;
  best_speed: number;
  best_latency: number;
}

export interface NodesDataset {
  updated_at: string;
  total: number;
  stats: NodesStats;
  nodes: NodeRecord[];
}

export interface HistorySummary {
  key: string;
  uploaded_at: string;
  source?: string;
  region?: string;
  carrier?: Carrier;
  total: number;
  best_speed: number;
  best_latency: number;
}

export interface DomainMapping {
  carrier: Carrier;
  carrier_label: string;
  domain: string;
  ip: string;
  port: number;
  record_type: 'A' | 'AAAA';
  speed: number;
  latency: number;
  source?: string;
  region?: string;
  updated_at: string;
}

export interface RegisterResult {
  user_id: string;
  nickname: string;
  device_id: string;
  device_token: string;
}

export interface ServerGeo {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  asn?: number;
  asOrganization?: string;
  province_code: string;
  province_name: string;
  carrier: Carrier;
  /** Edge-measured RTT to the uploader, in ms. Set by Cloudflare, not forgeable. */
  clientTcpRtt?: number;
  colo?: string;
}

export interface PublicAggregate {
  key: string;
  ip_version: IpVersion;
  province_code: string;
  province_name: string;
  carrier: Carrier;
  carrier_label: string;
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
  /** 'confirmed' rows steer DNS; 'candidate' rows are shown on the panel but not written. */
  trust_level?: TrustLevel;
  support_devices?: number;
  /** Which corroboration rule granted eligibility: R1, R2, R3 or none. */
  support_rule?: string;
}

export type ApiSuccess<T> = {
  success: true;
  data?: T;
  message?: string;
} & Record<string, unknown>;

export interface ApiError {
  success: false;
  error: string;
}

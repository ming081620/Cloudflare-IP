import type { Carrier, ServerGeo } from './types';
import { stringOrUndefined } from './parse';

const PROVINCES: Record<string, { code: string; name: string; aliases: string[] }> = {
  bj: { code: 'bj', name: '北京', aliases: ['beijing', '北京'] },
  sh: { code: 'sh', name: '上海', aliases: ['shanghai', '上海'] },
  tj: { code: 'tj', name: '天津', aliases: ['tianjin', '天津'] },
  cq: { code: 'cq', name: '重庆', aliases: ['chongqing', '重庆'] },
  gd: { code: 'gd', name: '广东', aliases: ['guangdong', '广东', 'guangzhou', 'shenzhen'] },
  js: { code: 'js', name: '江苏', aliases: ['jiangsu', '江苏', 'nanjing', 'suzhou'] },
  zj: { code: 'zj', name: '浙江', aliases: ['zhejiang', '浙江', 'hangzhou', 'ningbo'] },
  sd: { code: 'sd', name: '山东', aliases: ['shandong', '山东', 'jinan', 'qingdao'] },
  ha: { code: 'ha', name: '河南', aliases: ['henan', '河南', 'zhengzhou'] },
  hb: { code: 'hb', name: '湖北', aliases: ['hubei', '湖北', 'wuhan'] },
  hn: { code: 'hn', name: '湖南', aliases: ['hunan', '湖南', 'changsha'] },
  he: { code: 'he', name: '河北', aliases: ['hebei', '河北', 'shijiazhuang'] },
  sx: { code: 'sx', name: '陕西', aliases: ['shaanxi', '陕西', 'xian', "xi'an"] },
  sn: { code: 'sn', name: '山西', aliases: ['shanxi', '山西', 'taiyuan'] },
  sc: { code: 'sc', name: '四川', aliases: ['sichuan', '四川', 'chengdu'] },
  fj: { code: 'fj', name: '福建', aliases: ['fujian', '福建', 'fuzhou', 'xiamen'] },
  ah: { code: 'ah', name: '安徽', aliases: ['anhui', '安徽', 'hefei'] },
  jx: { code: 'jx', name: '江西', aliases: ['jiangxi', '江西', 'nanchang'] },
  ln: { code: 'ln', name: '辽宁', aliases: ['liaoning', '辽宁', 'shenyang', 'dalian'] },
  jl: { code: 'jl', name: '吉林', aliases: ['jilin', '吉林', 'changchun'] },
  hl: { code: 'hl', name: '黑龙江', aliases: ['heilongjiang', '黑龙江', 'harbin'] },
  gx: { code: 'gx', name: '广西', aliases: ['guangxi', '广西', 'nanning'] },
  yn: { code: 'yn', name: '云南', aliases: ['yunnan', '云南', 'kunming'] },
  gz: { code: 'gz', name: '贵州', aliases: ['guizhou', '贵州', 'guiyang'] },
  gs: { code: 'gs', name: '甘肃', aliases: ['gansu', '甘肃', 'lanzhou'] },
  nx: { code: 'nx', name: '宁夏', aliases: ['ningxia', '宁夏', 'yinchuan'] },
  qh: { code: 'qh', name: '青海', aliases: ['qinghai', '青海', 'xining'] },
  xj: { code: 'xj', name: '新疆', aliases: ['xinjiang', '新疆', 'urumqi'] },
  xz: { code: 'xz', name: '西藏', aliases: ['tibet', 'xizang', '西藏', 'lhasa'] },
  nm: { code: 'nm', name: '内蒙古', aliases: ['inner mongolia', 'neimenggu', '内蒙古', 'hohhot'] },
  hi: { code: 'hi', name: '海南', aliases: ['hainan', '海南', 'haikou'] }
};

export function detectServerGeo(request: Request): ServerGeo {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const region = stringOrUndefined(cf?.region);
  const city = stringOrUndefined(cf?.city);
  const asOrganization = stringOrUndefined(cf?.asOrganization);
  const province = detectProvince(region, city);

  return {
    ip,
    country: stringOrUndefined(cf?.country),
    region,
    city,
    asn: typeof cf?.asn === 'number' ? cf.asn : undefined,
    asOrganization,
    province_code: province.code,
    province_name: province.name,
    carrier: detectCarrier(asOrganization),
    clientTcpRtt: typeof cf?.clientTcpRtt === 'number' ? cf.clientTcpRtt : undefined,
    colo: stringOrUndefined(cf?.colo)
  };
}

/**
 * Latin aliases are matched as whole tokens, CJK ones as substrings.
 *
 * The previous substring-only form meant `'xianning'.includes('xian')`, so Xianning (Hubei)
 * and Xiantao (Hubei) both resolved to Shaanxi. Apostrophes stay inside a token so "Xi'an"
 * still matches. No CJK province name is a substring of another (河南/湖南, 山西/陕西,
 * 河北/湖北 are all distinct), so substring matching remains correct for those.
 */
function matchProvince(text: string): { code: string; name: string } | null {
  if (!text) {
    return null;
  }
  const lowered = text.toLowerCase();
  const tokens = new Set(lowered.split(/[^a-z0-9']+/).filter(Boolean));

  for (const province of Object.values(PROVINCES)) {
    for (const alias of province.aliases) {
      const needle = alias.toLowerCase();
      const hit = /^[a-z0-9' ]+$/.test(needle)
        ? needle.includes(' ')
          ? lowered.includes(needle)
          : tokens.has(needle)
        : lowered.includes(needle);
      if (hit) {
        return { code: province.code, name: province.name };
      }
    }
  }
  return null;
}

/**
 * Values are tried in the order given, most authoritative first, rather than being joined into
 * one string — otherwise a city alias could outrank a correct region.
 */
export function detectProvince(...values: Array<string | undefined>): { code: string; name: string } {
  const present = values.filter((value): value is string => Boolean(value && value.trim()));

  for (const value of present) {
    const hit = matchProvince(value);
    if (hit) {
      return hit;
    }
  }
  // Last resort: the combined text, which catches aliases split across region and city.
  const combined = matchProvince(present.join(' '));
  return combined ?? { code: 'unknown', name: '未知' };
}

/**
 * Matched against the AS organization name with word boundaries. The previous substring
 * form tested for a bare 'ct', so any org merely containing those two letters
 * ("Connectivity", "Octopus", "ACTCORP", "Direct Connect") was classified as China Telecom
 * and thereby passed the DNS trust gate. Same class of bug for 'cnc' and Unicom.
 */
const CARRIER_ORG_PATTERNS: ReadonlyArray<readonly [RegExp, Carrier]> = [
  [/china\s*telecom|chinanet|\bct[-_ ]?cn\b|no\.?\s*31\s*,?\s*jin-?rong/i, 'ct'],
  [/china\s*mobile|\bcmcc\b|\bcmnet\b|\bcmi\b/i, 'cm'],
  [/china\s*unicom|\bunicom\b|cncgroup|china\s*169|\bcuii\b/i, 'cu']
];

export function detectCarrier(asOrganization?: string): Carrier {
  const text = (asOrganization ?? '').trim();
  if (!text) {
    return 'other';
  }
  for (const [pattern, carrier] of CARRIER_ORG_PATTERNS) {
    if (pattern.test(text)) {
      return carrier;
    }
  }
  return 'other';
}

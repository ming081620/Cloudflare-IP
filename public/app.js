const carrierLabels = { ct: '中国电信', cm: '中国移动', cu: '中国联通', other: '其他' };
const coloLabels = {
  HKG: '香港', NRT: '东京', KIX: '大阪', ICN: '首尔', SIN: '新加坡', TPE: '台北',
  SJC: '圣何塞', LAX: '洛杉矶', SEA: '西雅图', FRA: '法兰克福', LHR: '伦敦',
  CDG: '巴黎', AMS: '阿姆斯特丹', DFW: '达拉斯', IAD: '华盛顿', ORD: '芝加哥'
};

/* CSS cannot override the per-card inline animation-delay, so the value is skipped here. */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let latestAggregates = [];
let selectedCarrier = '';
let selectedIpVersion = '';
let selectedProvince = '';

const aggregatesEl = document.getElementById('aggregates');
const statsEl = document.getElementById('stats');
const updatedAtEl = document.getElementById('updatedAt');
const refreshBtn = document.getElementById('refreshBtn');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');

/*
 * Delegated once per group, at init. renderProvinceChips() used to attach its own listener on
 * every call — and it is called from loadLatest(), which the refresh button triggers — so after
 * N refreshes a single chip click ran renderAggregates() N times. Delegation survives the
 * innerHTML replacement, so binding once is both correct and leak-free.
 */
function bindChipGroup(containerId, dataAttr, onSelect) {
  const container = document.getElementById(containerId);
  container.addEventListener('click', (e) => {
    const chip = e.target.closest(`[data-${dataAttr}]`);
    if (!chip) return;
    const value = chip.getAttribute(`data-${dataAttr}`) || '';
    setActiveChip(container, dataAttr, value);
    onSelect(value);
  });
}

function setActiveChip(container, dataAttr, value) {
  container.querySelectorAll(`[data-${dataAttr}]`).forEach((chip) => {
    const active = (chip.getAttribute(`data-${dataAttr}`) || '') === value;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

bindChipGroup('carrierChips', 'carrier', (v) => { selectedCarrier = v; renderAggregates(); });
bindChipGroup('ipVersionChips', 'ip-version', (v) => { selectedIpVersion = v; renderAggregates(); });
bindChipGroup('provinceChips', 'province', (v) => { selectedProvince = v; renderAggregates(); });

refreshBtn.addEventListener('click', loadLatest);
searchInput.addEventListener('input', renderAggregates);
sortSelect.addEventListener('change', renderAggregates);
document.getElementById('copyInstallBtn').addEventListener('click', () => {
  copyText(document.getElementById('installCommand').textContent.trim(), '安装命令');
});

loadLatest();

async function loadLatest() {
  refreshBtn.disabled = true;
  refreshBtn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 1s linear infinite" aria-hidden="true"></i> 加载中';
  aggregatesEl.setAttribute('aria-busy', 'true');

  // 骨架屏
  statsEl.innerHTML = Array(5).fill('<div class="stat"><span><div class="skel" style="width:60px;height:14px"></div></span><strong><div class="skel" style="width:80px;height:24px;margin-top:4px"></div></strong></div>').join('');
  aggregatesEl.innerHTML = '<div class="empty">正在加载公开众测聚合数据...</div>';

  let data;
  try {
    const res = await fetch('/api/public/latest');
    if (!res.ok) throw new Error('请求失败（HTTP ' + res.status + '）');
    data = await res.json();
    if (!data.success) throw new Error(data.error || '接口返回失败');
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求失败';
    latestAggregates = [];
    statsEl.innerHTML = '';
    aggregatesEl.innerHTML = '<div class="error">加载失败：' + escapeHtml(message) + '</div>';
    updatedAtEl.textContent = '加载失败';
    // Also clear the derived filter UI, or stale province chips and a stale result count stay
    // on screen describing data that is no longer loaded.
    renderProvinceChips();
    renderQuickDomains();
    document.getElementById('resultCount').textContent = '';
    return;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = '<i class="ri-refresh-line" aria-hidden="true"></i> 刷新数据';
    aggregatesEl.setAttribute('aria-busy', 'false');
  }

  latestAggregates = data.aggregates || [];
  applyDeployment(data);
  renderStats(data);
  renderProvinceChips();
  renderAggregates();
  renderQuickDomains();
  updatedAtEl.textContent = data.updated_at ? '最后聚合：' + formatBeijingTime(data.updated_at) : '暂无聚合数据';
}

/*
 * Repository links come from the API rather than being baked into the markup: a fork used to
 * tell its own users to install the upstream project's packages.
 */
function applyDeployment(data) {
  const repo = typeof data.repo_url === 'string' ? data.repo_url.replace(/\/+$/, '') : '';
  if (!repo) return;

  document.querySelectorAll('[data-repo-link]').forEach((node) => {
    node.href = repo + (node.getAttribute('data-repo-link') || '');
  });

  const command = document.getElementById('installCommand');
  command.textContent = command.textContent.replace(
    /https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\//,
    repo.replace('github.com', 'raw.githubusercontent.com') + '/'
  );
}

function renderStats(data) {
  const provinces = new Set(latestAggregates.map((i) => i.province_code));
  const users = new Set(latestAggregates.map((i) => i.nickname));
  const ipv6Total = latestAggregates.filter((i) => i.ip_version === 'v6').length;
  const bestSpeed = latestAggregates.reduce((m, i) => Math.max(m, Number(i.speed) || 0), 0);
  const items = [
    ['聚合记录', data.total || latestAggregates.length],
    ['覆盖省份', provinces.size],
    ['贡献用户', users.size],
    ['IPv6 记录', ipv6Total],
    ['最快速度', formatNumber(bestSpeed) + ' MB/s']
  ];
  statsEl.innerHTML = items
    .map(([l, v]) => '<div class="stat"><span>' + escapeHtml(l) + '</span><strong>' + escapeHtml(v) + '</strong></div>')
    .join('');
}

function renderProvinceChips() {
  const container = document.getElementById('provinceChips');
  const provinces = [...new Map(latestAggregates.map((i) => [i.province_code, i.province_name])).entries()]
    .filter(([c]) => c)
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));

  if (selectedProvince && !provinces.some(([c]) => c === selectedProvince)) selectedProvince = '';

  container.innerHTML = '<button type="button" class="chip" data-province="">全部</button>'
    + provinces
      .map(([c, n]) => '<button type="button" class="chip" data-province="' + escapeAttr(c) + '">' + escapeHtml(n) + '</button>')
      .join('');

  // Re-apply the selection after the rebuild, or the visual state resets while the filter
  // silently stays in effect.
  setActiveChip(container, 'province', selectedProvince);
}

/** The four fastest live hostnames, replacing four hardcoded ones that could go stale. */
function renderQuickDomains() {
  const list = document.getElementById('quickDomains');
  const top = [...latestAggregates]
    .sort((a, b) => (Number(b.speed) || 0) - (Number(a.speed) || 0))
    .slice(0, 4);

  if (!top.length) {
    list.innerHTML = '<li><span class="ft-static"><i class="ri-links-line" aria-hidden="true"></i> 暂无聚合数据</span></li>';
    return;
  }

  list.innerHTML = top
    .map((item) =>
      '<li><button type="button" class="ft-static copy-hint" data-copy="' + escapeAttr(item.hostname)
      + '" data-copy-label="域名"><i class="ri-links-line" aria-hidden="true"></i> ' + escapeHtml(item.hostname) + '</button></li>'
    )
    .join('');
  bindCopyTargets(list);
}

function bindCopyTargets(root) {
  root.querySelectorAll('[data-copy]').forEach((node) => {
    node.addEventListener('click', () => copyText(node.dataset.copy, node.dataset.copyLabel));
  });
}

function renderAggregates() {
  const search = (searchInput.value || '').toLowerCase().trim();
  const sort = sortSelect.value;

  const items = latestAggregates.filter((i) => {
    if (selectedCarrier && i.carrier !== selectedCarrier) return false;
    if (selectedIpVersion && i.ip_version !== selectedIpVersion) return false;
    if (selectedProvince && i.province_code !== selectedProvince) return false;
    if (search) {
      const hay = [i.province_name, i.hostname, i.ip, i.colo, i.nickname].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (sort === 'speed') items.sort((a, b) => (Number(b.speed) || 0) - (Number(a.speed) || 0));
  else if (sort === 'latency') items.sort((a, b) => (Number(a.latency) || 9999) - (Number(b.latency) || 9999));
  else items.sort(compareAggregateCards);

  document.getElementById('resultCount').innerHTML = '共 <strong>' + items.length + '</strong> 条结果';

  if (!items.length) {
    aggregatesEl.innerHTML = '<div class="empty">暂无符合条件的可信聚合数据</div>';
    return;
  }

  aggregatesEl.innerHTML = items.map((item, idx) => renderAggregateCard(item, idx)).join('');
  bindCopyTargets(aggregatesEl);
}

function renderAggregateCard(item, idx) {
  const isV6 = item.ip_version === 'v6';
  const typeLabel = isV6 ? 'IPv6 · AAAA' : 'IPv4 · ' + (item.record_type || 'A');
  const province = item.province_name || '未知省份';
  const carrier = carrierLabels[item.carrier] || item.carrier_label || item.carrier || '其他';
  // Escaped even though the server constrains it to ct/cm/cu — a single-layer, non-local
  // defence is exactly the kind that quietly stops holding.
  const carrierKey = escapeAttr(item.carrier || 'ct');
  const colo = formatColo(item.colo);
  const delayStyle = reduceMotion ? '' : ' style="animation-delay:' + Math.min(idx * 40, 400) + 'ms"';

  return '<article class="card ' + (isV6 ? 'v6 ' : '') + 'carrier-' + carrierKey + '"' + delayStyle + '>'
    + '<div class="card-stripe"></div>'
    + '<div class="card-body">'
    // 头部
    + '<div class="card-head">'
    +   '<div class="card-title">'
    +     '<h3>' + escapeHtml(province) + ' · ' + escapeHtml(carrier) + '</h3>'
    +     '<div class="badge-row">'
    +       '<span class="badge strong ' + (isV6 ? 'ipv6' : '') + '">' + escapeHtml(typeLabel) + '</span>'
    +       trustBadge(item)
    +     '</div>'
    +   '</div>'
    +   '<span class="colo-badge">' + escapeHtml(colo) + '</span>'
    + '</div>'
    // 域名/IP
    + '<div class="endpoint-body">'
    +   '<div class="endpoint-row">'
    +     '<span class="field-label">域名</span>'
    +     '<code class="host" data-copy="' + escapeAttr(item.hostname) + '" data-copy-label="' + escapeAttr(typeLabel + ' 域名') + '" title="点击复制域名">' + escapeHtml(item.hostname) + '</code>'
    +     '<button type="button" class="copy-hint" data-copy="' + escapeAttr(item.hostname) + '" data-copy-label="域名" aria-label="复制域名 ' + escapeAttr(item.hostname) + '"><i class="ri-file-copy-line" aria-hidden="true"></i></button>'
    +   '</div>'
    +   '<div class="endpoint-row">'
    +     '<span class="field-label">IP</span>'
    +     '<code class="ip ' + (isV6 ? 'v6' : '') + '" data-copy="' + escapeAttr(item.ip) + '" data-copy-label="' + escapeAttr(typeLabel + ' IP') + '" title="点击复制 IP">' + escapeHtml(item.ip) + '</code>'
    +     '<button type="button" class="copy-hint" data-copy="' + escapeAttr(item.ip) + '" data-copy-label="IP" aria-label="复制 IP ' + escapeAttr(item.ip) + '"><i class="ri-file-copy-line" aria-hidden="true"></i></button>'
    +   '</div>'
    + '</div>'
    // 指标 2×2
    + '<div class="metrics">'
    +   '<div class="metric"><span>速度</span><strong>' + formatNumber(item.speed) + ' MB/s</strong></div>'
    +   '<div class="metric"><span>延迟</span><strong>' + formatNumber(item.latency) + ' ms</strong></div>'
    +   '<div class="metric"><span>丢包</span><strong>' + formatNumber(item.loss) + '%</strong></div>'
    +   '<div class="metric"><span>贡献者</span><strong>' + escapeHtml(item.nickname || '匿名') + '</strong></div>'
    + '</div>'
    // 同步行
    + '<p class="sync-line"><i class="ri-time-line" aria-hidden="true"></i> 最后同步：' + escapeHtml(formatRelativeTime(item.updated_at)) + ' · 北京时间 ' + escapeHtml(formatBeijingTime(item.updated_at)) + '</p>'
    + '</div></article>';
}

/*
 * A candidate row is a genuine measurement that has not yet been corroborated by a second
 * independent network, so it is shown but not written to DNS. Surfacing it turns the security
 * control into feedback: a contributor can see why their province is not live yet.
 */
function trustBadge(item) {
  if (item.trust_level && item.trust_level !== 'confirmed') {
    const support = Number(item.support_devices) || 0;
    return '<span class="badge" title="尚未获得独立佐证，暂不写入 DNS（当前贡献设备 '
      + support + ' 台）">候选</span>';
  }
  return '<span class="badge good">可信直连</span>';
}

function compareAggregateCards(a, b) {
  const p = String(a.province_name || '').localeCompare(String(b.province_name || ''), 'zh-CN');
  if (p) return p;
  const cl = (carrierLabels[a.carrier] || '').localeCompare(carrierLabels[b.carrier] || '', 'zh-CN');
  if (cl) return cl;
  const order = { v4: 0, v6: 1 };
  if ((order[a.ip_version] ?? 0) !== (order[b.ip_version] ?? 0)) return (order[a.ip_version] ?? 0) - (order[b.ip_version] ?? 0);
  return endpointScore(b) - endpointScore(a);
}

function endpointScore(item) {
  return (Number(item.speed) || 0) * 1000 - (Number(item.latency) || 0) * 2 - (Number(item.loss) || 0) * 50;
}

/* 工具函数 */
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showNotice((label || '内容') + ' 已成功复制');
  } catch {
    showNotice('复制失败，请手动选择文本复制');
  }
}

function showNotice(text) {
  const el = document.getElementById('notice');
  document.getElementById('noticeMsg').textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1500);
}

function formatBeijingTime(v) {
  return new Date(v).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatRelativeTime(v) {
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return '未知';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

function formatColo(v) {
  const c = String(v || '').trim().toUpperCase();
  if (!c || c === 'N/A') return '归属未知';
  return (coloLabels[c] || c) + ' · ' + c;
}

function formatNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(v) {
  return escapeHtml(v).replace(/\n/g, '&#10;');
}

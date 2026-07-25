export function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cloudflare 优选 IP 公开众测面板</title>
  <meta name="description" content="面向 OpenWrt 的 Cloudflare 优选 IP 公开众测、自动测速、可信聚合和省份运营商 DNS 优选平台。">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%232563eb'/%3E%3Cpath d='M37 7 18 35h15l-4 22 19-30H33z' fill='white'/%3E%3C/svg%3E">
  <link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
  <style>
    :root {
      --bg: #f4f7fb;
      --panel: #ffffff;
      --panel-2: #f8fafc;
      --line: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
      --light: #94a3b8;
      --accent: #0f766e;
      --accent-bg: #e8f7f5;
      --accent-hover: #0b7669;
      --blue: #2563eb;
      --blue-light: #dbeafe;
      --blue-border: rgba(37,99,235,.22);
      --green: #059669;
      --green-light: #d1fae5;
      --green-border: rgba(5,150,105,.22);
      --purple: #7c3aed;
      --purple-light: #ede9fe;
      --purple-border: rgba(124,58,237,.22);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
      letter-spacing: 0;
      -webkit-font-smoothing: antialiased;
    }
    button, select, a, input { font: inherit; }

    /* ── 动画 ── */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes cardIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes shimmer { 0% { background-position: -300px 0; } 100% { background-position: 300px 0; } }
    @keyframes pulse { 0%,100%{ box-shadow:0 0 0 0 rgba(16,185,129,.55); } 70%{ box-shadow:0 0 0 7px rgba(16,185,129,0); } }
    @keyframes gradFlow { 0%{ background-position:0% 50%; } 50%{ background-position:100% 50%; } 100%{ background-position:0% 50%; } }
    @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }

    .skel { background: linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%); background-size: 300px 100%; animation: shimmer 1.4s infinite; border-radius: 6px; }

    /* ── 通用 ── */
    .wrap { width: min(1240px, calc(100% - 32px)); margin: 0 auto; }

    /* ── 顶部 Hero 区 ── */
    .hero {
      position: relative;
      background: linear-gradient(168deg, #ffffff 0%, #eef4ff 35%, #e8f0fe 55%, #f0f4ff 80%, #f4f7fb 100%);
      padding-bottom: 48px;
      overflow: hidden;
    }
    /* 装饰光斑 */
    .hero::before, .hero::after {
      content: ''; position: absolute; border-radius: 50%; pointer-events: none; filter: blur(70px);
    }
    .hero::before { width: 420px; height: 420px; background: rgba(59,130,246,.1); top: -100px; left: -80px; }
    .hero::after  { width: 320px; height: 320px; background: rgba(124,58,237,.07); bottom: -40px; right: -60px; }
    /* 网格纹理 */
    .hero-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-size: 48px 48px;
      background-image:
        linear-gradient(to right, rgba(148,163,184,.1) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(148,163,184,.1) 1px, transparent 1px);
      mask-image: linear-gradient(180deg, rgba(0,0,0,.12) 0%, transparent 70%);
    }

    .hero-content { position: relative; z-index: 1; }

    /* 导航 */
    header {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 16px; padding: 24px 0 0;
      animation: fadeUp .6s cubic-bezier(.16,1,.3,1) both;
    }
    .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
    .brand-icon {
      width: 42px; height: 42px; border-radius: 12px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 20px;
      box-shadow: 0 6px 20px rgba(37,99,235,.3);
      transition: transform .35s cubic-bezier(.34,1.56,.64,1);
    }
    .brand:hover .brand-icon { transform: rotate(-8deg) scale(1.08); }
    .brand h1 { font-size: 18px; font-weight: 700; letter-spacing: -.02em; line-height: 1.2; margin: 0; }
    .brand .sub { font-size: 13px; color: var(--muted); margin: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 38px; padding: 0 14px; border-radius: 10px;
      font-size: 13px; font-weight: 500; cursor: pointer;
      border: 1px solid var(--line); background: #fff; color: var(--text);
      transition: all .2s ease;
      text-decoration: none; white-space: nowrap;
    }
    .btn:hover { border-color: #93c5fd; background: #f0f7ff; }
    .btn.primary {
      border-color: var(--blue-border); background: var(--blue-light); color: #1e40af;
    }
    .btn.primary:hover { background: #bfdbfe; }

    /* 标题区 */
    .hero-title {
      text-align: center;
      padding: 40px 0 8px;
      animation: fadeUp .6s .08s cubic-bezier(.16,1,.3,1) both;
    }
    .live-tag {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 14px; border-radius: 999px;
      background: rgba(255,255,255,.75); backdrop-filter: blur(8px);
      border: 1px solid rgba(16,185,129,.25);
      font-size: 12px; font-weight: 700; color: #047857;
      margin-bottom: 20px;
    }
    .live-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; animation: pulse 2s infinite; }
    .hero-title h2 {
      font-size: clamp(28px, 4.5vw, 42px);
      font-weight: 700; letter-spacing: -.03em; line-height: 1.12;
      margin: 0 0 14px;
    }
    .hero-title p {
      font-size: 16px; color: var(--muted); max-width: 580px; margin: 0 auto;
    }
    .hero-title p strong { color: var(--blue); font-weight: 700; }

    /* 统计栏 */
    .stats {
      display: grid; grid-template-columns: repeat(5, minmax(0,1fr));
      gap: 12px; padding: 28px 0 0;
      animation: fadeUp .6s .16s cubic-bezier(.16,1,.3,1) both;
    }
    .stat {
      background: rgba(255,255,255,.78); backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.85); border-radius: 14px;
      padding: 18px 16px; box-shadow: 0 4px 16px rgba(15,23,42,.04);
      transition: all .28s ease;
    }
    .stat:hover { transform: translateY(-4px); box-shadow: 0 12px 32px rgba(15,23,42,.08); }
    .stat span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .stat strong { display: block; font-size: 21px; overflow-wrap: anywhere; }

    /* ── 主体 ── */
    .main-body { position: relative; z-index: 1; margin-top: -12px; }

    /* 筛选面板 */
    .filter-panel {
      background: rgba(255,255,255,.82); backdrop-filter: blur(16px);
      border: 1px solid rgba(226,232,240,.6); border-radius: 16px;
      padding: 16px 18px; margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(15,23,42,.04);
      display: flex; flex-direction: column; gap: 12px;
      animation: fadeUp .5s .24s cubic-bezier(.16,1,.3,1) both;
    }
    .f-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .f-between { justify-content: space-between; }
    .f-label { font-size: 13px; font-weight: 700; color: var(--muted); min-width: 40px; }
    .f-divider { border: none; border-top: 1px solid rgba(226,232,240,.5); margin: 0; }

    /* Chip 和 Pill */
    .chip-group { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border: 1px solid var(--line); background: #fff; color: var(--text);
      border-radius: 999px; padding: 6px 13px; cursor: pointer;
      font-size: 13px;
      transition: all .18s ease;
    }
    .chip:hover { transform: translateY(-1px); border-color: #8ecaff; }
    .chip.active { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-hover); font-weight: 700; }

    .search-box { position: relative; flex: 1; max-width: 260px; min-width: 150px; }
    .search-box i { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--light); font-size: 15px; }
    .search-box input {
      width: 100%; padding: 7px 12px 7px 32px;
      border-radius: 10px; border: 1px solid var(--line);
      background: #fff; font-size: 13px; color: var(--text);
      outline: none; transition: all .2s;
    }
    .search-box input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.1); }

    .sel-wrap select {
      padding: 7px 11px; border-radius: 8px; border: 1px solid var(--line);
      background: #fff; font-size: 13px; color: var(--text);
      cursor: pointer; outline: none;
    }
    .f-meta { font-size: 13px; color: var(--light); }
    .f-meta strong { color: var(--accent); font-weight: 700; }

    /* 区域标题 */
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .toolbar h2 { font-size: 17px; display: flex; align-items: center; gap: 6px; margin: 0; }
    .toolbar h2 i { color: var(--blue); }
    .toolbar .meta { color: var(--muted); font-size: 13px; }

    /* 通知 */
    .notice {
      position: fixed; left: 50%; bottom: 28px; z-index: 999;
      transform: translate(-50%, 60px) scale(.95); opacity: 0;
      background: #0f172a; color: #fff; border-radius: 12px;
      padding: 12px 20px; font-weight: 700; font-size: 14px;
      box-shadow: 0 12px 40px rgba(15,23,42,.25);
      display: flex; align-items: center; gap: 8px;
      transition: all .35s cubic-bezier(.34,1.56,.64,1);
      pointer-events: none;
    }
    .notice.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .notice i { color: #38bdf8; font-size: 18px; }

    /* ── 卡片网格 ── */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; margin-bottom: 40px; }

    /* 卡片 - 保留原版排版骨架，加入毛玻璃特效 */
    .card {
      border: 1px solid rgba(226, 232, 240, 0.8);
      background: rgba(255, 255, 255, 0.65);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-radius: 14px;
      box-shadow: 0 4px 20px rgba(15,23,42,.04);
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
      overflow: hidden;
      animation: cardIn .45s cubic-bezier(.16,1,.3,1) backwards;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: #a8d8ff;
      box-shadow: 0 18px 42px rgba(22, 119, 210, .14);
    }
    .card.v6 {
      border-color: rgba(15,143,127,.32);
    }
    .card.v6:hover {
      border-color: rgba(15,143,127,.5);
      box-shadow: 0 18px 42px rgba(15,143,127,.12);
    }

    /* 卡片顶部色带 */
    .card-stripe { height: 3px; }
    .card.carrier-ct .card-stripe { background: linear-gradient(90deg, #2563eb, #60a5fa); }
    .card.carrier-cu .card-stripe { background: linear-gradient(90deg, #7c3aed, #a78bfa); }
    .card.carrier-cm .card-stripe { background: linear-gradient(90deg, #059669, #34d399); }

    .card-body { padding: 18px 20px 16px; }

    /* 卡片头 - 和原版一致的双栏 */
    .card-head {
      display: flex; justify-content: space-between;
      gap: 10px; align-items: flex-start;
      margin-bottom: 14px;
    }
    .card-title { min-width: 0; }
    .card-title h3 {
      margin: 0 0 8px; font-size: 19px;
      line-height: 1.25; overflow-wrap: anywhere;
    }
    .badge-row { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
    .badge {
      border: 1px solid rgba(56,189,248,.42);
      background: #eef7ff; color: #155a95;
      border-radius: 999px; padding: 3px 8px;
      font-size: 12px; white-space: nowrap;
    }
    .badge.strong { border-color: rgba(22,119,210,.34); background: #e8f3ff; color: #0f4f91; font-weight: 700; }
    .badge.good { border-color: rgba(15,143,127,.34); background: #e9fbf7; color: #0b7669; }
    .badge.ipv6 { border-color: rgba(15,143,127,.34); background: #e9fbf7; color: #0b7669; }
    .colo-badge {
      background: var(--panel-2); color: var(--muted);
      font-size: 12px;
      padding: 4px 10px; border-radius: 8px;
      border: 1px solid rgba(226,232,240,.6);
      white-space: nowrap; flex-shrink: 0;
    }

    /* 域名和 IP 行 - 原版网格布局 */
    .endpoint-body { display: grid; gap: 9px; margin-bottom: 2px; }
    .endpoint-row {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 10px; align-items: baseline;
    }
    .field-label {
      color: var(--muted); font-size: 12px; font-weight: 700;
    }
    .host, .ip {
      display: block;
      color: var(--accent);
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      min-width: 0; margin: 0; padding: 2px 4px;
      cursor: pointer; border-radius: 6px;
      transition: background .15s ease, color .15s ease;
    }
    .host:hover, .ip:hover { background: #e8f7f5; color: #0b7669; }
    .host { font-size: 16px; font-weight: 800; line-height: 1.35; }
    .ip   { font-size: 20px; font-weight: 900; line-height: 1.22; letter-spacing: 0; }
    .ip.v6 { font-size: 16px; line-height: 1.36; }
    .copy-hint {
      color: var(--light); font-size: 14px; cursor: pointer;
      transition: color .15s; align-self: center;
    }
    .copy-hint:hover { color: var(--accent); }

    /* 2×2 指标网格 - 和原版一致 */
    .metrics {
      display: grid; grid-template-columns: repeat(2, minmax(0,1fr));
      gap: 8px; margin-top: 12px;
    }
    .metric {
      background: rgba(255, 255, 255, .75);
      border: 1px solid rgba(216, 225, 236, .72);
      border-radius: 8px; padding: 10px; min-height: 66px;
    }
    .metric span {
      display: block; color: var(--muted);
      font-size: 12px; margin-bottom: 5px;
    }
    .metric strong {
      display: block; min-width: 0; font-size: 15px;
      overflow-wrap: anywhere;
    }

    /* 底行 */
    .sync-line {
      margin: 10px 0 0; color: var(--muted);
      font-size: 13px; line-height: 1.6;
    }

    /* ── 安装引导 ── */
    .setup-panel {
      background: linear-gradient(135deg, #ffffff 0%, #f0f7ff 50%, #f5f3ff 100%);
      border: 1px solid var(--line); border-radius: 18px;
      padding: 32px; margin-bottom: 40px;
      box-shadow: 0 4px 24px rgba(15,23,42,.04);
      position: relative; overflow: hidden;
    }
    .setup-panel::before {
      content:''; position: absolute; top: -50px; right: -50px;
      width: 200px; height: 200px; border-radius: 50%;
      background: radial-gradient(circle, rgba(99,102,241,.06), transparent);
      pointer-events: none;
    }
    .setup-panel h2 {
      font-size: 19px; margin-bottom: 8px;
      display: flex; align-items: center; gap: 8px; position: relative;
    }
    .setup-panel h2 i { color: var(--blue); }
    .setup-desc { color: var(--muted); font-size: 14px; margin-bottom: 18px; position: relative; }
    .codeblk {
      background: #0f172a; border-radius: 12px;
      padding: 16px 18px; position: relative; margin-bottom: 22px;
    }
    .codeblk pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      color: #7dd3fc; font-size: 13px; line-height: 1.6;
      overflow-x: auto; margin: 0;
    }
    .codeblk .cbtn {
      position: absolute; right: 12px; top: 12px;
      background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12);
      color: #94a3b8; padding: 5px 10px; border-radius: 8px;
      font-size: 12px; font-weight: 500; cursor: pointer;
      display: flex; align-items: center; gap: 5px; transition: all .15s;
    }
    .codeblk .cbtn:hover { background: rgba(255,255,255,.15); color: #fff; }

    .info-grid {
      display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
      gap: 14px; position: relative;
    }
    .info-block {
      background: rgba(255,255,255,.7); border-radius: 12px;
      padding: 16px; border: 1px solid rgba(226,232,240,.4);
    }
    .info-block h3 {
      font-size: 14px; margin-bottom: 6px;
      display: flex; align-items: center; gap: 6px;
    }
    .info-block h3 i { font-size: 16px; }
    .info-block p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }

    /* ── 页脚 ── */
    .footer {
      background: #fff; border-top: 1px solid var(--line);
      position: relative; overflow: hidden;
    }
    .ft-bar {
      height: 3px;
      background: linear-gradient(90deg, #2563eb, #7c3aed, #059669, #f59e0b, #2563eb);
      background-size: 200% 100%; animation: gradFlow 5s linear infinite;
    }
    .ft-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-size: 36px 36px;
      background-image:
        linear-gradient(rgba(226,232,240,.2) 1px, transparent 1px),
        linear-gradient(90deg, rgba(226,232,240,.2) 1px, transparent 1px);
      mask-image: radial-gradient(ellipse at 50% 0%, rgba(0,0,0,.08), transparent 55%);
    }
    .ft-main {
      position: relative; z-index: 1;
      max-width: 1240px; margin: 0 auto;
      padding: 48px 28px 24px;
      display: grid; grid-template-columns: 1.8fr 1fr 1fr 1fr; gap: 40px;
    }
    .ft-brand { display: flex; flex-direction: column; gap: 14px; }
    .ft-brand-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
    .ft-brand-icon {
      width: 34px; height: 34px; border-radius: 9px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 16px;
    }
    .ft-brand-name { font-size: 15px; font-weight: 700; margin: 0; }
    .ft-brand-desc { font-size: 13px; color: var(--muted); line-height: 1.7; max-width: 320px; }
    .ft-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .ft-pill {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; padding: 3px 9px;
      border-radius: 999px; background: var(--panel-2); color: var(--muted);
      border: 1px solid var(--line);
    }
    .ft-col h4 {
      font-size: 12px; color: var(--muted);
      text-transform: uppercase; letter-spacing: .05em;
      margin-bottom: 16px; margin-top: 0;
    }
    .ft-links { list-style: none; display: flex; flex-direction: column; gap: 10px; }
    .ft-links a {
      color: var(--muted); text-decoration: none; font-size: 13px;
      display: inline-flex; align-items: center; gap: 6px;
      transition: all .2s ease;
    }
    .ft-links a:hover { color: var(--blue); transform: translateX(4px); }
    .ft-links a i { font-size: 14px; opacity: .5; }
    .ft-bottom {
      position: relative; z-index: 1;
      max-width: 1240px; margin: 0 auto;
      padding: 18px 28px 32px;
      border-top: 1px solid rgba(226,232,240,.5);
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; color: var(--light);
    }
    .ft-bottom a { color: var(--muted); text-decoration: none; transition: color .15s; }
    .ft-bottom a:hover { color: var(--blue); }
    .ft-blinks { display: flex; gap: 18px; }

    .empty { border: 1px dashed var(--line); color: var(--muted); border-radius: 12px; padding: 48px; text-align: center; grid-column: 1/-1; }
    .error { color: #9f1239; border-color: rgba(244,63,94,.3); background: #fff1f2; }

    /* ── 响应式 ── */
    @media (max-width: 1024px) {
      .stats { grid-template-columns: repeat(3, 1fr); }
      .info-grid { grid-template-columns: repeat(2, 1fr); }
      .ft-main { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .grid  { grid-template-columns: 1fr; }
      .info-grid { grid-template-columns: 1fr; }
      .ft-main { grid-template-columns: 1fr; }
      header { flex-direction: column; }
      .actions { justify-content: flex-start; }
      .hero-title { text-align: left; }
      .f-row { flex-direction: column; align-items: stretch; }
      .search-box { max-width: 100%; }
      .setup-panel { padding: 22px; }
    }
    @media (max-width: 480px) {
      .stats { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
      .ft-bottom { flex-direction: column; gap: 10px; text-align: center; }
    }
  </style>
</head>
<body>

<!-- Hero -->
<section class="hero">
  <div class="hero-grid"></div>
  <div class="hero-content wrap">
    <header>
      <a href="#" class="brand">
        <div class="brand-icon"><i class="ri-flashlight-fill"></i></div>
        <div>
          <h1>Cloudflare 优选 IP 公开众测面板</h1>
          <p class="sub">OpenWrt 客户端自动测速、检测直连状态、上传结果；面板按省份和运营商聚合最佳 IP。</p>
        </div>
      </a>
      <div class="actions">
        <a href="https://github.com/10000ge10000/cf-ip-speed-panel" target="_blank" class="btn"><i class="ri-github-fill"></i> GitHub</a>
        <button class="btn primary" id="refreshBtn" onclick="loadLatest()"><i class="ri-refresh-line"></i> 刷新数据</button>
      </div>
    </header>

    <div class="hero-title">
      <div class="live-tag"><span class="live-dot"></span> 自动聚合运行中 · 每 30 分钟同步</div>
      <h2>全国各省 Cloudflare 优选 IP<br>实时众测聚合看板</h2>
      <p>每条推荐都来自 <strong>OpenWrt 真实直连测速</strong>，疑似代理数据不参与 DNS 优选。</p>
    </div>

    <section class="stats" id="stats"></section>
  </div>
</section>

<main class="main-body wrap">
  <div id="notice" class="notice"><i class="ri-checkbox-circle-fill"></i><span id="noticeMsg"></span></div>

  <!-- 筛选 -->
  <div class="filter-panel">
    <div class="f-row f-between">
      <div class="f-row" style="gap:8px">
        <span class="f-label">运营商</span>
        <div class="chip-group" id="carrierChips">
          <button class="chip active" data-carrier="">全部</button>
          <button class="chip" data-carrier="ct">中国电信</button>
          <button class="chip" data-carrier="cm">中国移动</button>
          <button class="chip" data-carrier="cu">中国联通</button>
        </div>
      </div>
      <div class="search-box">
        <i class="ri-search-line"></i>
        <input type="text" id="searchInput" placeholder="搜索省份、域名、IP..." oninput="renderAggregates()">
      </div>
    </div>
    <hr class="f-divider">
    <div class="f-row f-between">
      <div class="f-row" style="gap:8px">
        <span class="f-label">类型</span>
        <div class="chip-group" id="ipVersionChips">
          <button class="chip active" data-ip-version="">全部</button>
          <button class="chip" data-ip-version="v4">IPv4</button>
          <button class="chip" data-ip-version="v6">IPv6</button>
        </div>
        <span class="f-label" style="margin-left:8px">排序</span>
        <div class="sel-wrap">
          <select id="sortSelect" onchange="renderAggregates()">
            <option value="province">省份排序</option>
            <option value="speed">按速度降序</option>
            <option value="latency">按延迟升序</option>
          </select>
        </div>
      </div>
      <span class="f-meta" id="resultCount"></span>
    </div>
    <hr class="f-divider">
    <div class="f-row">
      <span class="f-label">省份</span>
      <div class="chip-group" id="provinceChips">
        <button class="chip active" data-province="">全部</button>
      </div>
    </div>
    <span class="f-meta" id="updatedAt">等待加载</span>
  </div>

  <!-- 节点列表 -->
  <div class="toolbar">
    <h2><i class="ri-sparkling-2-fill"></i> 各省优选 IP 列表</h2>
  </div>
  <section id="aggregates" class="grid"></section>

  <!-- 安装 -->
  <section class="setup-panel" id="install">
    <h2><i class="ri-terminal-box-fill"></i> OpenWrt 客户端部署</h2>
    <p class="setup-desc">在路由器 SSH 终端运行以下命令，一键安装 CloudflareSpeedTest 与 LuCI 管理插件。</p>
    <div class="codeblk">
      <button class="cbtn" onclick="copyText('sh -c &quot;$(wget -O- https://raw.githubusercontent.com/10000ge10000/cf-ip-speed-panel/main/scripts/install-openwrt.sh)&quot;','安装命令')"><i class="ri-file-copy-line"></i> 复制</button>
      <pre>sh -c "$(wget -O- https://raw.githubusercontent.com/10000ge10000/cf-ip-speed-panel/main/scripts/install-openwrt.sh)"</pre>
    </div>
    <div class="info-grid">
      <div class="info-block">
        <h3><i class="ri-information-line" style="color:var(--blue)"></i> 这是什么</h3>
        <p>公开众测 Cloudflare 优选 IP。每条推荐都来自 OpenWrt 客户端的真实直连测速。</p>
      </div>
      <div class="info-block">
        <h3><i class="ri-shield-check-line" style="color:var(--green)"></i> 防代理污染</h3>
        <p>测速前自动暂停 Passwall / OpenClash 等代理服务，完成后自动恢复，保证数据真实。</p>
      </div>
      <div class="info-block">
        <h3><i class="ri-route-line" style="color:var(--purple)"></i> IPv6 智能校准</h3>
        <p>结合同设备 IPv4 出口信息，自动修正 IPv6 省份与运营商归属识别精度。</p>
      </div>
      <div class="info-block">
        <h3><i class="ri-time-line" style="color:#d97706"></i> 闲时定时测速</h3>
        <p>支持 cron 定时任务，建议凌晨 3~5 点运行，对正常上网零干扰。</p>
      </div>
    </div>
  </section>
</main>

<!-- 页脚 -->
<footer class="footer">
  <div class="ft-bar"></div>
  <div class="ft-grid"></div>
  <div class="ft-main">
    <div class="ft-brand">
      <a href="#" class="ft-brand-logo">
        <div class="ft-brand-icon"><i class="ri-flashlight-fill"></i></div>
        <span class="ft-brand-name">Cloudflare IP 优选助手</span>
      </a>
      <p class="ft-brand-desc">面向 OpenWrt 的 Cloudflare 优选 IP 公开众测平台。每条推荐都来自真实直连测速，疑似代理数据不参与 DNS 优选。</p>
      <div class="ft-pills">
        <span class="ft-pill"><i class="ri-cloud-line"></i> Workers</span>
        <span class="ft-pill"><i class="ri-database-2-line"></i> D1</span>
        <span class="ft-pill"><i class="ri-hard-drive-2-line"></i> KV</span>
        <span class="ft-pill"><i class="ri-cpu-line"></i> OpenWrt</span>
      </div>
    </div>
    <div class="ft-col">
      <h4>快捷域名</h4>
      <ul class="ft-links">
        <li><a href="#"><i class="ri-links-line"></i> gd.cm.6610000.xyz</a></li>
        <li><a href="#"><i class="ri-links-line"></i> sh.ct.6610000.xyz</a></li>
        <li><a href="#"><i class="ri-links-line"></i> bj.cu.6610000.xyz</a></li>
        <li><a href="#"><i class="ri-links-line"></i> zj.ct.v6.6610000.xyz</a></li>
      </ul>
    </div>
    <div class="ft-col">
      <h4>开发者</h4>
      <ul class="ft-links">
        <li><a href="/api/public/latest" target="_blank"><i class="ri-code-s-slash-line"></i> 公开 API</a></li>
        <li><a href="https://github.com/10000ge10000/cf-ip-speed-panel" target="_blank"><i class="ri-github-line"></i> 源码仓库</a></li>
        <li><a href="https://github.com/10000ge10000/cf-ip-speed-panel/releases" target="_blank"><i class="ri-download-2-line"></i> 插件下载</a></li>
        <li><a href="https://cf.6610000.xyz" target="_blank"><i class="ri-earth-line"></i> 项目主页</a></li>
      </ul>
    </div>
    <div class="ft-col">
      <h4>安全合规</h4>
      <ul class="ft-links">
        <li><a href="#"><i class="ri-shield-user-line"></i> 代理出口自动过滤</a></li>
        <li><a href="#"><i class="ri-lock-line"></i> Token SHA-256 哈希</a></li>
        <li><a href="#"><i class="ri-timer-line"></i> 30 分钟定时聚合</a></li>
        <li><a href="#"><i class="ri-heart-pulse-line"></i> 系统正常运行</a></li>
      </ul>
    </div>
  </div>
  <div class="ft-bottom">
    <div>© 2026 Cloudflare IP 优选助手 · <a href="https://github.com/10000ge10000/cf-ip-speed-panel/blob/main/LICENSE" target="_blank">MIT License</a></div>
    <div class="ft-blinks">
      <a href="https://cf.6610000.xyz">项目主页</a>
      <a href="https://github.com/10000ge10000/cf-ip-speed-panel">GitHub</a>
    </div>
  </div>
</footer>

<script>
  const carrierLabels = { ct:'中国电信', cm:'中国移动', cu:'中国联通', other:'其他' };
  const coloLabels = {
    HKG:'香港', NRT:'东京', KIX:'大阪', ICN:'首尔', SIN:'新加坡', TPE:'台北',
    SJC:'圣何塞', LAX:'洛杉矶', SEA:'西雅图', FRA:'法兰克福', LHR:'伦敦',
    CDG:'巴黎', AMS:'阿姆斯特丹', DFW:'达拉斯', IAD:'华盛顿', ORD:'芝加哥'
  };


  let latestAggregates = [];
  let selectedCarrier = '';
  let selectedIpVersion = '';
  let selectedProvince = '';

  const aggregatesEl = document.getElementById('aggregates');
  const statsEl = document.getElementById('stats');
  const noticeEl = document.getElementById('notice');
  const updatedAtEl = document.getElementById('updatedAt');

  /* 筛选事件绑定 */
  function bindChipGroup(containerId, dataAttr, onSelect) {
    const container = document.getElementById(containerId);
    container.addEventListener('click', (e) => {
      const chip = e.target.closest(\`[data-\${dataAttr}]\`);
      if (!chip) return;
      container.querySelectorAll(\`[data-\${dataAttr}]\`).forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      onSelect(chip.getAttribute(\`data-\${dataAttr}\`) || '');
    });
  }
  bindChipGroup('carrierChips', 'carrier', v => { selectedCarrier = v; renderAggregates(); });
  bindChipGroup('ipVersionChips', 'ip-version', v => { selectedIpVersion = v; renderAggregates(); });

  loadLatest();

  async function loadLatest() {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 1s linear infinite"></i> 加载中';

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
      return;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ri-refresh-line"></i> 刷新数据';
    }

    latestAggregates = data.aggregates || [];
    renderStats(data);
    renderProvinceChips();
    renderAggregates();
    updatedAtEl.textContent = data.updated_at ? '最后聚合：' + formatBeijingTime(data.updated_at) : '暂无聚合数据';

  }

  function renderStats(data) {
    const provinces = new Set(latestAggregates.map(i => i.province_code));
    const users = new Set(latestAggregates.map(i => i.nickname));
    const ipv6Total = latestAggregates.filter(i => i.ip_version === 'v6').length;
    const bestSpeed = latestAggregates.reduce((m, i) => Math.max(m, Number(i.speed) || 0), 0);
    const items = [
      ['聚合记录', data.total || latestAggregates.length],
      ['覆盖省份', provinces.size],
      ['贡献用户', users.size],
      ['IPv6 记录', ipv6Total],
      ['最快速度', formatNumber(bestSpeed) + ' MB/s']
    ];
    statsEl.innerHTML = items.map(([l, v]) => '<div class="stat"><span>' + l + '</span><strong>' + v + '</strong></div>').join('');
  }

  function renderProvinceChips() {
    const container = document.getElementById('provinceChips');
    const provinces = [...new Map(latestAggregates.map(i => [i.province_code, i.province_name])).entries()]
      .filter(([c]) => c)
      .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));

    container.innerHTML = '<button class="chip active" data-province="">全部</button>'
      + provinces.map(([c, n]) => '<button class="chip" data-province="' + escapeAttr(c) + '">' + escapeHtml(n) + '</button>').join('');

    if (selectedProvince && !provinces.some(([c]) => c === selectedProvince)) selectedProvince = '';

    container.addEventListener('click', e => {
      const chip = e.target.closest('[data-province]');
      if (!chip) return;
      selectedProvince = chip.getAttribute('data-province') || '';
      container.querySelectorAll('[data-province]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderAggregates();
    });
  }

  function renderAggregates() {
    const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
    const sort = document.getElementById('sortSelect').value;

    let items = latestAggregates.filter(i => {
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
    aggregatesEl.querySelectorAll('[data-copy]').forEach(node => {
      node.addEventListener('click', () => copyText(node.dataset.copy, node.dataset.copyLabel));
    });
  }

  function renderAggregateCard(item, idx) {
    const isV6 = item.ip_version === 'v6';
    const typeLabel = isV6 ? 'IPv6 · AAAA' : 'IPv4 · ' + (item.record_type || 'A');
    const province = item.province_name || '未知省份';
    const carrier = carrierLabels[item.carrier] || item.carrier_label || item.carrier || '其他';
    const carrierKey = item.carrier || 'ct';
    const colo = formatColo(item.colo);
    const delay = Math.min(idx * 40, 400);

    return '<article class="card ' + (isV6 ? 'v6 ' : '') + 'carrier-' + carrierKey + '" style="animation-delay:' + delay + 'ms">'
      + '<div class="card-stripe"></div>'
      + '<div class="card-body">'
      // 头部
      + '<div class="card-head">'
      +   '<div class="card-title">'
      +     '<h3>' + escapeHtml(province) + ' · ' + escapeHtml(carrier) + '</h3>'
      +     '<div class="badge-row">'
      +       '<span class="badge strong ' + (isV6 ? 'ipv6' : '') + '">' + escapeHtml(typeLabel) + '</span>'
      +       '<span class="badge good">可信直连</span>'
      +     '</div>'
      +   '</div>'
      +   '<span class="colo-badge">' + escapeHtml(colo) + '</span>'
      + '</div>'
      // 域名/IP - 原版网格布局
      + '<div class="endpoint-body">'
      +   '<div class="endpoint-row">'
      +     '<span class="field-label">域名</span>'
      +     '<code class="host" data-copy="' + escapeAttr(item.hostname) + '" data-copy-label="' + escapeAttr(typeLabel + ' 域名') + '" title="点击复制域名">' + escapeHtml(item.hostname) + '</code>'
      +     '<i class="ri-file-copy-line copy-hint" data-copy="' + escapeAttr(item.hostname) + '" data-copy-label="域名" title="复制域名"></i>'
      +   '</div>'
      +   '<div class="endpoint-row">'
      +     '<span class="field-label">IP</span>'
      +     '<code class="ip ' + (isV6 ? 'v6' : '') + '" data-copy="' + escapeAttr(item.ip) + '" data-copy-label="' + escapeAttr(typeLabel + ' IP') + '" title="点击复制 IP">' + escapeHtml(item.ip) + '</code>'
      +     '<i class="ri-file-copy-line copy-hint" data-copy="' + escapeAttr(item.ip) + '" data-copy-label="IP" title="复制 IP"></i>'
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
      + '<p class="sync-line"><i class="ri-time-line"></i> 最后同步：' + escapeHtml(formatRelativeTime(item.updated_at)) + ' · 北京时间 ' + escapeHtml(formatBeijingTime(item.updated_at)) + '</p>'
      + '</div></article>';
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
    } catch { showNotice('复制失败，请手动选择文本复制'); }
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
    return n.toFixed(2).replace(/\\.00$/, '').replace(/(\\.\\d)0$/, '$1');
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(v) { return escapeHtml(v).replace(/\\n/g, '&#10;'); }
</script>
</body>
</html>
`;
}

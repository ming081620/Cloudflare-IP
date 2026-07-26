# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本号的唯一来源是 `package.json`，由 `npm run sync-version` 传播到 OpenWrt Makefile、
安装脚本与发布工作流。发布用 `npm version <patch|minor|major>` 一条命令完成 bump、同步与打标签。

## [Unreleased]

### ⚠️ 发布前必读

- **必须重新发布一次 Release。** `PKG_VERSION` 已由 `sync-version` 对齐到 `0.1.5`，
  而已发布的 `v0.1.5` 资源文件名仍是 `0.1.0-2` / `0.1.0-r2`。在重新构建并发布匹配的资源之前，
  安装脚本会 404。临时绕过：`PKG_VERSION=0.1.0 sh install-openwrt.sh`。
- **静态资源迁移改变了 `/` 的服务方式。** 部署后请确认
  `curl -I https://<域名>/` 返回资源服务器的响应（带 CSP 头），且 `/api/public/latest` 仍然可用。
  若 `run_worker_first` 未生效，API 会 404。
- **`TRUST_ENFORCE` 保持 `shadow`。** 切换到 `enforce` 前先读
  `GET /api/admin/trust-report?hours=336`，重点关注 `geo_source='client_narrow'` 且
  `ip_version='v6'` 的桶。

### 安全

- **修复匿名 DNS 劫持链。** 此前任何人无需凭据即可让 `<省>.<运营商>.<根域>` 指向任意 IP：
  上传接口自动注册、请求体可覆盖 Cloudflare 真实归属地、`speed` 无上限、且全程不校验
  IP 是否属于 Cloudflare。现新增三层独立防御：Cloudflare 地址段白名单、
  仅由 `request.cf` 决定且不可被请求体推翻的服务端判定、以及节点合理性上限。
- 新增多设备互证：DNS 记录需要 ≥2 个**独立网络前缀**的设备佐证（R1），
  或一个注册满 7 天、有稳定记录的独苗贡献者（R2），或管理员 pin（R3）。
  未达标的聚合仍在面板显示为「候选」，但不写入 DNS。
- DNS churn 抑制：替换在位记录需比其快 20% 且在位者已存在 ≥2 小时。
- 修复 `detectCarrier` 的子串匹配——`Connectivity`、`Octopus`、`ACTCORP`、`Direct Connect`
  等 AS 组织名此前全部被判为中国电信并因此通过信任闸门。
- 修复 `detectProvince` 的子串匹配——`Xianning`、`Xiantao`(湖北) 此前被判为陕西。
- 上传与注册接入限流，并新增按 /24 前缀的日配额(60 秒窗口挡不住持续刷设备)。
- 真实 `cf-connecting-ip` 不再被客户端声称的 `egress_ip` 覆盖，恢复封禁所需的唯一可靠标识。
- `/__speedtest` 单次上限 512 MB → 128 MB，移除 `access-control-allow-origin: *`
  (第三方网页可借访客浏览器烧出网流量),并按 `sec-fetch-site` 拦截盗链。
- 安装脚本移除 `wget --no-check-certificate`，新增 SHA256SUMS 校验(缺失时告警而非失败)。
- 客户端不再把含明文 `device_token` 的上传载荷留在 `/tmp` 直到重启。

### 修复

- **DNS 同步限流风暴(2026-07-08 起零成功)。** 每次上传触发全量对账、每个 hostname 单独 LIST，
  而 30 分钟节流以 `status='success'` 为准——一旦全失败节流永不生效，形成自持风暴
  (178,197 条 `list_failed`)。现改为整 zone 单次 LIST、10429 熔断退避、节流以「尝试」为准，
  且 DNS 对账仅由 cron 执行。
- 聚合查询的五个缺陷:缺失时间过滤导致全表扫描;时间戳相等 join 产生重复行;
  `LIMIT 1000` 作用于全局导致慢省份整个消失;`DELETE` 与插入非原子导致空结果清空表;
  查询自身缺 `proxy_suspected` 过滤。
- 重建改为代次戳原子 upsert,并新增「绝不写空」保护。
- cron 从 `ctx.waitUntil` 改为 `await`——此前重建抛错时调度仍报告成功。
- `GET /api/admin/uploads?limit=abc` 不再 500(`NaN` 被绑进 SQL `LIMIT`)。
- 面板省份筛选的监听器泄漏:刷新 N 次后单击一次会触发 N 次渲染。
- LuCI 不再把任何 `ok` 状态显示为「上传成功」——清空日志、更新定时任务、自用模式此前都会谎报;
  现改为显示客户端真实写入的 `last_message`。
- 客户端的 register/upload 加上 `--max-time` 与 `--retry`(此前无超时无重试,一次瞬时故障即丢弃整轮测速)。
- 安装脚本支持 `mipsel_24kc`(MT7621,消费级路由器占比极大,此前直接硬失败);
  架构未匹配时不再失败,因为两个包都是 `PKGARCH:=all`。
- 安装脚本新增 `trap` 清理临时目录。

### 性能

- DNS 对账移出上传路径:单次上传从约 180 次出站请求 + 90 余次 D1 查询降到 4 次操作。
- 重建防抖租约:实测 5 次并发上传只触发 2 次重建。
- 新增数据保留任务:`node_results` 72 小时、`uploads` 30 天、`dns_updates` 7 天,
  响应体 24 小时后置空。此前三张表从不清理,而 `dns_updates` 每次重建都要全表扫描。
- 停止在每次上传时清除静态 HTML 的缓存标签(页面是静态串,只在部署时变化)。
- JSON 响应不再美化输出(缩进约占最热接口响应体的 35–45%)。
- 补齐热路径索引。

### 新增

- `GET /api/health` 覆盖 D1、聚合陈旧度与配置状态,降级时返回 **503** 便于外部监控告警。
- `GET /api/admin/trust-report`、`GET /api/admin/dns-audit`、`POST|DELETE /api/admin/block-prefix`、
  `POST /api/admin/purge-cache`。
- `/api/public/latest` 新增 `root_domain` 与 `repo_url`,面板据此派生自身链接——
  分叉部署此前会让用户去安装上游的包。
- 客户端新增 `worker_url` UCI 选项,自部署无需再改脚本。
- 面板:自托管图标字体(jsdelivr 对目标用户经常不可达,失效时约 90 个图标会静默消失)、
  CSP 与安全响应头、无障碍属性、`prefers-reduced-motion`。

### 变更

- 公开面板从 Worker 内嵌模板字符串迁移到 Workers 静态资源(`public/`)。
  此前 `src/html.ts` 与未追踪的 `preview-ui/index.html` 是两份近乎相同的 900 行副本,
  转义规则相反,任一方向的复制都会静默损坏。
- 遗留 KV 接口(`/api/nodes`、`/api/raw`、`/api/history`、`/api/mappings`、`/api/upload`)
  标记弃用并加埋点日志,可用 `LEGACY_API_ENABLED=0` 关停。两周后确认无外部调用方即整体移除。
- 测试从源码文本匹配改为真实行为测试:vitest + Miniflare 支持的 D1,23 个测试,并接入 CI。
- 新增 oxlint 与 shellcheck(后者暂为非阻塞)。

## [0.1.5] - 2026-07

首个有 Release 记录的版本。OpenWrt 客户端、LuCI 插件、公开面板与 DNS 自动优选。

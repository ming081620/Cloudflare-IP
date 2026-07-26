# 参与开发

## 环境

```bash
npm ci
```

```bash
npm run d1:migrate:local
```

复制 `.dev.vars.example` 为 `.dev.vars` 并填入本地 token(该文件已被 gitignore)。

```bash
npm run dev
```

## 提交前

```bash
npm run check && npm run lint && npm test
```

CI 跑的就是这三条,外加 shell 语法检查与 LuCI 的纯 ASCII 检查。

### 已知的本地开发限制

`wrangler dev` 的 cron 触发端点 `curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled`
在启用 `assets` 绑定后会返回 **500**——wrangler 的 dev 中间件在 worker 路由之前就拦截了
`/cdn-cgi/`，把 `/cdn-cgi/*` 加进 `run_worker_first` 也没用。

这只影响本地：真实 cron 由 Cloudflare 运行时直接调用 `scheduled()`，不走 HTTP 路由。
已验证——临时移除 `assets` 后同一端点返回 200 并完整跑通全流程。

因此 **cron 路径由集成测试覆盖**（`test/integration/support.test.ts` 里
「runs the whole scheduled sequence」），本地要验证 cron 请跑测试而不是打这个端点。

## 测试

分两个 vitest project:

- `test/unit/` —— Node 环境,纯函数与结构性不变式。`npm run test:unit`
- `test/integration/` —— workerd + Miniflare 支持的真实 D1/KV。`npm run test:integration`

集成测试会自动应用 `migrations/` 下的全部迁移,所以迁移里的语法错误会直接让测试失败。

**新增行为请写行为测试,不要写源码文本匹配。** 本项目原先有 24 条
`assert.match(sourceText, /.../)` 断言,它们在每次无害重构时失败、却抓不到任何逻辑 bug,
已全部移除。少数保留的结构性断言(如「`ctx.waitUntil` 只允许出现在 `observability.ts`」)
检查的是分层约束,不是实现细节。

## 约定

**`ctx.waitUntil` 只能出现在 `src/observability.ts`。** 其他地方一律用 `backgroundTask()`
——裸 `waitUntil` 在响应返回后才 settle,顶层 try/catch 抓不到,失败会完全静默。

**`src/trust.ts` 与 `src/cf-ranges.ts` 保持纯函数。** 它们决定什么能操纵真实 DNS 记录,
必须能在没有基础设施的情况下穷举测试。

**迁移只增不改。** 已应用的迁移文件不能重写,否则已部署库与新建库的 schema 会不一致。
测试里有断言禁止 `DROP TABLE` / `DROP COLUMN`。

**LuCI 资源必须是纯 ASCII。** 中文用 `\uXXXX` 转义——这是 LuCI 的传输兼容要求,CI 会检查。

**图标是生成的。** 在页面里用了新的 `ri-*` 类之后跑 `npm run build:icons`;
CI 会检查生成结果是否最新。

## 发布

版本号的唯一来源是 `package.json`。

```bash
npm version minor
```

npm 会在 bump 之后、打 tag 之前自动运行 `scripts/sync-version.mjs`,
把版本传播到两个 OpenWrt Makefile 与安装脚本,所以一条命令就能产出一致且已打标签的发布。

`PKG_RELEASE` 是打包修订号,与产品版本无关,继续手工管理。

## 安全相关改动

改动 `src/trust.ts`、`src/cf-ranges.ts`、`src/dns.ts` 或聚合查询时,请一并说明:

- 攻击者能做什么(具体到一次 HTTP 请求)
- 哪一层拦住了它
- 对应的测试在哪

`scripts/poc-upload.sh` 是 DNS 劫持链的验收测试,对本地 `wrangler dev` 运行它应始终报
`PoC is inert.`。

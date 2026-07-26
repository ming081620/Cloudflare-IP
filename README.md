<h1 align="center">
  <img src="assets/logo.svg" alt="Cloudflare IP 优选助手 Logo" width="84" align="center">
  Cloudflare IP 优选助手
</h1>

<p align="center">
  面向 OpenWrt 的 Cloudflare 优选 IP 公开众测、自动测速、可信聚合和省份运营商 DNS 优选平台。
</p>

<p align="center">
  <a href="https://cf.6610000.xyz">项目页面</a> ·
  <a href="https://github.com/10000ge10000/cf-ip-speed-panel/releases/tag/v0.1.6">插件下载</a> ·
  <a href="https://github.com/10000ge10000/cf-ip-speed-panel">GitHub</a>
</p>

---

这是一个公开众测版 Cloudflare 优选 IP 项目。

OpenWrt 用户安装 LuCI 插件后，填写昵称并设置测速时间。插件会自动运行 `cfst`，上传测速结果。服务端会按省份和运营商聚合可信数据，并生成类似下面的域名：

```text
sx.cu.6610000.xyz
sh.ct.6610000.xyz
gd.cm.6610000.xyz
```

项目页面：[https://cf.6610000.xyz](https://cf.6610000.xyz)

## 功能

- OpenWrt / LuCI 插件自动测速并上传结果。
- 疑似代理出口的数据会保留贡献记录，但不参与 DNS 优选。
- 按省份和运营商聚合最佳 IP。
- 自动更新 `省份缩写.运营商.6610000.xyz` DNS。
- Web 页面展示 IP、速度、延迟、贡献者和最后同步时间。

## OpenWrt 安装

推荐一键安装：

```sh
sh -c "$(wget -O- https://raw.githubusercontent.com/10000ge10000/cf-ip-speed-panel/main/scripts/install-openwrt.sh)"
```

一键安装脚本会同时安装 `cfst` 测速程序。如果你是手动下载 IPK/APK 安装，请先确保系统里能执行 `cfst`。

如果系统没有 `wget`，可以使用：

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/10000ge10000/cf-ip-speed-panel/main/scripts/install-openwrt.sh)"
```

也可以到 Release 手动下载对应版本的两个包：

[https://github.com/10000ge10000/cf-ip-speed-panel/releases/tag/v0.1.6](https://github.com/10000ge10000/cf-ip-speed-panel/releases/tag/v0.1.6)

必须安装这两个包：

```text
cf-ip-speed-client
luci-app-cf-ip-speed-client
```

安装后进入 LuCI：

```text
服务 -> Cloudflare IP 优选助手
```

填写昵称，选择测速方式，然后启用即可。建议每天定时测速选择凌晨 3 点到 5 点，减少对正常上网的影响。

## 版本说明

- `.ipk`：适用于 OpenWrt 23 / 24 以及仍使用 `opkg` 的系统。
- `.apk`：适用于已经使用 `apk` 包管理器的新版本 OpenWrt / snapshot。
- 两个包都是 `PKGARCH:=all`（与架构无关），Release 文件名里的架构只是构建标签。
  安装脚本只在选择 `cfst` 二进制时才真正区分架构。

## 安全说明

- 插件不会保存 Cloudflare Token。
- OpenWrt 本机会保存 `device_id/device_token`，用于识别设备。
- 服务端只保存设备 token 的哈希，不保存明文 token。
- 疑似代理、云服务器出口、境外出口数据不会参与自动 DNS 优选。
- 归属地以 Cloudflare 观测到的数据为准，客户端上报只能降低信任，不能推翻服务端判定。
- 上传的 IP 必须落在 Cloudflare 公布的地址段内，写入 DNS 前会再校验一次。
- 一条 DNS 记录需要来自至少两个**独立网络**的佐证才会生效；未达标的结果在面板显示为「候选」。

详见 [SECURITY.md](SECURITY.md)。

## 自己部署一套

面板、聚合与 DNS 优选都跑在 Cloudflare Workers 上，可以部署你自己的实例：
**[docs/deploy.md](docs/deploy.md)**。

需要一个你自己控制并托管在 Cloudflare 的域名。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/deploy.md](docs/deploy.md) | 自部署完整步骤与运维 |
| [docs/api.md](docs/api.md) | 全部接口与数据结构 |
| [docs/architecture.md](docs/architecture.md) | 数据流、信任模型、互证规则 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、测试、发布流程 |
| [SECURITY.md](SECURITY.md) | 威胁模型与漏洞报告 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 开发

```bash
npm ci && npm run d1:migrate:local && npm run dev
```

```bash
npm run check && npm run lint && npm test
```

## License

[MIT](LICENSE)

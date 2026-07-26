#!/bin/sh

set -eu

REPO="10000ge10000/cf-ip-speed-panel"
# Kept in step with package.json by scripts/sync-version.mjs. PKG_RELEASE is the packaging
# revision and stays hand-managed; the filenames used to hardcode both, so any bump silently
# broke installs.
TAG="${TAG:-v0.1.6}"
PKG_VERSION="${PKG_VERSION:-0.1.6}"
PKG_RELEASE="${PKG_RELEASE:-2}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
CFST_REPO="XIU2/CloudflareSpeedTest"
CFST_TAG="${CFST_TAG:-v2.3.5}"
CFST_BASE_URL="https://github.com/${CFST_REPO}/releases/download/${CFST_TAG}"
TMP_DIR="/tmp/cf-ip-speed-install"
CLIENT_PKG="cf-ip-speed-client"
LUCI_PKG="luci-app-cf-ip-speed-client"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "[cf-ip-speed] $*"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

need_cmd() {
  has_cmd "$1" || fail "缺少命令：$1"
}

read_release_value() {
  key="$1"
  sed -n "s/^${key}='\\(.*\\)'/\\1/p" /etc/openwrt_release 2>/dev/null | head -n 1
}

detect_pkg_manager() {
  if has_cmd opkg; then
    echo "opkg"
    return
  fi
  if has_cmd apk; then
    echo "apk"
    return
  fi
  fail "未找到 opkg 或 apk 包管理器"
}

detect_version() {
  manager="$1"
  release="$(read_release_value DISTRIB_RELEASE)"
  case "$release" in
    23.*) echo "23.05.5" ;;
    24.*) echo "24.10.6" ;;
    # A bare year literal here would start misfiring in 2027, and matching someone's custom
    # build banner is not a version check.
    2[5-9].*) echo "24.10.6" ;;
    SNAPSHOT|snapshot|*SNAPSHOT*)
      if [ "$manager" = "apk" ]; then
        echo "snapshot"
      else
        echo "${OPENWRT_BUILD_VERSION:-24.10.6}"
      fi
      ;;
    *) echo "${OPENWRT_BUILD_VERSION:-24.10.6}" ;;
  esac
}

detect_arch_from_opkg() {
  opkg print-architecture 2>/dev/null | awk '
    $1 == "arch" && $2 != "all" && $2 != "noarch" {
      arch=$2
    }
    END {
      if (arch != "") print arch
    }
  '
}

detect_arch_from_apk() {
  apk --print-arch 2>/dev/null || true
}

# Both packages are built with PKGARCH:=all, so the architecture in a release filename is only
# the build-matrix label — any of them installs anywhere. An unmatched architecture therefore
# has no reason to be a hard failure; it used to reject mipsel_24kc (MT7621), which covers a
# large share of consumer routers.
FALLBACK_RELEASE_ARCH="x86_64"

normalize_arch() {
  arch="$1"
  case "$arch" in
    x86_64|aarch64_generic|aarch64_cortex-a53|aarch64_cortex-a72|arm_cortex-a7_neon-vfpv4|mips_24kc)
      echo "$arch"
      ;;
    aarch64|arm64)
      echo "${OPENWRT_ARCH:-aarch64_cortex-a53}"
      ;;
    armv7|armhf|arm_cortex-a9*|arm_cortex-a15*)
      echo "arm_cortex-a7_neon-vfpv4"
      ;;
    mips|mips_*)
      echo "mips_24kc"
      ;;
    *)
      info "架构 ${arch:-unknown} 无对应发布标签；软件包与架构无关，改用 ${FALLBACK_RELEASE_ARCH} 发布包。"
      echo "${OPENWRT_ARCH:-$FALLBACK_RELEASE_ARCH}"
      ;;
  esac
}

# Unlike the packages, cfst is a compiled Go binary — the architecture genuinely matters here,
# so this is resolved from the real machine architecture rather than the release label.
detect_cfst_asset() {
  arch="$1"
  case "$arch" in
    x86_64|amd64)
      echo "cfst_linux_amd64.tar.gz"
      ;;
    aarch64|arm64|aarch64_*)
      echo "cfst_linux_arm64.tar.gz"
      ;;
    armv7|armhf|arm_cortex-a7*|arm_cortex-a9*|arm_cortex-a15*)
      echo "cfst_linux_armv7.tar.gz"
      ;;
    # Little-endian MIPS is the common consumer-router target and was previously unhandled.
    mipsel|mipsel_*|mipsle)
      echo "cfst_linux_mipsle.tar.gz"
      ;;
    mips|mips_*)
      echo "cfst_linux_mips.tar.gz"
      ;;
    *)
      fail "当前架构暂未匹配到 cfst 二进制：${arch:-unknown}。可用的架构：amd64 / arm64 / armv7 / mips / mipsle。可手动安装 CloudflareSpeedTest 后重试。"
      ;;
  esac
}

# The machine architecture, not the release label — normalize_arch() deliberately coerces
# unknown values, which would send the wrong cfst binary.
raw_machine_arch() {
  arch="$(read_release_value DISTRIB_ARCH)"
  if [ -z "$arch" ] && has_cmd opkg; then
    arch="$(detect_arch_from_opkg)"
  fi
  if [ -z "$arch" ] && has_cmd apk; then
    arch="$(detect_arch_from_apk)"
  fi
  if [ -z "$arch" ] && has_cmd uname; then
    arch="$(uname -m 2>/dev/null || true)"
  fi
  echo "$arch"
}

detect_arch() {
  arch="$(read_release_value DISTRIB_ARCH)"
  if [ -z "$arch" ] && has_cmd opkg; then
    arch="$(detect_arch_from_opkg)"
  fi
  if [ -z "$arch" ] && has_cmd apk; then
    arch="$(detect_arch_from_apk)"
  fi
  normalize_arch "$arch"
}

download() {
  url="$1"
  output="$2"
  if has_cmd curl; then
    curl -fL --connect-timeout 20 --retry 2 --retry-delay 2 -o "$output" "$url"
  elif has_cmd wget; then
    # TLS verification stays on. This used to pass --no-check-certificate, which combined with
    # unsigned packages meant a MITM could deliver an arbitrary root-executed binary — on the
    # command the README recommends. If the image lacks CA certificates the fix is
    # `opkg install ca-bundle`, which the client package already depends on.
    wget --timeout=20 --tries=3 -O "$output" "$url"
  else
    fail "缺少下载工具：需要 curl 或 wget"
  fi
}

# Best-effort integrity check. Warns rather than fails when the checksum list or sha256sum is
# unavailable, so a minimal image is not bricked by a missing coreutils applet.
verify_checksum() {
  file="$1"
  expected_name="$2"

  if [ ! -f "$TMP_DIR/SHA256SUMS" ]; then
    return 0
  fi
  if ! has_cmd sha256sum; then
    info "未找到 sha256sum，跳过校验"
    return 0
  fi

  expected="$(awk -v n="$expected_name" '$2 == n || $2 == "*" n { print $1 }' "$TMP_DIR/SHA256SUMS" | head -n 1)"
  if [ -z "$expected" ]; then
    info "SHA256SUMS 中没有 ${expected_name} 的记录，跳过校验"
    return 0
  fi

  actual="$(sha256sum "$file" | awk '{ print $1 }')"
  [ "$actual" = "$expected" ] || fail "校验和不匹配：${expected_name}（期望 ${expected}，实际 ${actual}）"
  info "校验通过：${expected_name}"
}

build_package_names() {
  manager="$1"
  version="$2"
  arch="$3"

  if [ "$manager" = "apk" ]; then
    version="snapshot"
    client_file="snapshot-all-${CLIENT_PKG}-${PKG_VERSION}-r${PKG_RELEASE}.apk"
    luci_file="snapshot-all-${LUCI_PKG}-${PKG_VERSION}-r${PKG_RELEASE}.apk"
    package_ext="apk"
    return
  fi

  case "$version" in
    23.05.5) package_release="-${PKG_RELEASE}" ;;
    24.10.6) package_release="-r${PKG_RELEASE}" ;;
    *) fail "当前版本暂未发布 Release 包：$version。可设置 OPENWRT_BUILD_VERSION=23.05.5 或 24.10.6 后重试。" ;;
  esac

  release_part="${arch}-${version}"
  client_file="${release_part}-${CLIENT_PKG}_${PKG_VERSION}${package_release}_${arch}.ipk"
  luci_file="${release_part}-${LUCI_PKG}_${PKG_VERSION}${package_release}_${arch}.ipk"
  package_ext="ipk"
}

install_packages() {
  manager="$1"
  if [ "$manager" = "apk" ] || [ "$package_ext" = "apk" ]; then
    need_cmd apk
    apk add --allow-untrusted "./${CLIENT_PKG}.apk" "./${LUCI_PKG}.apk"
    return
  fi

  need_cmd opkg
  opkg install --force-reinstall "./${CLIENT_PKG}.ipk" "./${LUCI_PKG}.ipk"
}

install_cfst() {
  if has_cmd cfst && [ "${CFST_FORCE_INSTALL:-0}" != "1" ]; then
    info "已检测到 cfst：$(command -v cfst)，跳过安装"
    return
  fi

  need_cmd tar
  # $machine_arch, not $arch: the latter is a release label that normalize_arch may have
  # coerced, and a coerced value would fetch a binary for the wrong CPU.
  cfst_asset="$(detect_cfst_asset "${machine_arch:-$arch}")"
  cfst_archive="cfst.tar.gz"
  cfst_unpack="${TMP_DIR}/cfst-unpack"

  info "安装 cfst：${CFST_TAG} / ${cfst_asset}"
  rm -rf "$cfst_unpack"
  mkdir -p "$cfst_unpack"
  download "${CFST_BASE_URL}/${cfst_asset}" "$cfst_archive"
  tar -xzf "$cfst_archive" -C "$cfst_unpack"

  cfst_bin=""
  if [ -f "$cfst_unpack/cfst" ]; then
    cfst_bin="$cfst_unpack/cfst"
  else
    cfst_bin="$(find "$cfst_unpack" -type f -name cfst 2>/dev/null | head -n 1)"
  fi
  [ -n "$cfst_bin" ] || fail "cfst 压缩包中未找到 cfst 二进制文件"

  chmod 755 "$cfst_bin"
  cp "$cfst_bin" /usr/bin/cfst
  chmod 755 /usr/bin/cfst
  command -v cfst >/dev/null 2>&1 || fail "cfst 已复制但无法在 PATH 中找到"
  info "cfst 安装完成：$(command -v cfst)"
}

reload_services() {
  /usr/bin/cf-ip-speed-client cron || true
  rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
  /etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1 || true
  /etc/init.d/uhttpd reload >/dev/null 2>&1 || /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
}

need_cmd sed
need_cmd awk

# The old script left $TMP_DIR, the cfst archive and its unpack directory behind on every run,
# success or failure.
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

manager="$(detect_pkg_manager)"
version="$(detect_version "$manager")"
arch="$(detect_arch)"
machine_arch="$(raw_machine_arch)"
build_package_names "$manager" "$version" "$arch"

info "OpenWrt 版本：$version"
info "系统架构：${machine_arch:-unknown}（发布标签：$arch）"
info "包管理器：$manager"
info "Release：$TAG"
info "客户端包：$client_file"
info "LuCI 包：$luci_file"

mkdir -p "$TMP_DIR"
cd "$TMP_DIR"
rm -f "${CLIENT_PKG}.ipk" "${LUCI_PKG}.ipk" "${CLIENT_PKG}.apk" "${LUCI_PKG}.apk"

# Optional: absent on older releases, in which case verify_checksum simply skips.
download "${BASE_URL}/SHA256SUMS" "$TMP_DIR/SHA256SUMS" 2>/dev/null || rm -f "$TMP_DIR/SHA256SUMS"

download "${BASE_URL}/${client_file}" "${CLIENT_PKG}.${package_ext}"
verify_checksum "${CLIENT_PKG}.${package_ext}" "$client_file"
download "${BASE_URL}/${luci_file}" "${LUCI_PKG}.${package_ext}"
verify_checksum "${LUCI_PKG}.${package_ext}" "$luci_file"
install_cfst

cp /etc/config/cf_ip_speed_client /tmp/cf_ip_speed_client.backup 2>/dev/null || true
install_packages "$manager"
reload_services

info "安装完成。请进入 LuCI：服务 -> Cloudflare IP 优选助手"
info "如果页面仍是旧内容，请清理浏览器缓存或强制刷新。"

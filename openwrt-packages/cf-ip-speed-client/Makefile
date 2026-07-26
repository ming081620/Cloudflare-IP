include $(TOPDIR)/rules.mk

PKG_NAME:=cf-ip-speed-client
PKG_VERSION:=0.1.6
PKG_RELEASE:=2
PKGARCH:=all
PKG_LICENSE:=MIT
PKG_MAINTAINER:=10000ge10000 <10000ge10000@users.noreply.github.com>

include $(INCLUDE_DIR)/package.mk

define Package/cf-ip-speed-client
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Cloudflare preferred IP public test client
  DEPENDS:=+curl +ca-bundle +ip-full +jsonfilter
endef

define Package/cf-ip-speed-client/description
  OpenWrt client for cf-ip-speed-panel. It runs cfst, checks whether traffic
  is likely direct, and uploads speed test results to a Worker endpoint.
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/cf-ip-speed-client/conffiles
/etc/config/cf_ip_speed_client
/etc/cf-ip-speed-client/ip.txt
/etc/cf-ip-speed-client/ip-v6.txt
endef

define Package/cf-ip-speed-client/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/cf_ip_speed_client $(1)/etc/config/cf_ip_speed_client
	$(INSTALL_DIR) $(1)/etc/cf-ip-speed-client
	$(INSTALL_DATA) ./files/etc/cf-ip-speed-client/ip.txt $(1)/etc/cf-ip-speed-client/ip.txt
	$(INSTALL_DATA) ./files/etc/cf-ip-speed-client/ip-v6.txt $(1)/etc/cf-ip-speed-client/ip-v6.txt
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/cf-ip-speed-client $(1)/etc/init.d/cf-ip-speed-client
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/cf-ip-speed-client $(1)/usr/bin/cf-ip-speed-client
endef

define Package/cf-ip-speed-client/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
uci -q get cf_ip_speed_client.main.log_clear_interval >/dev/null || uci set cf_ip_speed_client.main.log_clear_interval='weekly'
uci -q get cf_ip_speed_client.main.log_max_size >/dev/null || uci set cf_ip_speed_client.main.log_max_size='1048576'
uci -q get cf_ip_speed_client.main.upload_enabled >/dev/null || uci set cf_ip_speed_client.main.upload_enabled='1'
uci -q get cf_ip_speed_client.main.ip_mode >/dev/null || uci set cf_ip_speed_client.main.ip_mode='v4'
uci commit cf_ip_speed_client
exit 0
endef

$(eval $(call BuildPackage,cf-ip-speed-client))

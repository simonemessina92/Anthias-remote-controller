#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
APP=/opt/anthias-rooms
ETC=/etc/anthias-rooms
DATA=/var/lib/anthias-rooms
PACKAGES=/var/lib/anthias-rooms-packages.json
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
heading(){ printf '\n============================================================\n  %s\n============================================================\n' "$1"; }
step(){ printf '\n  [%s] %s\n' "$1" "$2"; }
fail(){ echo "ERROR: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run with sudo bash install.sh'
install_app(){
  [[ -f "$ETC/install-complete" ]] && { echo 'Already installed. Configuration is preserved; this installer does not overwrite an existing instance.'; return; }
  [[ ! -e "$APP" && ! -e "$ETC" && ! -e "$DATA" ]] || fail 'Installation paths already exist; refusing to overwrite them.'
  [[ -f "$SCRIPT_DIR/server.py" && -f "$SCRIPT_DIR/nginx-config.py" && -f "$SCRIPT_DIR/web/panel.html" ]] || fail 'Extract the complete VPS package before running install.sh.'
  source /etc/os-release
  [[ ( "$ID" == debian && ( "$VERSION_ID" == 12 || "$VERSION_ID" == 13 ) ) || ( "$ID" == ubuntu && ( "$VERSION_ID" == 22.04 || "$VERSION_ID" == 24.04 ) ) ]] || fail 'Supported targets: Debian 12/13 or Ubuntu 22.04/24.04.'
  command -v ss >/dev/null && { [[ -z $(ss -H -ltn 'sport = :443') ]] || fail 'TCP 443 is already in use.'; [[ -z $(ss -H -lun 'sport = :443') ]] || fail 'UDP 443 is already in use.'; }
  # Existing UFW is kept enabled; only missing app-specific rules are added below.
  id anthias-rooms >/dev/null 2>&1 && fail 'User anthias-rooms already exists.'
  read -r -p 'Public VPS IPv4 address or DNS hostname: ' endpoint
  read -r -p 'WireGuard tunnel network [10.77.0.0/24]: ' tunnel
  tunnel=${tunnel:-10.77.0.0/24}
  heading "INSTALL ANTHIAS ROOMS VPS"
  step 1 "Install dependencies"
  python3 "$SCRIPT_DIR/package-ownership.py" recover "$PACKAGES"
  package_snapshot=$(mktemp /tmp/anthias-packages.XXXXXXXX)
  python3 "$SCRIPT_DIR/package-ownership.py" snapshot "$package_snapshot"
  apt-get update
  apt_status=0
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 wireguard-tools nginx openssl sudo nftables iproute2 ffmpeg || apt_status=$?
  python3 "$SCRIPT_DIR/package-ownership.py" record "$package_snapshot" "$PACKAGES"
  rm -f "$package_snapshot"
  [[ "$apt_status" == 0 ]] || fail 'Dependency installation failed; package receipt retained for Remove all.'
  python3 - "$endpoint" "$tunnel" <<'PY'
import ipaddress,re,sys
host=sys.argv[1]
assert re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?',host), 'Invalid endpoint'
try:
 a=ipaddress.ip_address(host); assert a.version==4 and not a.is_private and not a.is_loopback, 'Use the VPS public IPv4'
except ValueError: assert '.' in host and not host.replace('.','').isdigit(), 'Invalid hostname'
n=ipaddress.ip_network(sys.argv[2],strict=True)
assert n.version==4 and n.prefixlen==24 and any(n.subnet_of(ipaddress.ip_network(x)) for x in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']), 'Use a private /24'
PY

  [[ -z $(ss -H -ltn 'sport = :443') && -z $(ss -H -lun 'sport = :443') && -z $(ss -H -ltn 'sport = :8443') ]] || fail 'TCP 443/8443 or UDP 443 is occupied; installation stopped.'
  python3 - <<'PYPORTS'
import socket
for port in range(8444,8544):
 with socket.socket() as s:
  s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
  try:s.bind(('0.0.0.0',port))
  except OSError as e:raise SystemExit(f'ERROR: Cannot reserve TCP {port}: {e}')
PYPORTS
  step 2 "Create service and permissions"
  useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin anthias-rooms
  install -d -m 755 "$APP"
  install -d -m 750 -o root -g anthias-rooms "$ETC"
  touch "$ETC/owned-by-installer"
  install -d -m 700 -o anthias-rooms -g anthias-rooms "$DATA"
  install -d -m 700 /etc/wireguard
  cp "$SCRIPT_DIR/server.py" "$SCRIPT_DIR/wg-helper.py" "$SCRIPT_DIR/nginx-config.py" "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/package-ownership.py" "$APP/"
  cp -r "$SCRIPT_DIR/web" "$APP/web"
  chown -R root:anthias-rooms "$APP"
  find "$APP" -type d -exec chmod 750 {} +
  find "$APP" -type f -exec chmod 640 {} +
  # Explicit modes: umask 077 must not make source/static files unreadable to the service.
  python3 - "$ETC/settings.json" "$endpoint" "$tunnel" <<'PY'
import ipaddress,json,secrets,sys
from pathlib import Path
n=ipaddress.ip_network(sys.argv[3]);p=Path(sys.argv[1])
p.write_text(json.dumps({'endpoint':sys.argv[2],'tunnel':str(n),'serverAddress':f'{n.network_address+1}/24','routerAddress':f'{n.network_address+2}/32','bootstrap':secrets.token_urlsafe(24)}))
PY
  chown root:anthias-rooms "$ETC/settings.json"
  chmod 640 "$ETC/settings.json"
  touch "$ETC/owned-by-installer"
  if command -v ufw >/dev/null && ufw status | head -1 | grep -q 'Status: active'; then
    for rule in 80/tcp 443/tcp 8443/tcp 8444:8543/tcp 443/udp; do
      if ! ufw show added | grep -Fq "ufw allow $rule"; then
        ufw allow "$rule" comment AnthiasRooms
        echo "$rule" >> "$ETC/ufw-owned-rules"
      fi
    done
  fi
  printf 'anthias-rooms ALL=(root) NOPASSWD: /usr/bin/python3 -I /opt/anthias-rooms/wg-helper.py configure, /usr/bin/python3 -I /opt/anthias-rooms/wg-helper.py status, /usr/bin/python3 -I /opt/anthias-rooms/wg-helper.py profile\n' > /etc/sudoers.d/anthias-rooms
  chmod 440 /etc/sudoers.d/anthias-rooms
  visudo -cf /etc/sudoers.d/anthias-rooms
  cat > /etc/systemd/system/anthias-rooms.service <<'EOF'
[Unit]
Description=Anthias Rooms VPS
After=network-online.target wg-quick@arwg0.service
Wants=network-online.target
[Service]
Type=simple
User=anthias-rooms
Group=anthias-rooms
WorkingDirectory=/opt/anthias-rooms
ExecStart=/usr/bin/python3 /opt/anthias-rooms/server.py
Restart=on-failure
RestartSec=3
UMask=0077
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/anthias-rooms /etc/anthias-rooms /etc/wireguard
# The constrained sudo helper needs to update its dedicated WireGuard configuration.
[Install]
WantedBy=multi-user.target
EOF
  cat > "$ETC/firewall.nft" <<'EOF'
table inet anthias_rooms {
 chain input {
  type filter hook input priority 10; policy accept;
  iifname "arwg0" ct state established,related accept
  iifname "arwg0" ip protocol icmp icmp type echo-request accept
  iifname "arwg0" drop
 }
}
EOF
  cat > /etc/systemd/system/anthias-rooms-firewall.service <<'EOF'
[Unit]
Description=Anthias Rooms dedicated tunnel firewall
Before=wg-quick@arwg0.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/anthias-rooms/firewall.nft
ExecStop=/usr/sbin/nft delete table inet anthias_rooms
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  step 3 "Configure WireGuard tunnel"
  systemctl enable --now anthias-rooms-firewall
  python3 -I "$APP/wg-helper.py" init
  systemctl enable wg-quick@arwg0
  # Self-signed IP/DNS certificate makes immediate HTTPS testing possible.
  if [[ "$endpoint" =~ ^[0-9.]+$ ]]; then san="IP:$endpoint"; else san="DNS:$endpoint"; fi
  openssl req -x509 -newkey rsa:3072 -nodes -days 365 -keyout "$ETC/tls.key" -out "$ETC/tls.crt" -subj "/CN=$endpoint" -addext "subjectAltName=$san" >/dev/null 2>&1
  chmod 600 "$ETC/tls.key"
  if [[ -L /etc/nginx/sites-enabled/default && $(readlink /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]]; then
    touch "$ETC/restore-nginx-default"
    rm /etc/nginx/sites-enabled/default
  fi
  step 4 "Configure HTTPS, router and player access"
  python3 "$APP/nginx-config.py" "$ETC/settings.json" > /etc/nginx/sites-available/anthias-rooms
  ln -s /etc/nginx/sites-available/anthias-rooms /etc/nginx/sites-enabled/anthias-rooms
  nginx -t
  systemctl enable --now anthias-rooms
  systemctl reload nginx
  step 5 "Verify service startup"
  # Verify as the real service user before reporting success.
  runuser -u anthias-rooms -- test -r "$APP/server.py"
  runuser -u anthias-rooms -- test -r "$APP/web/panel.html"
  python3 - <<'PYHEALTH'
import json,time,urllib.request
for attempt in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8787/health',timeout=2) as r:
   if json.load(r).get('ok'):break
 except OSError:time.sleep(.2)
else:raise SystemExit('Backend failed to start: inspect journalctl -u anthias-rooms. Installation is not complete.')
PYHEALTH
  touch "$ETC/install-complete"
  python3 - "$ETC/settings.json" <<'PYRESULT'
import json,sys
from pathlib import Path
s=json.load(open(sys.argv[1]));panel='https://'+s['endpoint'];router=panel+':8443/'
text='Panel / setup wizard: '+panel+'\nRouter access (VPN connected): '+router+'\nInstallation setup key: '+s['bootstrap']+'\n'
p=Path('/root/anthias-rooms-setup.txt');p.write_text(text);p.chmod(0o600)
print('\n============================================================')
print('  ANTHIAS ROOMS VPS — INSTALLATION COMPLETE')
print('============================================================')
print('\n  1. OPEN THE SETUP WIZARD HERE\n     '+panel)
print('\n  2. INITIAL SETUP KEY — COPY IT INTO THE WIZARD\n     '+s['bootstrap'])
print('\n  3. OPEN THE REMOTE ROUTER HERE\n     '+router)
print('     Available after importing the profile and connecting the VPN.')
print('\n  4. PLAYER ACCESS\n     Use Access player in Info or Settings.')
print('     HTTPS ports 8444–8543 are assigned automatically.')
print('\n  PROVIDER FIREWALL\n     TCP: 80, 443, 8443, 8444–8543 | UDP: 443')
print('\n  Local management: bash /opt/anthias-rooms/install.sh')
print('  GitHub bootstrap: main branch, verified DEV release.')
print('\n  Setup details saved to: /root/anthias-rooms-setup.txt')
print('  Initial certificate is self-signed: a browser warning is expected.')
print('  Configure a trusted certificate before providing public access.')
print('============================================================\n')
PYRESULT
}
remove_all(){
  [[ -f "$ETC/owned-by-installer" || -f "$PACKAGES" ]] || fail 'No owned Anthias Rooms installation found.'
  if [[ -f "$ETC/owned-by-installer" ]]; then
    python3 "$SCRIPT_DIR/package-ownership.py" recover "$PACKAGES" strict
  else
    python3 "$SCRIPT_DIR/package-ownership.py" recover "$PACKAGES"
  fi
  python3 "$SCRIPT_DIR/package-ownership.py" plan "$PACKAGES"
  echo 'This purges Anthias Rooms VPS, its data, keys, tunnel and all packages added by its installer. Baseline system packages and player files are preserved.'
  read -r -p 'Type REMOVE ALL (both words) to confirm, or Enter to cancel: ' answer
  [[ "$answer" == 'REMOVE ALL' ]] || { echo 'Cancelled.'; return; }
  heading "REMOVE ANTHIAS ROOMS VPS"
  step 1 "Stop services and tunnel"
  systemctl disable --now anthias-rooms.service || true
  systemctl disable --now wg-quick@arwg0.service || true
  systemctl disable --now anthias-rooms-firewall.service || true
  nft list table inet anthias_rooms >/dev/null 2>&1 && nft delete table inet anthias_rooms || true
  step 2 "Remove router and player HTTPS access"
  rm -f /etc/nginx/sites-enabled/anthias-rooms /etc/nginx/sites-available/anthias-rooms
  if [[ -f "$ETC/restore-nginx-default" && ! -e /etc/nginx/sites-enabled/default && -f /etc/nginx/sites-available/default ]]; then ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default; fi
  if command -v nginx >/dev/null; then nginx -t; fi
  if systemctl is-active --quiet nginx; then
    echo 'Restarting shared Nginx to close existing router/player connections. Other Nginx sites briefly reconnect.'
    systemctl restart nginx
  fi
  systemctl reset-failed anthias-rooms.service wg-quick@arwg0.service anthias-rooms-firewall.service 2>/dev/null || true
  if [[ -f "$ETC/ufw-owned-rules" ]] && command -v ufw >/dev/null; then
    while IFS= read -r rule; do ufw --force delete allow "$rule" comment AnthiasRooms; done < "$ETC/ufw-owned-rules"
  fi
  purge_helper=$(mktemp /tmp/anthias-purge.XXXXXXXX.py)
  cp "$SCRIPT_DIR/package-ownership.py" "$purge_helper"
  step 3 "Remove application, database and keys"
  rm -f /root/anthias-rooms-setup.txt
  rm -f /etc/systemd/system/anthias-rooms.service /etc/systemd/system/anthias-rooms-firewall.service /etc/sudoers.d/anthias-rooms /etc/wireguard/arwg0.conf
  rm -rf -- "$APP" "$ETC" "$DATA"
  if id anthias-rooms >/dev/null 2>&1; then userdel anthias-rooms; fi
  systemctl daemon-reload
  step 4 "Verify removed components"
  for path in "$APP" "$ETC" "$DATA" /etc/wireguard/arwg0.conf /etc/nginx/sites-enabled/anthias-rooms /etc/nginx/sites-available/anthias-rooms /root/anthias-rooms-setup.txt /etc/sudoers.d/anthias-rooms /etc/systemd/system/anthias-rooms.service /etc/systemd/system/anthias-rooms-firewall.service; do
    [[ ! -e "$path" && ! -L "$path" ]] || fail "Removal incomplete: $path remains."
  done
  [[ -z $(ip -o link show arwg0 2>/dev/null) ]] || fail 'Removal incomplete: arwg0 still exists.'
  if id anthias-rooms >/dev/null 2>&1; then fail 'Removal incomplete: service user still exists.'; fi
  if nft list table inet anthias_rooms >/dev/null 2>&1; then fail 'Removal incomplete: firewall table still exists.'; fi
  python3 "$purge_helper" ports "$PACKAGES"
  step 5 "Purge installer-owned packages and their configuration"
  python3 "$purge_helper" purge "$PACKAGES"
  rm -f "$purge_helper"
  [[ ! -e "$PACKAGES" ]] || fail 'Removal incomplete: package receipt remains.'
  heading "REMOVAL COMPLETE"
  printf '  Anthias Rooms removed.\n  Removed: app, database, keys, tunnel and router/player access.\n  Player content: preserved.\n  Installer-owned packages: purged. Pre-existing system packages: preserved.\n\n'
}
trap 'echo "Installation/action stopped at line $LINENO. Review the error above before retrying." >&2' ERR
heading 'ANTHIAS ROOMS VPS v1.0.1-dev4 DEV'
printf '  1. Install\n  2. Remove all\n\n'
read -r -p 'Select: ' choice
case "$choice" in 1) install_app;; 2) remove_all;; *) fail 'Choose 1 or 2.';; esac

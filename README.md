# Anthias Remote Controller

**Anthias Rooms VPS v1.0.0 GOLDEN** is a cloud control panel for Anthias digital signage players connected through a remote WireGuard router. Use it from a desktop or mobile browser without installing Chrome or an extension. The interface supports **English and Italian**.

## Development preview

The `develop` branch provides **v1.0.1-dev4** with per-player screen orientation, responsive phone/tablet layouts, server-generated video thumbnails, refresh feedback and disabled **Already enrolled** discovery results. Use Settings → Players → Screen orientation to read or change the display rotation. FFmpeg is installed automatically for thumbnails. DEV4 records every package added by the bootstrap/installer, including transitive dependencies; Remove all purges those packages and their configuration, deletes cached JPEGs and closes old Nginx worker connections. The DEV bootstrap always uses the selected release installer, including removal of older installations. Legacy package ownership is recovered from matching APT history when available.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

Use a test VPS for this development version. See [development release notes](RELEASE_NOTES.md) for reinstall instructions and limitations.

## Stable installation and management

On a clean Debian 12/13 or Ubuntu 22.04/24.04 VPS, run as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

The bootstrap downloads the pinned stable release, verifies its SHA-256 checksum and opens this menu:

```text
1. Install
2. Remove all
```

Select **1. Install**, enter your public IPv4 address or DNS hostname and choose the WireGuard network (default `10.77.0.0/24`). The final summary shows the setup URL, initial setup key and remote router URL. Setup details are also saved in `/root/anthias-rooms-setup.txt`.

Temporary downloads are removed when the menu exits. Once installed, the same menu works offline:

```bash
bash /opt/anthias-rooms/install.sh
```

On an existing managed installation, the curl command opens this local menu. It does not overwrite or upgrade the installation. To change versions, select **Remove all**, type **REMOVE ALL**, then run the chosen bootstrap again. Reinstallation creates new keys, so import the new WireGuard profile into the router. Player media remain on the players.

Download the complete ZIP, bootstrap and checksums from [Releases](https://github.com/simonemessina92/Anthias-remote-controller/releases). An extracted ZIP also works: run `bash install.sh` inside its folder.

## First setup

1. Allow the ports listed below in the VPS provider firewall and keep SSH access available.
2. Open the HTTPS setup URL printed by the installer. The initial certificate is self-signed; configure a trusted certificate before providing public access.
3. Enter the **Installation setup key** and create your administrator password. There is no default password.
4. In **Connect remote router**, enter the actual LAN subnet behind the router, for example `192.168.8.0/24`. Generate the configuration, then **Copy configuration** or download it.
5. Import it into the GL.iNet WireGuard client, connect and enable **Allow Remote Access LAN**. Players must use the router as their gateway. This is a split tunnel; ordinary Internet access stays on the router WAN.
6. Select **Check connection**, then discover or add players. Discovery runs on the VPS through the VPN, using the configured remote subnet.
7. **Open remote router** opens its native GUI through VPN at `https://YOUR-VPS:8443/`. **Access player** opens the selected player's native GUI at its assigned HTTPS port.

Reserve player addresses in the router DHCP settings. No WireGuard installation or system changes are needed on the Raspberry Pi players.

| Purpose | VPS port |
|---|---|
| Control panel | TCP 443 |
| Redirect to HTTPS | TCP 80 |
| WireGuard | UDP 443 |
| Remote router GUI | TCP 8443 |
| Native player GUIs | TCP 8444–8543 |

The installer preserves active UFW and records only the rules it adds, so Remove all can remove those rules. Provider firewall rules are managed separately.

## Operation and access

Home/Event publishing, selective restoration, the editor, Home memory and automatic cleanup protections come from the approved local controller. Manual media deletion can remove Home/Event media, including live or processing files, after explicit confirmation. Saved references are removed only after the player confirms deletion; removing playing media can interrupt playback.

Each configured player receives a persistent, unique HTTPS port (up to 100 players). Rename, reorder and IP changes preserve its port. Removing a player revokes new requests and frees its port; targets must stay within the configured remote LAN. Close active native GUI connections/uploads before removing a player.

Opening, duplicating or restoring a panel tab requires the password. Refresh preserves that tab's session. **Logout**, also available in the wizard, immediately revokes the session. Tokens are stored in memory/sessionStorage, never localStorage; cookies alone cannot authenticate panel control APIs. Sessions expire after 12 hours and changing the password revokes all sessions.

Native router/player GUIs require a panel session active within the last 90 seconds, in addition to any native router credentials. Closing a tab sends a best-effort suspension request; if the browser cannot deliver it, native GUI availability expires within 90 seconds.

Keep the panel tab open while Home/Event operations run: the backend stores state and handles transport, but it is not an autonomous job runner. Native GUI edits may require refreshing the Rooms panel. Player-side Anthias API authentication is not supported by this version. Each VPS instance has one remote network and one administrator account; it is not a multi-tenant service.

The original local Chrome GOLDEN remains independent. Browser and cloud Home/Event assignments are not automatically synchronized. Use one controller at a time for operations affecting the same players. Local configuration can be imported after network setup if its addresses match the remote subnet; backups do not contain media.

## Branches and releases

- **main**: approved stable GOLDEN versions. Use the stable command above.
- **develop**: the next development version, published as a prerelease for testing.
- Promotion to main requires explicit owner approval. Published release assets are immutable; subsequent changes require a new version.
- GitHub Actions runs the automated checks before creating a release with ZIP, bootstrap and SHA-256 checksums. The same workflow handles stable releases and DEV prereleases.

Development installation, on a separate test instance:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

## Maintenance

```bash
systemctl status anthias-rooms wg-quick@arwg0
journalctl -u anthias-rooms -f
wg show arwg0
```

Use SQLite's backup API or stop the service before copying `/var/lib/anthias-rooms`. Keep secure backups of `/etc/anthias-rooms` and `/etc/wireguard/arwg0.conf` separately. Automatic scheduled backups are not configured. WireGuard profiles contain private keys; do not publish profiles, settings, keys or the database.

Remove all deletes the application, database, sessions, keys, dedicated tunnel, Nginx proxy configuration and installer-owned firewall rules. DEV4 also purges every package added by its bootstrap/installer, including dependencies and package configuration. Packages already present before installation and player content are preserved. It restarts active shared Nginx after deleting its site, briefly interrupting other sites; Nginx itself is purged only if the installer originally added it. Legacy installs use matching APT history to recover ownership. If ownership cannot be established or APT would remove unrelated packages, removal stops with the reason instead of guessing.

See [Italian documentation](README_IT.md), [test report](TEST_REPORT.md), [changelog](CHANGELOG.md) and [source baseline](BASELINE.md).

Technical references: [WireGuard](https://www.wireguard.com/quickstart/), [GL.iNet remote LAN access](https://docs.gl-inet.com/router/en/4/tutorials/wireguard_server_access_to_client_lan_side/), [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

# Anthias Remote Controller

**Anthias Rooms VPS v1.0.2 GOLDEN** is a cloud control panel for Anthias digital signage players connected through a remote WireGuard router. Use it from a desktop or mobile browser without installing Chrome or an extension. The interface supports **English and Italian**.

## Mobile DEV v1.0.3-dev1

The stable release remains VPS v1.0.2 GOLDEN. This DEV uses a compact vertical player list on phones and tablets, with touch scrolling and no horizontal carousel.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

## Shared player playlists

**VPS v1.0.2** and [Chrome v3.1.1](https://github.com/simonemessina92/Anthias-remote-controller/releases/tag/chrome-v3.1.1) read and write shared Home/Event assignments on each Anthias player. Both are approved GOLDEN releases and work independently. The VPS can be the primary controller and Chrome a local alternative.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

A local extension is optional; the VPS works on its own. The player contains one disabled **[HMR] Controller state v1** web asset with assignments, prepared order/duration, published snapshot and a short operation lease. Its reserved `.invalid` URI is never used for playback; URL checks are disabled and the schedule is in the future. Keep this record disabled and do not rename it. No service or package is installed on the player.

Refresh reads shared assignments. A new remote revision invalidates an open editor and stale cleanup jobs. Recognized legacy upload names can recover a single inactive file or an unambiguous active playlist, but several inactive files with the same role require explicit selection. Legacy recognition does not authorize automatic deletion.

Anthias has no atomic compare-and-swap API. Updated controllers cooperate through a lease checked before writes; older controllers and the native GUI do not honor it. Avoid concurrent native/old-controller edits. The lease expires after 60 seconds if the controller closes; interrupted publication recovery remains reserved to its original controller. Recover there before continuing. No password, room name, VPS address or VPN key is stored in the player record.

## Included in v1.0.1

Per-player screen orientation, responsive phone/tablet layouts, server-generated video thumbnails, refresh feedback and disabled **Already enrolled** discovery results. Change rotation in Settings → Players → Screen orientation. FFmpeg is installed automatically for thumbnails.

Remove all purges installer-added packages and their configuration, including transitive dependencies, removes cached thumbnails and closes old Nginx connections. Legacy package ownership is recovered from matching APT history; incomplete DEV4 receipts are repaired automatically.

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

The curl command always opens the pinned release management menu, including when removing an older installation. It does not upgrade an installed instance in place. To change versions, select **Remove all**, type **REMOVE ALL**, then run the chosen bootstrap again. Reinstallation creates new keys, so import the new WireGuard profile into the router. Player media remain on the players.

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

The current Chrome GOLDEN works independently on the local network and shares Home/Event state with this VPS when both are used. Local configuration can be imported after network setup if its addresses match the remote subnet; backups do not contain media.

## Branches and releases

- **main**: approved stable GOLDEN versions. Use the stable command above.
- **develop**: the next development version, published as a prerelease for testing.
- Promotion to main requires explicit owner approval. Published release assets are immutable; subsequent changes require a new version.
- GitHub Actions runs the automated checks before creating a release with ZIP, bootstrap and SHA-256 checksums. The same workflow handles stable releases and DEV prereleases.

Development installation, on a separate test instance:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

## Maintenance

```bash
systemctl status anthias-rooms wg-quick@arwg0
journalctl -u anthias-rooms -f
wg show arwg0
```

Use SQLite's backup API or stop the service before copying `/var/lib/anthias-rooms`. Keep secure backups of `/etc/anthias-rooms` and `/etc/wireguard/arwg0.conf` separately. Automatic scheduled backups are not configured. WireGuard profiles contain private keys; do not publish profiles, settings, keys or the database.

Remove all deletes the application, database, sessions, keys, dedicated tunnel, Nginx proxy configuration and installer-owned firewall rules. It also purges every package added by its bootstrap/installer, including dependencies and package configuration. Packages already present before installation and player content are preserved. It restarts active shared Nginx after deleting its site, briefly interrupting other sites; Nginx itself is purged only if the installer originally added it. Legacy installs use matching APT history to recover ownership. If ownership cannot be established or APT would remove unrelated packages, removal stops with the reason instead of guessing.

See [test report](TEST_REPORT.md), [changelog](CHANGELOG.md) and [source baseline](BASELINE.md).

Technical references: [WireGuard](https://www.wireguard.com/quickstart/), [GL.iNet remote LAN access](https://docs.gl-inet.com/router/en/4/tutorials/wireguard_server_access_to_client_lan_side/), [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

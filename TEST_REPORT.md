# Verification report

## Automated coverage

The release workflow runs **187 tests**, plus browser regression checks at five viewport sizes:

| Suite | Tests | Coverage |
|---|---:|---|
| Node | 110 | Playlist engine, rollback, cleanup protections, Home memory, discovery, editor comparison, markup, manual deletion and tab sessions |
| HTTP backend | 45 | Authentication, setup, leases, shared configuration, target restrictions, API proxy, uploads/previews, router authorization, VPN scan diagnostics, unique allocation of 100 player ports, stable mappings, revocation and tab token isolation |
| WireGuard helper | 11 | LAN routes, split tunnel, keepalive, persistent keys, permissions, rejected subnets, missing handshake and unchanged configuration |
| Package ownership/purge | 11 | Snapshot ownership, compressed legacy history, unrelated dependency protection, failed purge retries and real disposable DEB/conffile purge |
| Installer | 2 | Permissions under umask 077 and complete removal in an isolated temporary tree using simulated system commands |
| Nginx/TLS integration | 8 | Native GUI, absolute paths, cookie filtering, redirects, uploads, WebSocket upgrade and revoked ports |

Syntax checks cover Bash, Python and frontend JavaScript. Nginx integration tests run with real Nginx/TLS in GitHub Actions; local environments without Nginx skip them. Test player payloads are synthetic. Backend tests use `AR_TEST=1` for loopback mock players and simulated WireGuard; production installation does not set it. Automated tests do not establish real HDMI playback or VPN performance.

The release includes orientation read/write tests, authenticated FFmpeg JPEG generation and enrollment revocation checks. Browser checks cover responsive layouts, video frames, orientation controls, refresh and disabled enrolled results. Browser regression coverage also checks navigation/sidebar separation, compact player labels and non-overlapping playlist image/video controls with long local filenames.

## Hardware acceptance

The v1.0.1-dev5 field test confirmed operation, clean mobile layouts, orientation, previews and removal. Promotion to v1.0.1 GOLDEN was approved on 2026-10-08.

The owner reports successful use with a real VPS, GL.iNet router and one Anthias player, including Home/Event operation, and explicitly approved v1.0.0 GOLDEN promotion on 2026-10-05. Simultaneous operation with multiple real players remains to be tested. The port allocator is covered automatically with 100 simulated mappings; this is not a 100-device hardware test.

The original Chrome GOLDEN archive remains unchanged at SHA-256 `4f8a36720e30f1389f026ea7ca5b4066e2b74d45303aa228ca5045794ef50192`.

## Reproduce

```bash
node --test tests/*.test.mjs
python3 tests/test_backend.py
python3 tests/test_wireguard.py
sudo python3 tests/test_installer.py
python3 tests/test_nginx.py
python3 scripts/build_release.py
bash -n bootstrap.sh install.sh
python3 -m py_compile server.py wg-helper.py nginx-config.py
```

Check the GitHub Actions run for the release commit before using its assets. Further acceptance should cover multiple real players, mobile layout, long uploads/video range requests, local emergency control and the chosen trusted certificate/backup procedures.

Removal coverage runs Remove all against a real disposable Nginx instance with an unfinished HTTP connection on player port 8444. It checks connection closure, thumbnail/database removal, continued shared-site operation and immediate address reuse. Pre-existing Nginx is preserved; restarting shared Nginx briefly interrupts its connections. Installer-added Nginx and other dependencies are purged. The package integration uses two disposable DEBs to verify removal of a package, its dependency and configuration files without touching baseline packages.

Release publication additionally requires six complete installer lifecycle runs: Debian 12, Debian 13 and Ubuntu 24.04, each with fresh installation and legacy migration. These use disposable containers with real systemd, WireGuard, Nginx and APT; they check install, purge with a pending player connection, reinstall and a second purge, restoring the package baseline after both removals. Legacy cases deliberately recreate the broken DEV4 receipt for Architecture: all packages.

## Shared-controller development coverage

Thirteen state protocol tests cover legacy recognition/ambiguity, staged Home during Event playback, two-way changes, clean controller enrollment, native timing/order changes, manual deletion, malformed/duplicate records, lease exclusion/expiry/loss, stale cleanup invalidation and interrupted recovery.

The release workflow loads the actual keyed Chrome extension alongside the VPS page against one synthetic HTTP player. It verifies native previews, orientation read/write, five viewport layouts, refresh, local-to-cloud changes, cloud-to-local changes, stale-editor rejection and Home restoration. The extension checkout is pinned to commit `76ad9e71a97b538a5621e579dba0b56308a93777`. Native Anthias API validation is based on the official asset API: names are text fields and create/PATCH expose name; skip_asset_check permits an inactive reserved web record. Hardware validation remains pending.

The shared-controller field test confirmed upload and state synchronization from VPS to local Chrome and back. VPS v1.0.2 and Chrome v3.1.1 GOLDEN promotion was approved on 2026-10-08.

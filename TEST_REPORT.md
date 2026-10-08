# Verification report

## Automated coverage

The release workflow runs **161 tests**, plus browser regression checks at five viewport sizes:

| Suite | Tests | Coverage |
|---|---:|---|
| Node | 96 | Playlist engine, rollback, cleanup protections, Home memory, discovery, editor comparison, markup, manual deletion and tab sessions |
| HTTP backend | 45 | Authentication, setup, leases, shared configuration, target restrictions, API proxy, uploads/previews, router authorization, VPN scan diagnostics, unique allocation of 100 player ports, stable mappings, revocation and tab token isolation |
| WireGuard helper | 11 | LAN routes, split tunnel, keepalive, persistent keys, permissions, rejected subnets, missing handshake and unchanged configuration |
| Installer | 2 | Permissions under umask 077 and complete removal in an isolated temporary tree using simulated system commands |
| Nginx/TLS integration | 7 | Native GUI, absolute paths, cookie filtering, redirects, uploads, WebSocket upgrade and revoked ports |

Syntax checks cover Bash, Python and frontend JavaScript. Nginx integration tests run with real Nginx/TLS in GitHub Actions; local environments without Nginx skip them. Test player payloads are synthetic. Backend tests use `AR_TEST=1` for loopback mock players and simulated WireGuard; production installation does not set it. Automated tests do not establish real HDMI playback or VPN performance.

The DEV adds orientation read/write tests, authenticated FFmpeg JPEG generation and enrollment revocation checks. Browser checks cover responsive layouts, video frames, orientation controls, refresh and disabled enrolled results. DEV3 also checks navigation/sidebar separation, compact player labels and non-overlapping playlist image/video controls with long local filenames. Local execution passed 154 tests; the seven Nginx tests and browser checks require the release CI environment.

## Hardware acceptance

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

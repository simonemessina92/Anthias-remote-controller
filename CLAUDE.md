# CLAUDE.md

Instructions for Claude working on **Anthias Remote Controller** (Anthias Rooms). The owner is Simone; talk to him in **Italian**, short and simple. Repository docs, code comments and commit messages stay in **English**.

## What this repository is

One hybrid product with two independent controllers for Anthias digital signage players. Both share Home/Event playlist state stored on each player.

| Part | Branch | Where it runs | Release tag |
|---|---|---|---|
| **VPS / cloud controller** (Anthias Rooms VPS) | `main` (GOLDEN), `develop` (DEV) | Debian/Ubuntu VPS, reaches players through a WireGuard split tunnel to a GL.iNet router | `vX.Y.Z` / `vX.Y.Z-devN` |
| **Local Chrome extension** (Anthias Rooms Chrome) | `google-extension-plugin` | Operator's Chrome on the player LAN, no backend | `chrome-vX.Y.Z[-devN]` |

`google-extension-plugin` is a **separate long-lived line**, not a feature branch: it has its own file layout (`extension/`), its own workflow (`.github/workflows/chrome-release.yml`) and is never merged into `develop`/`main` (or vice versa). Cross-branch work means changing both lines deliberately.

### VPS layout (`main` / `develop`)

- `server.py`: Python HTTP backend (auth, sessions, leases, API proxy to players, uploads/previews, port allocation).
- `web/`: browser panel. Derived from the Chrome extension source (see `BASELINE.md`); `web/vps-adapter.js` replaces Chrome APIs with server-backed storage and locks.
- `install.sh`, `bootstrap.sh`: installer and pinned-release bootstrap (menu: Install / Remove all). `bootstrap.sh` contains `VERSION=` and must match `package.json`.
- `wg-helper.py`, `nginx-config.py`, `package-ownership.py`: WireGuard, Nginx/TLS proxy and APT package ownership/purge.
- `scripts/build_release.py`: reproducible ZIP + `SHA256SUMS` into `dist/`. Note: it packages every root `.md` file, so this `CLAUDE.md` ends up in future VPS ZIPs.
- `tests/`: Node (`*.test.mjs`), Python suites, browser checks (Playwright), install/purge cycle in Docker.

### Chrome extension layout (`google-extension-plugin`)

- `extension/`: MV3 extension (`manifest.json`, `background.js`, `panel.*`, shared modules like `player-state.js`). Version lives in **both** `extension/package.json` and `extension/manifest.json` (`version` + `version_name`, e.g. `3.1.1 GOLDEN`).
- Extension ID must stay `cfhcncajkcblicinnngdhfmnmnlfhign` (public key in manifest). Never change the key or storage key names: users update in place and must keep their configuration.
- `downloads/`: historical v3.0.0 package, keep it.

## Shared player state (both lines)

Both controllers read/write one disabled web asset on each player named `[HMR] Controller state v1` (reserved `.invalid` URI). Changes to its format, lease (60 s) or recovery journal must stay compatible across VPS and Chrome; the VPS CI pins a Chrome commit (`ref:` in `.github/workflows/release.yml`) and runs `tests/test_controller_sync.py` against it. If you change shared-state code on one line, update the other and the pinned commit.

## Build and test

VPS (`main`/`develop`), Node 22 + Python 3:

```bash
bash -n bootstrap.sh install.sh
python3 -m py_compile server.py wg-helper.py nginx-config.py scripts/build_release.py
for f in web/*.js; do node --check "$f"; done
node --test tests/*.test.mjs          # 110 tests
python3 tests/test_backend.py         # 45 tests
python3 tests/test_wireguard.py
python3 tests/test_nginx.py           # needs nginx, otherwise skipped
# need root / real services, normally CI only:
sudo env AR_PACKAGE_INTEGRATION=1 python3 tests/test_packages.py
sudo python3 tests/test_installer.py
bash tests/run_install_cycle.sh 'debian:trixie' fresh   # Docker
# browser (Playwright 1.55.0 + Chromium):
python3 tests/test_browser.py
AR_EXTENSION_DIR=/path/to/chrome/extension python3 tests/test_controller_sync.py
python3 scripts/build_release.py
```

Chrome extension (`google-extension-plugin`):

```bash
for f in extension/*.js; do node --check "$f"; done
node --test tests/*.test.mjs          # 101 tests
python3 tests/test_native_browser.py  # Playwright, five viewports
python3 scripts/build_release.py
```

Do not run `playwright install` in Claude cloud sessions; Chromium is preinstalled.

## Branching, versions and releases

- Workflow with Simone: develop on `develop` (VPS) or `google-extension-plugin` (Chrome) and push there; Simone tests the DEV release; only when he says **"golden"** promote to `main` (VPS) or to a GOLDEN version (Chrome). Never promote without his explicit approval.
- **Every push to `main`, `develop` or `google-extension-plugin` triggers CI and a GitHub release.** CI validates the version channel: on `develop` `package.json` must be `X.Y.Z-devN`, on `main` `X.Y.Z`.
- Published release assets are immutable: any runtime change needs a version bump (`package.json`, `bootstrap.sh` `VERSION=`, `install.sh`, `server.py`, `web/panel.html`, `web/panel.js` labels on VPS; `extension/package.json` + `manifest.json` on Chrome). If the tag already exists, the workflow skips publishing.
- GOLDEN promotion keeps the tested runtime and only changes version labels and docs; record the promoted DEV commit in `BASELINE.md`, plus `CHANGELOG.md`, `RELEASE_NOTES.md`, `README.md`, `TEST_REPORT.md`.
- Docs-only commits can use `[skip ci]` in the commit message to avoid a full CI/release run.

## Safety rules

- Never commit secrets: WireGuard profiles/keys, setup keys, passwords, `/etc/anthias-rooms`, databases.
- Do not weaken auth: session tokens only in memory/sessionStorage (never localStorage), 12 h expiry, 90 s native GUI gating, password required per tab.
- Installer "Remove all" must only purge what the installer added; if ownership is unclear it must stop, not guess.
- Manual deletion must only update shared assignments after the player confirms deletion; legacy name recognition never authorizes automatic deletion.
- Never skip or disable tests to make CI green.

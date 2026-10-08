# Anthias Rooms VPS v1.0.1-dev5

- Repair legacy package ownership when APT history records architecture-independent packages using the host architecture. Existing DEV4 receipts are repaired automatically, including the missing icon, ALSA, desktop schema and GTK common packages. Foreign architectures remain distinct.
- Installer-added sudo can be purged from a direct root session, including SSH-key authentication. A sudo-only session with locked root stops before removal. Pre-existing sudo is preserved.
- Limit APT purge to installer-owned packages; unrelated automatic cleanup is disabled. Baseline packages remain protected.
- Release publication requires real install → purge → reinstall → purge cycles on Debian 12, Debian 13 and Ubuntu 24.04, for both fresh installs and migration from the legacy installer with a broken DEV4 receipt. Tests leave a player GUI connection open during removal and compare the package baseline after each purge.

Previous mobile layout, orientation, video preview and removal fixes remain available. No new runtime dependencies.

Install on a test VPS as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

An existing installation opens its current management menu. Select Remove all, confirm with REMOVE ALL, then run the command again to install this DEV. This deletes controller configuration and VPN keys; export your configuration first if you need it. Player media remain on the players. Import the newly generated WireGuard profile into the router.

Firewall ports are unchanged: TCP 80, 443, 8443, 8444–8543; UDP 443. The installer now also installs FFmpeg. Main remains v1.0.0 GOLDEN.

Screen rotation reloads the Anthias viewer and can briefly interrupt playback. Video thumbnails are file previews, not a live HDMI return. Video preview playback still depends on browser codec support; the player continues to play the original file.

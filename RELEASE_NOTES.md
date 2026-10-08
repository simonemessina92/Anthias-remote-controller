# Anthias Rooms VPS v1.0.1-dev4

- Remove all restarts shared Nginx after deleting the Anthias site, closing old worker connections to router/player GUI ports. Other Nginx sites briefly reconnect. Nginx is subsequently purged if it was installed by this project; pre-existing packages are preserved.
- Remove all purges all packages added by the bootstrap/installer, including transitive dependencies, package configuration and cached archives. Ownership is recorded before/after installation; older versions recover it from matching APT history. Missing legacy history or unrelated dependent packages stop removal before deleting the application.
- The DEV bootstrap downloads the selected release installer even for an existing installation, so old removal code is not reused.
- Port checks use address reuse, accepting closed TCP connections while still rejecting active listeners. Errors include the actual operating-system cause.
- Real Nginx regression executes Remove all with an open player-port connection and verifies closure, cache removal and immediate port reuse.

Mobile layout fixes and all features from dev3 remain available. No new runtime dependencies.

Install on a test VPS as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

An existing installation opens its current management menu. Select Remove all, confirm with REMOVE ALL, then run the command again to install this DEV. This deletes controller configuration and VPN keys; export your configuration first if you need it. Player media remain on the players. Import the newly generated WireGuard profile into the router.

Firewall ports are unchanged: TCP 80, 443, 8443, 8444–8543; UDP 443. The installer now also installs FFmpeg. Main remains v1.0.0 GOLDEN.

Screen rotation reloads the Anthias viewer and can briefly interrupt playback. Video thumbnails are file previews, not a live HDMI return. Video preview playback still depends on browser codec support; the player continues to play the original file.

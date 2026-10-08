# Anthias Rooms VPS v1.0.1-dev3

- Mobile navigation reserves its full height above the player list.
- Player settings use compact rows without excess vertical space.
- Playlist editor separates thumbnails, filenames, timing and reorder/delete controls on phones and tablets. Footer buttons fit narrow screens.
- Content actions wrap together; empty notification areas no longer reserve a blank row.
- Browser checks now detect overlapping sections and playlist controls, including long filenames and local uploads.

Orientation, server-generated thumbnails and refresh behavior from dev2 remain available. No additional runtime dependencies.

Install on a test VPS as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

An existing installation opens its current management menu. Select Remove all, confirm with REMOVE ALL, then run the command again to install this DEV. This deletes controller configuration and VPN keys; export your configuration first if you need it. Player media remain on the players. Import the newly generated WireGuard profile into the router.

Firewall ports are unchanged: TCP 80, 443, 8443, 8444–8543; UDP 443. The installer now also installs FFmpeg. Main remains v1.0.0 GOLDEN.

Screen rotation reloads the Anthias viewer and can briefly interrupt playback. Video thumbnails are file previews, not a live HDMI return. Video preview playback still depends on browser codec support; the player continues to play the original file.

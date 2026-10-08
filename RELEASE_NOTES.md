# Anthias Rooms VPS v1.0.1-dev2

- Set each player's screen orientation to 0°, 90°, 180° or 270° from Settings → Players → Screen orientation. The current value is read from Anthias and verified after saving.
- Responsive layouts for phones, tablets and desktops. Player selection no longer clips on mobile; Settings headings and actions wrap correctly.
- Shared video thumbnails generated on the VPS, including videos above the browser's 160 MB preview limit. Browser decoding support no longer determines whether a thumbnail appears. FFmpeg runs one worker with one decode thread and keeps at most 100 JPEGs.
- Refresh updates player status and retries the visible previews, with a visible completion message and unavailable-player count.
- Previously enrolled players are greyed out as **Already enrolled** in discovery and cannot be selected again. Address updates for a verified moved player remain available.

Install on a test VPS as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

An existing installation opens its current management menu. Select Remove all, confirm with REMOVE ALL, then run the command again to install this DEV. This deletes controller configuration and VPN keys; export your configuration first if you need it. Player media remain on the players. Import the newly generated WireGuard profile into the router.

Firewall ports are unchanged: TCP 80, 443, 8443, 8444–8543; UDP 443. The installer now also installs FFmpeg. Main remains v1.0.0 GOLDEN.

Screen rotation reloads the Anthias viewer and can briefly interrupt playback. Video thumbnails are file previews, not a live HDMI return. Video preview playback still depends on browser codec support; the player continues to play the original file.

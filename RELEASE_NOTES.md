# Anthias Rooms VPS v1.0.1 GOLDEN

[Download the complete ZIP](https://github.com/simonemessina92/Anthias-remote-controller/releases/download/v1.0.1/Anthias_Rooms_VPS_v1.0.1.zip)

- Set each player's screen orientation from Settings.
- Responsive phone and tablet layouts, including navigation, player settings and playlist controls.
- Server-generated video thumbnails, refresh feedback and disabled Already enrolled discovery results.
- Remove all purges installer-added packages and configuration, closes old Nginx connections and frees the player GUI ports. Pre-existing packages and player media are preserved.
- Recover legacy package ownership and automatically repair incomplete DEV4 receipts.

Run as root on the VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

To replace an existing installation, select **2. Remove all**, type **REMOVE ALL**, then run the command again and select **1. Install**. Controller settings and VPN keys are deleted; export settings beforehand if needed. Import the new WireGuard profile into the router. Player media remain on the players.

Firewall ports: TCP 80, 443, 8443, 8444–8543; UDP 443. FFmpeg is required for video thumbnails. Rotation can briefly interrupt playback. Thumbnails are file previews; video playback in the browser depends on codec support.

Validation: 173 automated tests, five browser viewport checks and six full install/purge/reinstall/purge cycles on Debian 12, Debian 13 and Ubuntu 24.04. Field acceptance includes mobile layout, orientation, previews and removal. The local Chrome extension remains independent.

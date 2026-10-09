# Anthias Rooms VPS v1.0.3-dev1 DEV

[Download ZIP](https://github.com/simonemessina92/Anthias-remote-controller/releases/download/v1.0.3-dev1/Anthias_Rooms_VPS_v1.0.3-dev1.zip)

On phones and tablets, the player selector is a compact vertical list. Swipe up/down inside it to reach all players. Desktop navigation is unchanged.

Only mobile navigation styling and version labels change. Playback, shared state, VPN, previews and purge behavior retain the approved v1.0.2 GOLDEN runtime. Main and Chrome GOLDEN releases remain unchanged.

Run as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

For a clean test, export settings, remove with option 2, rerun and install with option 1. Reimport the new WireGuard profile. Player media is preserved.

Browser checks select the last and an earlier player in an eight-player list at five viewport sizes, verify vertical scrolling on mobile and rerun existing layout checks.

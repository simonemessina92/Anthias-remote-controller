# Anthias Rooms VPS v1.0.3 GOLDEN

[Download ZIP](https://github.com/simonemessina92/Anthias-remote-controller/releases/download/v1.0.3/Anthias_Rooms_VPS_v1.0.3.zip)

On phones and tablets, select players from a compact vertical list. Swipe up/down inside the list to reach every player. Desktop navigation retains its sidebar.

Promotes the field-tested v1.0.3-dev1. Playback, shared Home/Event state, VPN, previews and purge retain the approved behavior. Compatible with Chrome v3.1.1 GOLDEN, which works independently on the local network.

Run as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

For a clean reinstall, export settings, remove with option 2, rerun and install with option 1. Import the new WireGuard profile. Player media is preserved.

Verification passed: source tests, eight-player selection at five viewport sizes, controller synchronization and six install/purge cycles on Debian 12/13 and Ubuntu 24.04. Mobile field acceptance confirmed before GOLDEN promotion.

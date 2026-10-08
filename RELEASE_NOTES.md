# Anthias Rooms VPS v1.0.2 GOLDEN

[Download ZIP](https://github.com/simonemessina92/Anthias-remote-controller/releases/download/v1.0.2/Anthias_Rooms_VPS_v1.0.2.zip)

- Share current and prepared Home/Event playlists with Chrome v3.1.1 through a disabled player-resident record.
- Refresh and reconcile state before writes; reject stale editor revisions and discard obsolete cleanup jobs.
- Recover unambiguous legacy Home/Event upload labels without granting deletion rights.
- Coordinate updated controllers with a short lease and protect interrupted publication recovery.

Promotes the approved v1.0.2-dev1 behavior. Earlier release packages remain available. No new runtime dependencies or player services.

Run as root on the test VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

Remove the current VPS installation with option 2, confirm REMOVE ALL, then rerun and install with option 1. Export controller settings first if needed; removal deletes settings and VPN keys but preserves player media. Import the new router WireGuard profile.

[Download the compatible Chrome GOLDEN](https://github.com/simonemessina92/Anthias-remote-controller/releases/tag/chrome-v3.1.1). Replace files in the same extension folder and Reload. The extension ID remains unchanged.

Leave **[HMR] Controller state v1** disabled in the native Anthias list. Refresh each controller after edits from the other. Older controllers/native Anthias do not participate in the cooperative lock: avoid concurrent writes. If publication is interrupted, recover it from its original controller.

Validation includes 187 source tests, five VPS viewport checks, the real Chrome extension at five viewport sizes, two-way UI synchronization, stale-editor rejection and Home restoration, plus six complete VPS install/purge cycles. Two-way synchronization was confirmed on a physical player and approved for GOLDEN release.

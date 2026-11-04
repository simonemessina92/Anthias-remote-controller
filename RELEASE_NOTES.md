# Anthias Rooms Chrome v3.1.2-dev1 DEV

[Download ZIP](https://github.com/simonemessina92/Anthias-remote-controller/releases/download/chrome-v3.1.2-dev1/Anthias_Rooms_Chrome_v3.1.2-dev1.zip)

- When an upload is interrupted, ask the player for its free space and say whether the cause is a nearly full player disk or the network between the computer and the player (router, firewall, proxy). Anthias answers a full disk while the browser is still sending, which Chrome reports as a dropped connection.
- Fix: an image whose duration was changed in the native Anthias UI to 0 s, a fraction, or more than 24 h was copied as-is into the shared record, which every controller then rejected as invalid. Observed durations are now clamped to 1..86400 s.
- Fix: an invalid shared record no longer shows a reachable player as "Unreachable". The player stays connected, the record error is shown, and changes remain blocked until it is resolved.
- Shared record format, lease and storage keys are unchanged.

Replace files in the same extension folder and Reload in chrome://extensions. Do not remove the extension or clear its data.

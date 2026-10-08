# Anthias Rooms — Local Chrome Extension

**v3.1.0-dev1** adds player screen orientation, responsive layouts, refresh feedback and shared Home/Event assignments with the VPS controller **v1.0.2-dev1**.

[Download the new Chrome DEV](https://github.com/simonemessina92/Anthias-remote-controller/releases/tag/chrome-v3.1.0-dev1)

## Install or update

1. Extract the release ZIP into a permanent folder.
2. For an existing installation, replace the files in the **same extension folder**, then click **Reload** in `chrome://extensions`. Preserve your configuration; do not remove the extension or clear its data.
3. For a first installation, enable **Developer mode**, choose **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Click the extension icon, configure the players and grant network access. The interface supports English and Italian.

The public key and extension ID remain **cfhcncajkcblicinnngdhfmnmnlfhign**. Its page is `chrome-extension://cfhcncajkcblicinnngdhfmnmnlfhign/panel.html`. Chrome's numeric manifest version is 3.1.0; the displayed development version is 3.1.0-dev1.

Preview, upload and player access remain direct. This extension installs no backend, WireGuard or FFmpeg.

## Shared Home and Event

Use this extension with **VPS v1.0.2-dev1 or newer compatible versions**. Refresh reads the player rather than relying only on the controller's cache. Both controllers store current assignments, staged order/duration and the published Home/Event snapshot in one disabled web asset on each player. Its name starts with **[HMR] Controller state v1**. It is a data record, has a reserved `.invalid` URL, skips URL checks and is scheduled in the future. It is not a video or an external service. Leave it disabled and do not rename/delete it during normal operation.

Player state contains asset IDs, playlist timing/history and a temporary operation lease. Passwords, VPS addresses, private keys and room names remain local to each controller. There is no daemon to install on the player.

Existing `[HMR] Home/Hotel/Event/Evento` upload names are recognized when no shared record exists. A single file or an unambiguous active playlist can be recovered. Several inactive legacy files with the same prefix do not prove the intended playlist; choose the intended files before publishing. Recognizing a file never grants automatic deletion permission.

Updated controllers use a cooperative lease and readback before writes. An editor opened before a remote revision must be reopened. Anthias has no atomic compare-and-swap endpoint; native Anthias and older controllers do not honor this lease. Do not edit with an older controller or the native GUI while an operation is running. A closed/crashed controller's lease expires after 60 seconds. Interrupted playback changes retain the existing recovery journal in the originating controller.

Refresh reads shared assignments automatically; the selected player is checked every five seconds while the panel is visible. New revisions discard stale cleanup jobs. Manual deletion updates shared assignments only after deletion is confirmed. Media and network discovery remain native to Chrome.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | VPS v1.0.1 GOLDEN, unchanged by this development release |
| `develop` | VPS development and synchronization testing |
| `google-extension-plugin` | Local Chrome extension |

The original [v3.0.0 package](https://github.com/simonemessina92/Anthias-remote-controller/raw/refs/heads/google-extension-plugin/downloads/Anthias_Rooms_Chrome_v3.0.0.zip) remains available. It does not support shared assignments.

## Verification

The workflow runs 100 Node tests and loads the real extension in Chromium at five viewport sizes. VPS publication additionally checks both interfaces against the same synthetic player, including two-way synchronization, Home restoration and rejection of a stale editor. Physical-player acceptance is required before GOLDEN promotion.

# Anthias Rooms — Local Chrome Extension

This branch contains **Anthias Rooms v3.0.0 for local use in Google Chrome**. It contains the original extension code supplied by the project owner, preserved without functional changes.

The cloud controller is a separate product in this repository:

| Branch | Purpose |
| --- | --- |
| `main` | Stable VPS controller |
| `develop` | VPS development and testing |
| `google-extension-plugin` | Local Chrome extension and its original package |

Do not merge this branch into the VPS branches. Its tree intentionally contains only the local extension, its download package and this documentation; the VPS installer and release workflows do not apply here.

## Download and install

Download [Anthias_Rooms_Chrome_v3.0.0.zip](https://github.com/simonemessina92/Anthias-remote-controller/raw/refs/heads/google-extension-plugin/downloads/Anthias_Rooms_Chrome_v3.0.0.zip), then:

1. Extract the archive into a permanent folder on your computer.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted `Anthias_Rooms_v3.0.0` folder containing `manifest.json`.
4. Click the extension icon to open the control panel. Configure the player addresses and grant the requested access permissions.

The browser must be able to reach the Anthias players directly, over the local network or an independently configured VPN. This extension does not install a VPS, create a WireGuard tunnel or provision remote GUI ports.

## Updating an existing installation

Replace the files in the **same extension folder** and click **Reload** in `chrome://extensions`. Keep the manifest public key unchanged. Do not remove and reinstall the extension or reset its data as part of a normal update.

- Extension version: `3.0.0`
- Extension ID: `cfhcncajkcblicinnngdhfmnmnlfhign`
- Panel URL: `chrome-extension://cfhcncajkcblicinnngdhfmnmnlfhign/panel.html`
- Interface languages: English and Italian


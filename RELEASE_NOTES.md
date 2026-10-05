# Anthias Rooms VPS v1.0.0 GOLDEN

Owner-approved stable release of the standalone VPS controller, based on DEV4.

- English installer, bootstrap and primary documentation; English/Italian web interface.
- WireGuard remote-router setup with copy/download configuration and authenticated native router access.
- Native player access through unique persistent HTTPS ports, with mapping updates and removal tied to player configuration.
- Home/Event switching, restoration and manual deletion of media, including live files after confirmation.
- Password required for newly opened tabs and explicit Logout in panel/wizard.
- Reproducible release assets, verified curl bootstrap and Install / Remove all management.
- Original local Chrome GOLDEN preserved.

Run as root on Debian 12/13 or Ubuntu 22.04/24.04:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/main/bootstrap.sh)
```

Provider firewall: TCP 80, 443, 8443, 8444–8543; UDP 443. After a clean reinstall, import the newly generated WireGuard profile into the router. The initial HTTPS certificate is self-signed. See README for setup and session behavior.

# Anthias Rooms VPS v1.0.1-dev1

Development baseline for the next test cycle, based on v1.0.0 GOLDEN. Runtime behavior is unchanged; only version/channel labels differ. Stable installations should continue using the main bootstrap.

Run as root on a separate test VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

Provider firewall: TCP 80, 443, 8443, 8444–8543; UDP 443. To change an installed version, use Remove all and reinstall, then import the new WireGuard profile. Player content is preserved.

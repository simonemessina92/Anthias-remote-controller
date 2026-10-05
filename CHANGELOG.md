# Anthias Rooms VPS v0.1.0-dev4

- Accesso del pannello legato alla singola scheda: nuova scheda/ripristino richiede password, refresh mantiene l’accesso. Cookie-only login rimosso.
- Logout visibile nel pannello e nel wizard, con revoca della sessione lato server.
- Bootstrap curl: download verificato con SHA-256, menu Install/Remove all, pulizia download temporanei e menu locale offline.
- Repository develop/main e prerelease DEV con test automatici prima della pubblicazione.
- Mantiene copia profilo WireGuard, GUI native dei player su HTTPS 8444–8543, eliminazione manuale media anche attivi e CLI ordinata della DEV3.
- GOLDEN locale invariata.

Come root sulla VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

Firewall provider: TCP 80/443/8443/8444–8543, UDP 443. Per cambiare DEV: Remove all e nuova installazione, poi reimporta il nuovo profilo WireGuard sul router.

# v0.1.0-dev3

- Wizard router ordinato: genera → copia/scarica → importa e collega → verifica → apri router. Copia clipboard con selezione manuale di fallback.
- GUI native dei player via HTTPS su porte persistenti 8444–8543, assegnate automaticamente e risolte da Nginx mediante autorizzazione del backend. Login obbligatorio; update/revoca nella stessa transazione della configurazione.
- Access player nelle Info e nelle Impostazioni.
- Eliminazione manuale di media Home/Event anche attivi; conferma esplicita e rimozione dei riferimenti solo dopo conferma del player. Cleanup automatico invariato.
- CLI install/remove con fasi e riepilogo finale ordinato, URL wizard/router e dati setup salvati.
- GOLDEN locale invariata.

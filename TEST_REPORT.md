# Anthias Rooms VPS v0.1.0-dev4 — verifica

## Eseguito

- **92 test Node**: motore playlist, rollback, protezioni cleanup, memoria Home,
  discovery, confronto editor e layout markup. Derivati dai test GOLDEN, escludendo
  quelli della shell Chrome e dell’autenticazione locale; l’URL preview è aggiornato
  al proxy VPS. Sono inclusi 5 test della cancellazione manuale: file live, riferimenti, errore API e protezioni automatiche conservate. Sono inclusi 3 test della sessione per nuova navigazione/ripristino, refresh e logout. Questi non sono test visivi.
- **42 test HTTP** su un vero processo backend locale e un player Anthias simulato:
  accesso autenticato, primo setup protetto, sessioni, blocchi tra sessioni,
  configurazione condivisa, restrizioni dei target, percorsi API, multipart upload,
  anteprime, modifica durata, ordine, reboot, logout; autorizzazione proxy router, diagnostica rete, scan dal backend e conteggio errori; assegnazione univoca di 100 porte player, stabilità su cambio IP/riordino, revoca, validazione atomica e mancato inoltro del cookie cloud; rifiuto cookie-only, revoca logout e indipendenza dei token tra schede.
- **11 test helper WireGuard** con comandi di sistema simulati: route della LAN,
  profilo split tunnel, keepalive, chiavi persistenti, permessi file, subnet vietate,
  assenza handshake, nessun restart se configurazione invariata.
- **2 test installer** in albero temporaneo: permessi gruppo con umask 077 e Remove all con comandi di sistema simulati. Questo ambiente mappa solo UID/GID 0: non è stata eseguita una lettura con l’utente di servizio reale.
- Sintassi di tutti i moduli JavaScript, Python e Bash verificata.
- SHA-256 ZIP GOLDEN invariato:
  `4f8a36720e30f1389f026ea7ca5b4066e2b74d45303aa228ca5045794ef50192`.
- Nessuna modifica scritta nella cartella o nello ZIP GOLDEN.

## Da collaudare

- Test di integrazione Nginx/TLS (7): eseguiti in GitHub Actions; nell’ambiente locale Nginx non è disponibile e vengono saltati. Prima della pubblicazione verificare l’esito della pipeline.
- Collaudo su router GL.iNet e Anthias reali delle nuove sessioni e GUI native.
- Install / Remove all su Debian/Ubuntu vuoto con systemd, Nginx e WireGuard reali.
- Handshake UDP 443, route e Allow Remote Access LAN sul GL.iNet.
- Estensione locale come controller di emergenza: le configurazioni dei due
  controller sono indipendenti, non una sincronizzazione automatica.
- UI reale, responsive su telefono, wizard, video con Range e upload lunghi.
- Semantica API, playback HDMI e ripristino su Anthias reale.
- Certificato attendibile, backup e gestione operativa prima della commercializzazione.

## Comandi riproducibili

```bash
node --test tests/*.test.mjs
python3 tests/test_backend.py
python3 tests/test_wireguard.py
python3 tests/test_installer.py
python3 tests/test_nginx.py
python3 scripts/build_release.py
bash -n install.sh
python3 -m py_compile server.py wg-helper.py nginx-config.py
```

I test HTTP avviano il backend con `AR_TEST=1`: solo in quel modo sono ammessi
player loopback e viene simulato WireGuard. L’installer di produzione non imposta
questa variabile. Le prove non attestano installazione reale né prestazioni LAN/VPN.

Le funzioni Home/Event della DEV2 sono state confermate da Sem sul sistema reale prima di questa release. Il nuovo proxy GUI della DEV3 non è stato ancora verificato sul suo GL.iNet/Anthias.

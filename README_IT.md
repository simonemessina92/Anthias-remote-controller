# Anthias Rooms VPS — v0.1.0-dev4

Versione VPS separata, derivata da **Anthias Rooms v1.0.0 GOLDEN**. Non è una nuova
GOLDEN e non aggiorna l’estensione Chrome. Un’istanza gestisce una rete remota.

## Primo collaudo

1. Prepara una VPS vuota Debian 12/13 o Ubuntu 22.04/24.04 con accesso root e IPv4
   pubblico. Questi sono i target dell’installer; l’installazione reale non è ancora
   stata eseguita in questo ambiente di sviluppo.
2. Nel firewall del provider consenti TCP 80/443/8443, TCP 8444–8543 e UDP 443. Mantieni il tuo accesso
   SSH. Se UFW è attivo, aggiunge le sole regole mancanti per l’app senza disabilitarlo. Rifiuta porte 443/8443 occupate.
3. Copia ed estrai **tutto** il pacchetto sulla VPS. Dentro la cartella estratta esegui:

   ```bash
   sudo bash install.sh
   ```

4. Scegli `1. Install`. Inserisci IP pubblico o nome DNS e rete del tunnel
   (default `10.77.0.0/24`, modificabile se sovrapposta ad altre reti).
5. Apri `https://IP-VPS` oppure il nome DNS scelto. Il certificato iniziale è
   **autofirmato**, adatto al test: comparirà un avviso nel browser. Prima di dare
   il servizio ai clienti configura un certificato attendibile e verifica HTTPS.
6. Avvia il wizard, inserisci la **Installation setup key** stampata dall’installer
   (salvata anche in `/root/anthias-rooms-setup.txt`) e crea la password. La chiave impedisce che uno sconosciuto occupi il primo
   account appena il sito diventa raggiungibile. Nessuna password predefinita.
7. In **Connect remote router**, inserisci la LAN reale dietro il GL.iNet, per
   esempio `192.168.10.0/24`. Premi **Generate configuration**, poi **Copy configuration** per incollarlo direttamente sul router, oppure scarica il profilo.
8. Sul GL.iNet importa il file in **VPN → WireGuard Client**, attiva il collegamento
   e abilita **Allow Remote Access LAN / Allow Remote Access to the LAN Subnet**.
   Etichette e posizione dipendono dal firmware: usare la guida ufficiale sotto.
   I player devono usare il GL.iNet come gateway. Il profilo non è full tunnel:
   la normale connessione Internet del router resta sulla WAN.
9. Premi **Check connection**. Il check distingue handshake, route della LAN e raggiungibilità HTTP del router. La ricerca viene eseguita dal backend VPS; controlla tunnel e route prima di partire e mostra i tipi di errore di rete.
10. Prosegui verso i player, cerca nella subnet indicata e verifica la connessione
    a un player. Per il primo test usa file non importanti: Home → Event → Restore
    Home, poi controlla che la pulizia protegga Home.

Il DHCP del GL.iNet e il collegamento fisico LAN → switch → player sono configurati
sul router. Consigliate prenotazioni DHCP per mantenere stabili gli indirizzi.
Nessuna installazione WireGuard o modifica del sistema Anthias è prevista sui Pi.

Con il router collegato, **Open remote router** apre `https://DOMINIO-VPS:8443/`: Nginx inoltra la pagina al suo IP VPN (`10.77.0.2` con la rete predefinita). Richiede il login al pannello e resta necessario il login del GL.iNet. Abilita l’accesso remoto nel GL.iNet prima di spostare il cavo sul player; puoi mantenere accesso locale usando il Wi-Fi del router.

## Architettura

- Nginx: HTTPS TCP 443; HTTP TCP 80 reindirizza a HTTPS.
- WireGuard: UDP 443, interfaccia dedicata `arwg0`.
- Backend Python standard library: `127.0.0.1:8787`, senza Chrome e senza pip.
- SQLite: configurazione, journal, sessioni e blocchi tra browser.
- Frontend: grafica e motore Home/Event della GOLDEN, adattatori per server.
- Il browser dell’operatore non deve raggiungere la LAN remota: API e anteprime
  passano dal backend. I player non sono pubblicati su Internet.
- Profili e chiavi conservati al riavvio; ripetere la generazione sulla stessa
  subnet non rigenera chiavi né riavvia il tunnel.
- Il controllo Home/Event usa API limitate; **Access player** apre invece la GUI Anthias nativa tramite il proxy HTTPS autenticato.
- I player con autenticazione Anthias non sono ancora supportati, come nella
  GOLDEN locale. La password cloud protegge il backend, non aggiunge auth ai Pi.

## Accesso remoto alla GUI dei player

Ogni player configurato riceve una porta HTTPS univoca tra **8444 e 8543** (massimo 100 player). **Access player** è presente nelle Info e nelle Impostazioni. Il target è l’indirizzo del player salvato nel pannello: per Anthias standard è HTTP porta 80.

L’assegnazione è persistente nel database e viene aggiornata nella stessa transazione della configurazione: wizard, aggiunta manuale, discovery e import usano lo stesso percorso. Rinomina, riordino e cambio IP conservano la porta. Rimuovere un player revoca immediatamente le nuove richieste; una porta libera può essere riassegnata a un altro player. Non sovrappone porte né consente target fuori dalla LAN configurata.

Nginx prepara il range una volta durante l’installazione; a ogni richiesta il backend controlla sessione e associazione porta/player. Le porte senza associazione rispondono con accesso negato e non inoltrano nulla. Il login cloud è obbligatorio, anche per immagini, API e upload della GUI nativa. Le sessioni o gli upload già aperti vanno chiusi prima di rimuovere un player.

**Nel firewall del provider apri TCP 8444–8543**, oltre alle porte del pannello e del router. Non serve aprire porte sui Raspberry o sulla WAN del GL.iNet. Se UFW è attivo, l’installer aggiunge anche questo range e registra le proprie regole per Remove all. La rimozione elimina configurazione Nginx, associazioni del database e regole UFW create dall’installer; le regole del firewall del provider vanno gestite dal suo pannello.

La GUI nativa consente modifiche dirette al player: torna al pannello Rooms e aggiorna lo stato dopo averle effettuate. Come nelle DEV precedenti, l’autenticazione Anthias sui player non è parte del collaudo; questa versione è destinata ai player senza autenticazione API della GOLDEN.

## Comportamento di questa DEV

Conserva pubblicazione, ripristino selettivo, editor, memoria Home, notifiche e
protezioni di pulizia automatica della GOLDEN. La cancellazione manuale nella libreria consente invece di rimuovere anche file Home/Event, attivi o in elaborazione, dopo conferma esplicita. Solo dopo conferma dell’API vengono rimossi i riferimenti salvati a quel file. La rimozione di media in riproduzione può interrompere il playback. Le operazioni Home/Event sono ancora orchestrate
dal pannello: **mantieni la scheda aperta durante le operazioni**. Il backend gestisce
persistenza e trasporti; non è ancora un job runner autonomo che completa tutte le
sequenze dopo la chiusura del browser. I journal consentono la verifica e il recupero.

L’accesso del pannello è legato alla singola scheda: nuova apertura, duplicazione o ripristino della scheda richiedono la password; un refresh esplicito conserva l’accesso. Il token è mantenuto soltanto in memoria e sessionStorage, mai in localStorage. Il cookie da solo non autentica il pannello né le API di controllo.

**Esci / Logout**, visibile anche nel wizard, revoca la sessione sul server e torna al login. I token scadono comunque dopo 12 ore e il cambio password invalida tutte le sessioni. Le GUI native router/player e i trasporti video usano un cookie HttpOnly di sola sessione: richiedono almeno una scheda pannello autenticata attiva negli ultimi 90 secondi. La chiusura invia un avviso di sospensione best effort; se il browser non lo consegna, la disponibilità delle GUI decade entro 90 secondi. Riaprire il pannello richiede sempre la password. Non è consentito disabilitare la password nel cloud.
Questa DEV ha un unico account amministratore, non ruoli utenti o multi-tenant.

I blocchi tra browser valgono per questa istanza VPS. La GOLDEN locale resta
indipendente: le associazioni Home/Event salvate nel browser **non vengono
sincronizzate automaticamente** con il database cloud. Nel primo collaudo usa un
solo controller alla volta; non eseguire pulizia locale e cloud contemporaneamente.
Puoi importare una configurazione locale dopo aver completato login e rete, se gli
indirizzi dei player corrispondono alla subnet remota. I media non sono nel backup.

È presente un adattamento CSS per schermi piccoli, ma non è stato ancora eseguito
un collaudo visivo in un browser reale di questa DEV: non dichiararlo verificato.
La pagina può essere usata da un browser senza estensione; la prova concreta su
telefono e desktop è parte del prossimo collaudo.

## Manutenzione

```bash
sudo systemctl status anthias-rooms wg-quick@arwg0
```

```bash
sudo journalctl -u anthias-rooms -f
```

```bash
sudo wg show arwg0
```

Il profilo WireGuard contiene una chiave privata: trattalo come una credenziale.
Non inviare settings.json, wg-keys.json, database o profili nei report pubblici.

Per un backup coerente del database, usa l’API backup di SQLite o ferma il servizio
prima di copiare `/var/lib/anthias-rooms`. Conserva separatamente e in modo sicuro
`/etc/anthias-rooms` e `/etc/wireguard/arwg0.conf`. Non sono impostati backup periodici
automatici in questa DEV. Per certificato attendibile con dominio, è possibile
configurare Certbot/Nginx; la procedura verrà adattata al dominio del collaudo.

## Remove all

Rilancia lo stesso installer, scegli `2. Remove all` e digita `REMOVE ALL`.
Elimina applicazione, database, chiavi, tunnel, configurazione Nginx e tabella
firewall dedicati. **Non cancella contenuti sui player.** I pacchetti di sistema
condivisi (Nginx/Python/WireGuard tools) restano installati. Non elimina firewall
o servizi di altri progetti. Se l’installazione si interrompe dopo la creazione
dei componenti, la voce Remove all consente di rimuoverli prima di riprovare.

## Fonti tecniche

- WireGuard: https://www.wireguard.com/quickstart/
- GL.iNet, accesso alla LAN client dal server:
  https://docs.gl-inet.com/router/en/4/tutorials/wireguard_server_access_to_client_lan_side/
- Nginx, proxy e streaming:
  https://nginx.org/en/docs/http/ngx_http_proxy_module.html

## Verifiche

Vedi `TEST_REPORT.md` e `tests/results`. Nessun deploy o test WireGuard reale è
stato effettuato sulla VPS o sul router di Sem. Non è ancora un servizio pronto
per vendita: questa è la prima DEV da collaudare con quell’hardware.

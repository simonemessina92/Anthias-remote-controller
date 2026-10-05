# Anthias Remote Controller

Versione VPS indipendente di **Anthias Rooms**: pannello cloud per player Anthias raggiunti attraverso un router remoto WireGuard. L’estensione Chrome **v1.0.0 GOLDEN locale resta invariata**.

## Rami e release

- **develop**: sorgenti e prerelease DEV per il collaudo.
- **main**: riservato alla versione stabile; nessuna promozione senza approvazione esplicita di Sem. Al momento contiene soltanto il README iniziale.
- Ogni DEV pubblicata ha tag, ZIP, bootstrap e checksum SHA-256 nella sezione [Releases](https://github.com/simonemessina92/Anthias-remote-controller/releases). GitHub Actions esegue i test prima della pubblicazione. Gli asset già pubblicati non vengono sovrascritti: per modifiche successive si incrementa la DEV.

## Installazione e gestione sulla VPS

Su Debian 12/13 o Ubuntu 22.04/24.04, come root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/simonemessina92/Anthias-remote-controller/develop/bootstrap.sh)
```

Il bootstrap scarica il pacchetto della DEV indicata nel suo script, ne verifica il checksum, estrae i file temporanei e apre il menu:

```text
1. Install
2. Remove all
```

I download temporanei vengono rimossi quando il menu termina. Dopo l’installazione lo stesso menu è disponibile anche senza Internet:

```bash
bash /opt/anthias-rooms/install.sh
```

Il bootstrap usa il menu locale se trova un’installazione gestita. Non sovrascrive un’istanza già configurata: per passare a una nuova DEV esegui Remove all, poi rilancia il comando curl. La rimozione elimina database, credenziali, configurazione, tunnel e accessi HTTPS; dopo la reinstallazione devi importare il nuovo profilo WireGuard sul router. I file sui player restano.

## Porte

| Uso | Porta VPS |
|---|---|
| Pannello | TCP 443 |
| Redirect HTTPS | TCP 80 |
| WireGuard | UDP 443 |
| GUI router | TCP 8443 |
| GUI player, assegnazione automatica | TCP 8444–8543 |

Apri le porte nel firewall del provider. UFW attivo viene mantenuto e l’installer registra le sole regole aggiunte per poterle rimuovere. Il certificato iniziale è autofirmato per il collaudo.

## Accesso

Password obbligatoria. Nuova scheda → login; refresh → sessione mantenuta; **Esci / Logout** → revoca immediata della sessione. Il cookie non consente accesso automatico al pannello. GUI native router/player disponibili mentre è attiva una sessione del pannello.

Il primo wizard richiede la setup key riportata dall’installer e salvata in `/root/anthias-rooms-setup.txt`. Poi genera il profilo del router per la LAN remota, copialo/scaricalo e importalo in GL.iNet abilitando Allow Remote Access LAN.

Documentazione completa: [README_IT.md](README_IT.md), [TEST_REPORT.md](TEST_REPORT.md), [CHANGELOG.md](CHANGELOG.md).

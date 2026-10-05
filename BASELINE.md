# Origine

Questo progetto è un alter ego VPS separato da Anthias Rooms v1.0.0 GOLDEN locale.
Sorgente approvato: Anthias_Rooms_v1.0.0_GOLDEN.zip.
SHA-256: 4f8a36720e30f1389f026ea7ca5b4066e2b74d45303aa228ca5045794ef50192.
La GOLDEN non viene aggiornata, rimossa o sovrascritta dall’installer VPS.

`logic.js`, `lifecycle.js`, `storage.js`, `discovery.js`, `editor-state.js`,
`media-library.js` e icone provengono byte-identici dalla GOLDEN. I suffissi delle
chiavi storiche sono conservati. L’adattatore VPS fornisce storage e blocchi remoti;
non è richiesta alcuna API Chrome nel browser dell’operatore.

La shell background/manifest Chrome non è distribuita né installata sul server.
Versione del nuovo progetto: 0.1.0-dev4; nessuna promozione GOLDEN implicita.

La cancellazione manuale estesa è implementata in `manual-delete.js`, separata dalle protezioni di cleanup automatico della GOLDEN.

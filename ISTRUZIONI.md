# Duetto – istruzioni

## 1. Pubblicare su GitHub Pages
1. Carica tutti i file nel repository `duetto` (compresa la cartella `.github`).
2. Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.

## 2. Creare il ponte Cloudflare (per "I tuoi canali")
1. Crea un account gratuito su https://dash.cloudflare.com/sign-up
2. Menu a sinistra: **Compute (Workers)** → **Workers & Pages** → **Create** → **Start with Hello World** → nome `duetto` → **Deploy**.
3. Premi **Edit code**, cancella tutto, incolla il contenuto di `cloudflare-worker.js`, premi **Deploy**.
4. Copia l'indirizzo, tipo `https://duetto.TUONOME.workers.dev`.
5. In `index.html` cerca `const WORKER_URL='';` e incollalo tra gli apici.

Prova: apri `https://duetto.TUONOME.workers.dev/?u=@madfit` → devi vedere un elenco di video.

## 3. Libreria consigliata
Modifica `config.json` (playlist_fisse e canali). Si aggiorna da sola ogni 8 ore.
Per aggiornare subito: Actions → Aggiorna video → Run workflow.

## 4. Farsi trovare su Google
1. Vai su https://search.google.com/search-console e aggiungi il sito (tipo "Prefisso URL").
2. Verifica con il metodo "Tag HTML": incolla il tag nel `<head>` di `index.html`.
3. In **Sitemap** inserisci `sitemap.xml` e invia.
Google impiega da qualche giorno a qualche settimana per mostrare il sito.

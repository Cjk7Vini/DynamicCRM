# Mini CRM voor Zapier + Oracle

Dit is een kant‑en‑klare, lichte API die leads opvangt (bijv. via clickables in video reels), ze opslaat in Oracle Database **en** optioneel doorstuurt naar een **Zapier Webhook**.

## Snel starten

1) Installeer Node.js >= 20 op je VM of host.  
2) Maak in Oracle (PDB) een schema en tabel met `sql/setup.sql`.  
3) Kopieer `.env.example` naar `.env` en vul je databasegegevens + Zapier Hook in.  
4) Start de server: `npm install && npm start`  
5) Test via `http://<host>:3000/` (formuliertje) of POST naar `/leads`.

### Endpoints
- `POST /leads` — body: `{ fullName, email, phone?, notes?, consent?(bool), source? }`
- `GET /leads` — lijst van leads (zonder auth, zet achter je eigen VPN/firewall of voeg auth toe)
- `GET /health` — simpele healthcheck

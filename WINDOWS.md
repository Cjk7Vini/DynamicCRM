# Windows - supersnel starten

1) Installeer Node.js LTS (v20 of hoger) op je Windows host.
2) Pak deze map uit, open PowerShell in de map en run:
   npm install
3) Maak een .env (kijk naar .env.example) en zet je Oracle CONNECT_STRING, bijv.:
   ORACLE_CONNECT_STRING=localhost:1522/FREEPDB1
4) Test database-verbinding:
   npm run test:db
5) Start de server:
   npm start
6) Voorbeeld insert (optioneel):
   npm run seed

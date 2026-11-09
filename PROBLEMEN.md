# Openstaande problemen

Alleen wat nog **niet** is opgelost. Werkwijze:
1. Elk probleem heeft een volgende stap en een controle waarmee je ziet dat het opgelost is.
2. Is de controle goed, haal het probleem dan hier weg en zet de les (oorzaak, oplossing, hoe herkennen) in `KENNISBANK.md`.
3. Nieuwe problemen komen onderaan, met datum.

Laatst bijgewerkt: 9 november 2026.

---

## P1. Meta-app staat nog in ontwikkelmodus (App Review niet gedaan)
- **Gevolg:** alleen mensen met een rol in de app kunnen koppelen; elke nieuwe gebruiker moet tester worden (met een Meta-ontwikkelaarsaccount).
- **Volgende stap:** opnames maken en de App Review indienen voor alle rechten (draaiboek en Engelse teksten zijn klaar). Access Verification (Tech Provider) moet goedgekeurd zijn; deadline 3 januari 2027.
- **Opgelost als:** de rechten zijn goedgekeurd, de app staat op "Live", en een nieuwe klant kan koppelen zonder testerrol.
- **Daarna:** alle werkplekken één keer opnieuw laten koppelen; controleren met `/api/mkt/meta/assets-debug`.

## P2. Serac loopt via een uitzondering
- **Gevolg:** Instagram van Serac loopt via een losse Instagram-login als tester; het Facebook-token van Serac is op 20 oktober 2026 verlopen.
- **Volgende stap:** na P1 Serac volledig via de standaardroute (bedrijfsportfolio van Dynamic, inclusief Instagram) koppelen, en de uitzondering uit `CLAUDE.md` halen.
- **Opgelost als:** Serac werkt zonder Instagram-login en zonder tester, met een geldig token.

## P3. Werkplekken met een token zonder publiceerrechten
- **Gevolg:** publiceren en automatisch plaatsen geven code 10 in deze werkplekken.
- **Bekend (8 november 2026):**
  - werkplek van Wendy (5): token heeft de publiceerrechten nooit gehad;
  - werkplek van Dynamic: hangt aan het Facebook-account van Fleur, met de rechten nog op "declined".
- **Volgende stap:** de eigenaar van elke werkplek klikt één keer op **Werkplek-koppeling, Koppel met Facebook** en staat alles toe.
- **Opgelost als:** `/api/mkt/meta/assets-debug` in die werkplek toont `instagram_content_publish` en `pages_manage_posts` bij `granted`, en de controle vooraf op het bord staat op "Klaar".

## P4. Nog niet echt getest bij Meta
- **Video naar een Facebook-pagina** (`/videos` met `file_url`): alleen getest met nagebootste antwoorden.
- **Omslag bij een Reel** (`cover_url`): alleen getest met nagebootste antwoorden.
- **Volgende stap:** op een testaccount één video naar Facebook en één Reel met omslag plaatsen.
- **Opgelost als:** beide staan goed online (video speelt af op de pagina; de omslag is zichtbaar in het profiel), of de melding is bekend en verwerkt.

## P5. Leads van Serac en Vitaal Fysiotherapie: komen ze weer binnen?
- **Achtergrond:** de formulieren weigerden telefoonnummers met streepjes of +31; opgelost op 9 november 2026 (zie `KENNISBANK.md`).
- **Volgende stap:** een week de leads volgen, en in de logs van de webservice zoeken op `POST /leads 400`.
- **Opgelost als:** er weer leads binnenkomen bij dezelfde advertenties en er (bijna) geen `POST /leads 400` meer is. Blijft het stil bij Serac, dan ligt het aan het aanbod of de advertenties, niet aan het formulier.

## P6. Verschil tussen leads in Meta en in de database is niet te verklaren als er leads verwijderd worden
- **Gevolg:** een verwijderde lead laat geen spoor na, terwijl Meta hem blijft tellen.
- **Voorstel:** leads archiveren in plaats van verwijderen (met wie en wanneer), en in de workspace naast de leads van Meta ook de echte leads uit de database tonen, met de kosten per echte lead.
- **Opgelost als:** de eigenaar heeft gekozen en het is gebouwd, of besloten dat het niet nodig is.

## P7. Voorwaarden van Meta nalopen vóór het live gaan
- **Volgende stap:** het privacybeleid en `/data-deletion.html` naast de actuele voorwaarden leggen (zie `KENNISBANK.md`, Wat mag); controleren dat bij ontkoppelen of opzeggen van een klant de tokens en gegevens worden verwijderd; nagaan welke gegevens via de Conversions API meegaan bij zorgpraktijken.
- **Opgelost als:** het is nagelopen en waar nodig aangepast.

## P8. Idee zonder beeld kan niet worden opgeslagen (melding van Wendy)
- **Stand:** niet na te doen; in de code is een beeld niet verplicht.
- **Volgende stap:** een screenshot van de melding van Wendy.
- **Opgelost als:** de oorzaak is gevonden en verholpen, of blijkt dat het werkt.

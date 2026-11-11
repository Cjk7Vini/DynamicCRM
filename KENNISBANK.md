# Kennisbank

Blijvende kennis uit opgeloste problemen: wat de oorzaak was, hoe het is opgelost, en hoe je het herkent als het terugkomt. Plus de grenzen van Meta en wat volgens de voorwaarden mag.

- Openstaande problemen staan in `PROBLEMEN.md`. Is een probleem opgelost, dan gaat het daaruit en komt de les hier.
- De vaste werkafspraken en definities staan in `CLAUDE.md`.

---

## Meta: publiceren en rechten

### Rechten uit de Meta-app halen zet ze bij iedereen op "declined" (november 2026)
- **Wat je ziet:** publiceren geeft "code 10" (rechtenfout) bij alle gebruikers tegelijk, ook bij posts die eerder werkten. Opnieuw inloggen bij Facebook lijkt te lukken, maar vraagt het recht niet opnieuw.
- **Oorzaak:** wordt een recht uit de app gehaald, dan trekt Meta het in bij iedereen. In het token staat het daarna op "declined". Een recht op "declined" vraagt Facebook bij een gewone login nooit opnieuw. De nachtelijke verlenging van tokens houdt de oude rechten.
- **Opgelost met:**
  - de rechten weer aan de app toevoegen;
  - `META_LOGIN_SCOPES` in Render met alle benodigde rechten;
  - de login stuurt `auth_type=rerequest` mee (sinds 7 november 2026), zodat Facebook geweigerde rechten opnieuw vraagt;
  - het scherm na het koppelen toont per recht of het verleend is;
  - de controle vooraf op het bord ("Klaar" of "Niet klaar") meldt een ontbrekend recht vóór het geplande moment.
- **Herkennen en verhelpen:**
  1. Open `/api/mkt/meta/assets-debug` in de werkplek: staat het recht bij `declined` of ontbreekt het, dan is dit de oorzaak.
  2. Controleer in het Meta-dashboard dat het recht aan de app hangt.
  3. De eigenaar van de werkplek klikt één keer op **Werkplek-koppeling, Koppel met Facebook** en staat alles toe.
  4. Heeft een klant een eigen token, dan bij die klant: Meta wissen, Accounts ophalen uit werkplek-login, Koppelingen opslaan.
- **Les:** nooit een recht uit de Meta-app verwijderen zonder eerst in de code te controleren of het gebruikt wordt.

### Een eigen token bij een klant gaat voor het token van de werkplek
- Opnieuw koppelen van de werkplek helpt niet voor een klant met een eigen (oud) token. Het Koppelingen-overzicht (kolom Token) laat zien welke klanten een eigen token hebben.

### Tokens en verlopen
- Bij het koppelen wordt het korte Facebook-token omgeruild voor een token van ongeveer 60 dagen; de cron `/api/mkt/cron/refresh-meta-tokens` verlengt het automatisch (met dezelfde rechten).
- Een token dat nooit is omgeruild, verloopt binnen uren of dagen. Oplossing: opnieuw koppelen.

### Testers zolang de app in ontwikkelmodus staat
- Alleen iemand met een rol in de app kan koppelen. Sinds november 2026 eist Meta daarvoor een gratis Meta-ontwikkelaarsaccount, ook voor testers. Toevoegen op naam werkt niet ("does not resolve to a valid user ID"): gebruik de gebruikersnaam of het numerieke ID. Werkwijze: zie `CLAUDE.md`, App review en live gaan.
- Instagram-testers (voor "Koppel via Instagram") zijn een aparte rol; accepteren gaat op instagram.com in de browser.

---

## Meta: publiceren, wat er technisch kan

- **Instagram:** bericht (beeld), Reel (video), story (`media_type=STORIES`, zonder tekst), carrousel (2 tot 10 bestanden) en story-reeks (2 tot 10 losse stories na elkaar). Allemaal ook automatisch via de planner.
- **Een story-reeks bestaat via de API altijd uit losse stories:** er is geen "reeks" bij Meta. Elke story telt mee in het maximum van 50 per 24 uur.
- **Facebook-pagina:** foto (`/photos`), video (`/videos` met `file_url`) en tekst (`/feed`). Een story of carrousel kan niet naar Facebook.
- **Reel-omslag:** `cover_url`, altijd als JPEG van max 1080 breed aangeleverd; weigert Instagram de omslag, dan wordt de Reel zonder omslag geplaatst, met een waarschuwing. Facebook kiest zelf het voorbeeldbeeld van een video.
- **Muziek uit de Instagram-bibliotheek kan niet via de API**, bij geen enkele tool. Zet de muziek vóór het uploaden in de video.
- **Maximum per Instagram-account:** Meta noemt 50 posts via de API per voortschrijdende 24 uur (een carrousel telt als één). Het echte getal per account: `GET /<IG_USER_ID>/content_publishing_limit` ([referentie](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit), [publicatiegids](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing)).
- **Bestanden moeten via een openbare URL** komen (onze beeldopslag); video's worden eerst door Instagram verwerkt.

---

## Meta: cijfers

### Advertentiecijfers: altijd alle pagina's ophalen
- Meta geeft standaard maar 25 regels per pagina. Zonder alle pagina's te volgen, vallen campagnes, ad sets of advertenties stil weg. Altijd `graphGetAll`.
- Gepauzeerde ad sets hebben in de gekozen periode geen cijfers; ze krijgen een apart veld "totaal sinds start" dat nooit meetelt in de periodetotalen.

### Leads: Meta telt anders dan de database
- **Zelfde periode, zelfde getal:** de workspace toont precies wat Meta teruggeeft. Verschilt het met Advertentiebeheer, controleer dan eerst of de periode gelijk is (bij Serac: 15 in "afgelopen 30 dagen" tegenover 18 in "Maximum").
- **Meta tegenover de database:** Meta rekent een lead toe aan de advertentie (standaard 7 dagen na klikken, 1 dag na bekijken), telt op de dag van de advertentie, en telt voor mensen die tracking hebben uitgezet een geschat aantal bij. De database telt echte inzendingen.
- **Een lead verwijderen in het dashboard** verwijdert ook de `lead_events`: er blijft geen spoor over, maar Meta blijft hem tellen.
- **Het Lead-event** gaat alleen af na een echte inzending: op de bedankpagina met een echt lead-ID, en via de server (Conversions API) met hetzelfde event-ID, zodat Meta het samenvoegt tot één lead. Een formulier openen telt niet.
- **Advies:** reken de kosten per lead op de echte leads uit de database.

### Leads meetbaar maken tegenover Meta (november 2026)
- **Wat er mis was:** de server probeerde de klik-ID's van Facebook (`_fbc`, `_fbp`) mee te sturen naar Meta, maar las ze uit `req.cookies`, dat zonder cookie-parser altijd leeg is. Meta kreeg van de server dus nooit een klik-ID en moest meer schatten. Per lead werd ook niets bewaard om hem met Meta te vergelijken, en een verwijderde lead liet geen spoor na.
- **Opgelost met (migratie 035):** de cookies worden nu echt gelezen en meegestuurd; het telefoonnummer gaat met landcode naar Meta; per lead worden event-ID, fbclid en UTM bewaard; verwijderen laat een spoor na zonder persoonsgegevens.
- **Controleren:** in Events Manager stijgt de "Event Match Quality" van het Lead-event. Vergelijken per praktijk:
  ```sql
  SELECT 'binnen' AS soort, count(*) FROM public.leads WHERE praktijk_code = '<CODE>' AND aangemaakt_op >= '<DATUM>'
  UNION ALL
  SELECT 'verwijderd', count(*) FROM public.leads_verwijderd WHERE praktijk_code = '<CODE>' AND aangemaakt_op >= '<DATUM>';
  ```
  Binnen plus verwijderd is het aantal echte inzendingen; dat hoort dicht bij het aantal ontvangen Lead-events in Events Manager te liggen.

---

## Leadformulieren

### Telefoonnummers werden geweigerd (tot november 2026)
- **Wat je zag:** veel klikken op de advertenties maar (bijna) geen leads; de bezoeker kreeg alleen "Er ging iets mis".
- **Oorzaak:** de server accepteert alleen cijfers; vier formulieren stuurden het nummer zoals ingetypt ("06-12345678", "+31 6 ...").
- **Opgelost met:** de formulieren sturen alleen cijfers en geven een melding bij het veld; de server trekt elk nummer gelijk (`normalizePhoneNL`, terugdraaien met `LEADS_PHONE_NORMALIZE=0`).
- **Herkennen:** zoek in de logs van de webservice op `POST /leads 400`.

---

## Database en migraties

### Een migratie die nooit is gedraaid valt niet op
- De code slaat een ontbrekende kolom bewust stil over (zodat alles blijft werken). Gevolg in november 2026: migratie 012 ontbrak, en een carrousel viel na opslaan steeds terug naar "Bericht", zonder foutmelding.
- **Controle:** een query op `information_schema` die per migratie laat zien welke kolom of tabel ontbreekt. Geeft hij niets terug, dan staat alles erin.

---

## Wat mag volgens de voorwaarden van Meta

Samenvatting om de werkwijze op af te stemmen, geen juridisch advies. Leidend: [Meta Platform Terms](https://developers.facebook.com/terms/), [Developer Policies](https://developers.facebook.com/devpolicy/), [FAQ bij de Platform Terms](https://developers.facebook.com/documentation/development/terms-and-policies/faqs).

**Mag (mits het hieronder klopt)**
- Een bureau koppelt met toestemming (Facebook Login) de pagina's, Instagram-accounts en advertentieaccounts van klanten, bekijkt de cijfers, publiceert en beheert campagnes. Elk recht moet via de App Review worden aangevraagd met uitleg en een opname.
- De workspace bedient andere bedrijven en valt daarmee onder de regels voor een **Tech Provider**. Daarvoor zijn de bedrijfsverificatie en de Access Verification nodig.
- Cijfers tonen aan het bureau en de klant van wie ze zijn, en daar analyses en AI-teksten op baseren, binnen het doel van de toestemming.
- De Conversions API voor leads, met gehashte e-mailadressen en telefoonnummers (SHA-256).

**Moet**
- Een openbaar privacybeleid dat uitlegt welke gegevens van Meta we gebruiken en waarvoor.
- Uitleg hoe iemand gegevens laat verwijderen (`/data-deletion.html`) en verwijderverzoeken echt en tijdig uitvoeren ([Meta-blog](https://developers.facebook.com/blog/post/2024/11/15/user-data-deletion-requests/)). Samenvattingen van de voorwaarden noemen 90 dagen ([samenvatting](https://conductatlas.com/platform/meta/meta-platform-policy/90-day-platform-data-deletion-obligation/), niet de officiele tekst).
- Gegevens niet langer bewaren dan nodig; bij ontkoppelen of opzeggen de tokens en gegevens van die klant verwijderen.
- Werkplekken strikt gescheiden houden; met de hand ingevulde ID's van een andere organisatie zijn niet toegestaan.
- Gevoelige gegevens (gezondheid, locatie) alleen met toestemming. Bij zorg- en sportpraktijken extra opletten wat er in leadformulieren en de Conversions API meegaat.

**Mag niet**
- Gegevens van Meta verkopen, verhuren of doorgeven, of gebruiken voor een ander doel dan de toestemming ([samenvatting](https://conductatlas.com/platform/meta/meta-platform-policy/prohibited-uses-of-platform/), niet de officiele tekst).
- Gegevens verzamelen door te scrapen of buiten de API om.
- Aangepaste cijfers tonen als cijfers van Meta zonder dat te vermelden (onze correctieregels zijn gemeten, staan in `CLAUDE.md` en hebben een noodknop).
- Rechten gebruiken voor een ander doel dan in de App Review is opgegeven.

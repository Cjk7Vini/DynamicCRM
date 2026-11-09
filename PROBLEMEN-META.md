# Problemen met Meta (Instagram en Facebook): wat er gebeurde, wat we deden, en wat mag

Dit document legt de problemen vast die we in oktober en november 2026 hadden met de koppeling met Meta (Instagram, Facebook en advertenties). Per probleem staat er wat er gebeurde, wat de oorzaak was, wat we hebben gedaan en hoe je het controleert als het weer gebeurt. Onderaan staat wat technisch niet kan, en wat volgens de voorwaarden van Meta wel en niet mag.

De vaste werkafspraken en definities staan in `CLAUDE.md`. Dit document is de geschiedenis en de uitleg erachter.

---

## 1. Publiceren gaf "code 10" (rechtenfout), bij iedereen tegelijk

**Wat gebeurde er**
- Tot en met 22 oktober plaatste de planner posts gewoon automatisch. Vanaf begin november mislukte publiceren bij alle testers met "Instagram weigert het publiceren (rechtenfout, code 10)". Ook "Nu publiceren" faalde.
- Opnieuw inloggen bij Facebook leek te lukken, maar Facebook vroeg de ontbrekende rechten niet opnieuw.

**Oorzaak (gemeten)**
- Begin november zijn rechten uit de Meta-app gehaald, op een fout advies bij de voorbereiding van de app review. Meta trekt dan die rechten in bij iedereen die gekoppeld is. In het token van Fleur stonden daarna `instagram_content_publish`, `pages_manage_ads`, `instagram_manage_comments`, `leads_retrieval` en `instagram_manage_contents` allemaal op "declined".
- Een recht dat op "declined" staat, vraagt Facebook bij een gewone login nooit opnieuw. Daarom kwam er geen vraag bij opnieuw inloggen.
- `pages_manage_posts` (posten op een Facebook-pagina) zat er nooit in, omdat de login dat recht niet vroeg.
- De nachtelijke verlenging van tokens (cron) houdt de rechten die het token al had. Een verlengd token krijgt er dus geen rechten bij.
- Een eigen token bij een klant gaat voor het token van de werkplek. Opnieuw koppelen van de werkplek helpt dan niet voor die klant.

**Wat we gedaan hebben**
- De rechten weer aan de app toegevoegd ("Ready for testing").
- `META_LOGIN_SCOPES` in Render gezet met alle benodigde rechten, inclusief `instagram_content_publish`, `pages_manage_posts` en `pages_manage_ads`.
- De login stuurt `auth_type=rerequest` mee (sinds 7 november), zodat Facebook ook eerder geweigerde rechten opnieuw vraagt.
- Het scherm na het koppelen toont per recht of het verleend is.
- Meetlink `/api/mkt/meta/assets-debug`: laat zien welke rechten het token van de gekozen werkplek echt heeft (`granted` en `declined`) en wanneer het verloopt.
- Fleur heeft op 8 november opnieuw gekoppeld; daarna stonden alle publiceerrechten op `granted` en werkte publiceren weer.
- Controle vooraf op het bord (PR #238): bij elke geplande post staat "Klaar" of "Niet klaar" met de reden, zodat een ontbrekend recht niet pas op het moment van plaatsen opvalt.

**Hoe controleren / wat doen als het weer gebeurt**
1. Open `/api/mkt/meta/assets-debug` in de betreffende werkplek. Ontbreekt een recht of staat het op `declined`, dan is dat de oorzaak.
2. Controleer in het Meta-dashboard dat het recht aan de app hangt ("Ready for testing" of na de review "Advanced access").
3. Laat de eigenaar van de werkplek één keer op **Werkplek-koppeling, Koppel met Facebook** klikken en alles toestaan.
4. Heeft een klant een eigen token (Koppelingen-overzicht, kolom Token), dan bij die klant: Meta wissen, Accounts ophalen uit werkplek-login, Koppelingen opslaan.
5. **Nooit** rechten uit de Meta-app verwijderen zonder te controleren of de code ze gebruikt. Dat zet ze bij iedereen op "declined".

---

## 2. Testers konden niet koppelen of niet worden toegevoegd

**Wat gebeurde er**
- Zolang de app in ontwikkelmodus staat, kan alleen iemand met een rol in de app (tester, ontwikkelaar of beheerder) koppelen.
- Sinds november 2026 eist Meta een (gratis) Meta-ontwikkelaarsaccount, ook voor testers. Toevoegen op naam gaf "does not resolve to a valid user ID".
- Instagram-testers (voor "Koppel via Instagram") zijn een aparte rol.

**Wat we gedaan hebben**
- Werkwijze vastgelegd in `CLAUDE.md` (registreren op developers.facebook.com, toevoegen met gebruikersnaam of numeriek ID, accepteren op developers.facebook.com/requests; Instagram-testers accepteren op instagram.com in de browser).
- Serac tijdelijk via een Instagram-login als tester laten lopen, omdat het Instagram-account in testmodus niet mee kon in de rechten van het bedrijfsportfolio (zie `CLAUDE.md`, Klantsituaties).

**Structurele oplossing**: de Meta App Review. Na goedkeuring en "Live" kan elk bureau en elke klant koppelen zonder rol in de app.

---

## 3. Leads: Meta telt er meer dan er in de database staan (Serac)

**Wat gebeurde er**
- Workspace (afgelopen 30 dagen): 15 leads. Advertentiebeheer van Meta: 18. Database (portaal): 12.

**Oorzaak (gemeten)**
- 15 tegenover 18 was alleen een andere periode: met dezelfde periode ("Maximum") toont de workspace ook 18. De workspace toont dus precies wat Meta teruggeeft.
- Meta tegenover database:
  - Meta rekent een lead toe aan de advertentie die iemand zag of aanklikte (standaard 7 dagen na klikken, 1 dag na bekijken) en telt op de dag van de advertentie, niet van de inzending.
  - Voor mensen die tracking hebben uitgezet (o.a. iPhone, geweigerde cookies) telt Meta een geschat aantal conversies bij. Die bestaan niet als echte persoon.
  - Een lead die in het dashboard wordt verwijderd, laat geen spoor na (ook de `lead_events` worden verwijderd), maar Meta blijft hem tellen.
  - Alle formulieren delen één pixel en één bedankpagina; per praktijk is er een eigen conversie op `thankyou.html?s=CODE`.
- Het Lead-event gaat alleen af na een echte inzending: op de bedankpagina met een echt lead-ID, en via de server (Conversions API) met hetzelfde event-ID, zodat Meta browser en server samenvoegt tot één lead. Een formulier openen telt niet als lead.

**Wat we gedaan hebben**
- Uitgezocht en uitgelegd (geen codefout in de telling).
- Laadindicator in Campagnes en Rapportage (PR #234), omdat ophalen bij Meta 10 tot 30 seconden kan duren.

**Advies**: reken de kosten per lead op de echte leads uit de database; de leads van Meta zijn een toeschrijving met schattingen en zullen nooit precies 1 op 1 zijn.

---

## 4. Leads vielen weg sinds 31 oktober (formulieren weigerden telefoonnummers)

**Wat gebeurde er**
- Serac en Vitaal Fysiotherapie kregen in november 0 leads, terwijl de campagnes liepen en goed werden aangeklikt.

**Oorzaak (gemeten)**
- De server accepteert een telefoonnummer alleen als cijfers. Vier formulieren (Serac, Fysio Faster, Gezond & Vitaal Krommenie, Vitaal Fysiotherapie) stuurden het nummer zoals ingetypt. "06-12345678" (het voorbeeld in het veld), "06 1234 5678" en een automatisch ingevuld "+31 6 ..." werden geweigerd met alleen "Er ging iets mis". Mensen haakten af.
- Dit is geen fout van Meta, maar het verklaarde een groot deel van het verschil tussen klikken en leads.

**Wat we gedaan hebben**
- De vier formulieren sturen alleen de cijfers en geven een duidelijke melding bij het veld (PR #235, #236).
- De server trekt elk nummer gelijk (`normalizePhoneNL`): alleen cijfers, +31 / 0031 / 31 wordt 0. Terugdraaien: `LEADS_PHONE_NORMALIZE=0`.
- Controle: zoek in de logs van de webservice op `POST /leads 400` (geweigerde inzendingen).

---

## 5. Publiceren: wat Meta wel en niet ondersteunt

**Problemen die we tegenkwamen en oplosten**
- Video naar een Facebook-pagina ging als tekst zonder video. Opgelost: video via de video-route van Meta (`/videos` met `file_url`, PR #232). Nog één echte test nodig.
- Een story werd als gewone post geplaatst en de planner plaatste geen carrousels. Opgelost: story als `media_type=STORIES`, carrousel via dezelfde route als Nu publiceren (PR #239).
- Opslaan van een al geplaatste post liet de planner hem opnieuw plaatsen (dubbele post). Opgelost (PR #232).
- Een eigen omslag bij een Reel (`cover_url`, PR #242). Beveiligd (PR #243): altijd als JPEG van max 1080 breed, en weigert Instagram de omslag, dan wordt de Reel toch geplaatst zonder omslag, met een waarschuwing.
- Publiceren naar Instagram en Facebook tegelijk, zonder dubbel plaatsen bij een nieuwe poging (PR #232, migratie 032).

**Grenzen van Meta (kan niet, bij geen enkele tool)**
- **Muziek uit de Instagram-bibliotheek toevoegen kan niet via de API.** Muziek moet vóór het uploaden in de video zitten.
- **Een story of carrousel kan niet naar een Facebook-pagina** via deze route; de workspace weigert dat met een duidelijke melding.
- **Facebook kiest zelf het voorbeeldbeeld van een video**; de Reel-omslag geldt alleen voor Instagram.
- **Er is een maximum aantal posts per Instagram-account per 24 uur via de API.** Meta noemt 50 per voortschrijdende 24 uur in de referentie (andere pagina's noemen 100); een carrousel telt als één post. Het echte getal per account is op te vragen via `GET /<IG_USER_ID>/content_publishing_limit` ([referentie](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit), [publicatiegids](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing)).
- **Instagram accepteert alleen bestanden van een openbare URL** (onze beeldopslag) en verwerkt video's eerst; dat kan even duren.

---

## 6. Advertentiecijfers: campagnes en ad sets vielen weg

**Wat gebeurde er**: niet alle campagnes, ad sets of advertenties kwamen in de workspace; gepauzeerde ad sets toonden niets.

**Oorzaak**: Meta geeft standaard maar 25 regels per pagina. Gepauzeerde ad sets hebben in de gekozen periode geen cijfers.

**Wat we gedaan hebben**: alle lijsten en cijfers via `graphGetAll` (volgt alle pagina's), en voor ad sets zonder cijfers in de periode een apart veld "totaal sinds start" dat nooit meetelt in de periodetotalen (zie `CLAUDE.md`, Advertentiecijfers).

---

## 7. Tokens verlopen

- Een gewoon Facebook-token is kort geldig; de workspace ruilt het bij het koppelen om voor een token van ongeveer 60 dagen, en de cron `/api/mkt/cron/refresh-meta-tokens` verlengt het automatisch.
- Een token dat nooit is omgeruild (zoals bij Serac op 20 oktober) verloopt binnen een paar uur tot dagen. Oplossing: opnieuw koppelen.
- Het Koppelingen-overzicht toont per klant wanneer het token verloopt; de controle vooraf meldt een verlopen koppeling bij geplande posts.
- Na de app review: Facebook Login for Business met systeemgebruiker-tokens overwegen; die verlopen niet.

---

## 8. Wat mag volgens de voorwaarden van Meta

Dit is een samenvatting om de werkwijze op af te stemmen, geen juridisch advies. Leidend zijn de officiele teksten: [Meta Platform Terms](https://developers.facebook.com/terms/), [Developer Policies](https://developers.facebook.com/devpolicy/) en de [FAQ bij de Platform Terms](https://developers.facebook.com/documentation/development/terms-and-policies/faqs).

**Wat wij doen en mag (mits de voorwaarden hieronder kloppen)**
- Een bureau koppelt met toestemming (Facebook Login) de pagina's, Instagram-accounts en advertentieaccounts van zijn klanten, en ziet daarvan de cijfers en kan namens de klant publiceren en campagnes beheren. Dat is precies waarvoor de rechten bestaan; elk recht moet via de App Review worden aangevraagd met uitleg en een opname.
- Omdat de workspace andere bedrijven bedient, valt de app onder de regels voor een **Tech Provider**: een app waarvan het hoofddoel is dat gebruikers het platform en hun gegevens kunnen gebruiken. Daarvoor zijn de bedrijfsverificatie (klaar) en de Access Verification (in behandeling) nodig.
- Cijfers tonen aan het bureau en de klant van wie de gegevens zijn, en daar analyses en AI-teksten op baseren, binnen het doel waarvoor toestemming is gegeven.
- De Conversions API gebruiken voor leads, met gehashte e-mailadressen en telefoonnummers (SHA-256), zoals de server doet.

**Wat moet**
- Een openbaar **privacybeleid** dat uitlegt welke gegevens we van Meta gebruiken en waarvoor.
- Uitleg hoe iemand **gegevens kan laten verwijderen** (onze pagina `/data-deletion.html`) en verwijderverzoeken echt en tijdig uitvoeren. Meta stuurt verwijderverzoeken van gebruikers door naar de ontwikkelaar ([Meta-blog over verwijderverzoeken](https://developers.facebook.com/blog/post/2024/11/15/user-data-deletion-requests/)); volgens samenvattingen van de voorwaarden moet dat binnen 90 dagen ([samenvatting](https://conductatlas.com/platform/meta/meta-platform-policy/90-day-platform-data-deletion-obligation/), niet de officiele tekst).
- Gegevens alleen bewaren zolang ze nodig zijn voor het doel; bij het ontkoppelen of opzeggen van een klant de opgeslagen tokens en gegevens van die klant verwijderen.
- Werkplekken strikt gescheiden houden (zie `CLAUDE.md`): gegevens van de ene klant of het ene bureau mogen nooit bij een ander terechtkomen. Met de hand ingevulde ID's van een andere organisatie zijn niet toegestaan.
- Voor gevoelige gegevens (zoals gezondheid of locatie) alleen met toestemming; bij onze praktijken (zorg en sport) extra opletten wat er in leadformulieren en in de Conversions API meegaat.

**Wat niet mag**
- Gegevens van Meta **verkopen, verhuren of doorgeven** aan derden, of gebruiken voor iets anders dan het doel waarvoor toestemming is gegeven ([samenvatting verboden gebruik](https://conductatlas.com/platform/meta/meta-platform-policy/prohibited-uses-of-platform/), niet de officiele tekst).
- Gegevens verzamelen via scrapen of buiten de API om.
- Cijfers presenteren als van Meta terwijl wij ze hebben aangepast, zonder dat te vermelden. Onze correctieregels (bijv. dubbel getelde gedeelde interacties) zijn gemeten, staan in `CLAUDE.md` en hebben een noodknop.
- Rechten gebruiken die niet zijn goedgekeurd voor het doel dat in de App Review is opgegeven.

**Na de goedkeuring van de App Review**
- App op "Live" zetten, alle werkplekken één keer opnieuw laten koppelen, controleren dat elke klant via de standaardroute werkt (zonder testers of uitzonderingen) en de tijdelijke uitzondering voor Serac verwijderen.
- Het privacybeleid en de pagina voor gegevensverwijdering nog eens langslopen tegen de actuele voorwaarden.

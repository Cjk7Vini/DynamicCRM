# DynamicCRM: werkafspraken en vaste kennis

Dit bestand wordt in elke sessie ingelezen. Houd het actueel.

## Werkwijze (afspraken met de eigenaar)
- Eerst onderzoeken en meten, dan pas bouwen. Niet gokken, niet "even proberen" op productie.
- Niets ongevraagd aanpassen en doorpushen. Bij twijfel eerst vragen.
- Data die al klopt niet aanraken.
- Bij risicovolle wijzigingen: de terugvaloptie (kill switch of terugdraai-SQL) direct klaar hebben.
- Alle teksten in het Nederlands, zonder em-dashes.
- Controle voor elke push: `node --check`, de inline scripts parsen (`new Function`), grep op em-dashes, en een test met stubs voor de gewijzigde logica.
- Migraties staan in `migrations/NNN_*.sql` en worden door de eigenaar zelf in Neon gedraaid. Code moet ook werken zolang een migratie nog niet gedraaid is.

## Structuur
- `src/marketing/router.js`: de Marketing Studio (workspace), schema `marketing.*`, routes `/api/mkt/*`, sessie `req.session.mkt`.
- `public/workspace.html`: de workspace-app (één inline script).
- `public/create-user.html`: het beheer (dashboard-gebruikers en tab Marketing).
- "Workspace" is iets anders dan "dashboard". Het dashboard is het churn-dashboard in `src/server.js`.

## Meta-koppelingen (Instagram en Facebook)
Er zijn twee routes voor de Instagram-cijfers:
1. **Facebook-route (de hoofdkoppeling):** een Facebook-token met een Instagram-account-ID, via graph.facebook.com. Dit is de standaard, en de enige route voor advertenties en de pagina.
2. **Instagram-login:** een token via graph.instagram.com, per klant (`ig_login_token`). Dit is een terugval voor klanten zonder Facebook-route.

De keuze zit op één plek: `pickIgRoute(creds)` in `router.js`. Die wordt gebruikt door de rapportage (meta-insights), de AI-analyses en de debug-pagina's.
- Een Facebook-token met een Instagram-ID (van de klant of van de werkplek) geeft de Facebook-route.
- **Uitzondering:** werkt de Facebook-route niet voor het Instagram-account, en is de Instagram-login van hetzelfde Instagram-account, dan wordt de Instagram-login gebruikt.
- Een Instagram-login van een ander account wordt nooit gebruikt als er een Facebook-route is.

### Klantsituaties
- **Fleur's Marketingagency** (klant "Fleurs Marketing Agency"): gekoppeld via Facebook (Business Suite), met het werkplek-Instagram 17841466806875640. Dit is de referentie voor 1 op 1 met de Instagram-app.
- **Serac** (klant 13, werkplek Dynamic Health Consultancy). **TIJDELIJK, alleen zolang de Meta-app in testmodus staat. Na het live gaan deze regels verwijderen.** Serac is via het bedrijfsportfolio aan Dynamic gekoppeld, maar alleen voor Facebook (pagina 201507526585686). De advertenties lopen via het advertentieaccount van Dynamic (act_716966690997314). Het Instagram-account (17841403209406746, @serac.fitness) kon in testmodus niet mee in de rechten van het portfolio. Daarom loopt Instagram nu via een losse Instagram-login als Instagram-tester. Het Facebook-token van Serac is op 20-10-2026 verlopen (kortlevend token, nooit verlengd): opnieuw koppelen.
- **Eis voor het live gaan:** elke klant moet direct werken via de standaardroute (Facebook-route via het bedrijfsportfolio, inclusief Instagram), zonder uitzonderingen, testers of losse logins. De terugval in `pickIgRoute` is een vangnet en mag niet nodig zijn.
- Het Facebook-token van een klant nooit leegmaken als er een advertentieaccount of pagina aan hangt.

### App review en live gaan
- Zolang de Meta-app in ontwikkelmodus staat, moet elke gebruiker een app-rol hebben (tester, ontwikkelaar of beheerder). Meta vereist sinds november 2026 een Meta-ontwikkelaarsaccount, ook voor testers ("A Facebook Developer Account is required to be added to an app"). Werkwijze:
  1. De persoon registreert zich gratis op developers.facebook.com (Get started, telefoon bevestigen).
  2. De persoon stuurt de Facebook-gebruikersnaam of het numerieke Facebook-ID uit de profiel-URL.
  3. Toevoegen als Tester met die gebruikersnaam of dat ID, niet op naam (op naam zoeken geeft geen keuzelijst meer en leidt tot "does not resolve to a valid user ID").
  4. De persoon accepteert op developers.facebook.com/requests.
- Instagram-testers (Instagram-login) zijn een aparte rol. Accepteren gaat op instagram.com in de browser (niet in de app): Instellingen, Apps en websites, Testeruitnodigingen. Het account moet een zakelijk of creator-account zijn.
- Na de app review: controleren dat alle klanten via de Facebook-route lopen, het delen via het bedrijfsportfolio of een partnertoewijzing werkt, en tokens automatisch worden ververst (`/api/mkt/cron/refresh-meta-tokens`).

### Publiceren
- Publiceren naar Instagram ("Nu publiceren", carrousel en de planner) gebruikt dezelfde routekeuze als de rapportage (`igPublishRoute`, op basis van `pickIgRoute`): Facebook-route met `instagram_content_publish`, of bij alleen "Koppel via Instagram" graph.instagram.com met `instagram_business_content_publish`.
- Publiceren naar een Facebook-pagina vraagt altijd een Facebook-koppeling (`pages_manage_posts`). Foto via `/photos`, video via graph-video `/videos` (`file_url`), alleen tekst via `/feed`. Faalt het pagina-token, dan staat de reden in de foutmelding (`[pagina-token: ...]`).
- Naar beide tegelijk ("Instagram en Facebook", `publish_channel='both'`, migratie 032): per kanaal `ig_published_at` / `fb_published_at`. Een nieuwe poging plaatst alleen het kanaal dat nog niet gelukt is, nooit dubbel. "Nu publiceren" controleert eerst koppeling, bestand en pagina en plaatst pas daarna. Zonder migratie of met `MKT_PUBLISH_BOTH=0`: oude werking, de keuze is weg en de planner laat posts met 'both' liggen.
- Opslaan van een post met automatisch publiceren zet een al geplaatste post niet meer terug (dat gaf dubbele posts). Alleen een bewust nieuwe tijd in de toekomst plant opnieuw in. Oude werking: `MKT_AUTOPUB_OLD_RESET=1`.
- Rechten van een koppeling meten: `/api/mkt/meta/assets-debug` (werkplek-token van de gekozen werkplek). Een recht met status "declined" vraagt Facebook alleen opnieuw dankzij `auth_type=rerequest`.
- De knop "Koppel met Facebook" vraagt de rechten uit `META_LOGIN_SCOPES` (Render) met `auth_type=rerequest`, zodat eerder overgeslagen rechten opnieuw gevraagd worden. Het scherm na het koppelen toont per recht of het verleend is.

### Advertentiecijfers (Marketing API)
- Meta geeft standaard maar 25 regels per pagina. Lijsten en insights altijd met `graphGetAll` ophalen (volgt `paging.next`), nooit met een losse `graphGet`, anders vallen campagnes, ad sets of advertenties stil weg.
- Ad sets en advertenties zonder cijfers in de gekozen periode (meestal gepauzeerd) krijgen hun totaal sinds start in een apart veld `lifetime`. Dat telt nooit mee in de periodetotalen; de weergave toont het gedempt met "totaal sinds start".

### Gemeten definities (1 op 1 met de Instagram-app)
- "Afgelopen 30 dagen" = 30 volle dagen tot en met gisteren (Amsterdamse dagen). Meta accepteert maximaal 30 dagen per `total_value`-aanvraag, daarom in stukken knippen. Let op de zomertijd: 30 volle dagen kan 721 uur zijn.
- Netto volgers = `follows_and_unfollows` met breakdown `follow_type`: FOLLOWER min NON_FOLLOWER.
- Leeftijd = `follower_demographics` met breakdown `age,gender`, zonder gender U.
- `online_followers`: de uren staan in Pacific-tijd, per dag omrekenen naar Amsterdam.
- Interacties per contenttype: Meta telt gedeeld dubbel. Totaal min gedeeld = de som van de chips in de app. Kill switch: `MKT_FIX_SHARES_DOUBLE=0`. Het extra stukje in "Alles" van de app is niet via de API beschikbaar.
- `website_clicks` is vervallen. Klikken op de bio-link = de som per feedpost van `profile_activity` BIO_LINK_CLICKED.
- Correctieregels alleen als ze bewezen zijn door meting, nooit als schatting.
- Meten via de debug-pagina's (eigenaar of manager): `/api/mkt/debug-insights?client=<id>` en `/api/mkt/debug-profile-views?client=<id>`.

## Werkplekken zijn gescheiden
- Elke werkplek is op zichzelf en hoort bij één gebruiker of bureau. Werkplekken worden nooit aan elkaar gekoppeld, en data mag nooit van de ene naar de andere werkplek lopen.
- In de code hangt alles aan `workspace_id`, en elke aanvraag controleert dat de klant bij de werkplek van de sessie hoort (`clientInWorkspace`). Meta-gegevens komen alleen uit de eigen klant- of werkplekkoppeling.
- Let op met de hand ingevulde ID's: een advertentieaccount- of Instagram-ID van een andere organisatie in een klant zetten werkt als een achterdeur, als het token bij Meta toegang heeft. Dat is niet toegestaan.
- Fleur (platform-admin, gebruiker 31) mag alleen bij de werkplekken van Dynamic en van haar eigen bureau. Dat wordt ingesteld via `mkt_workspace_ids`.

## Agenda (To do & planning)
- Eén takenlijst (`marketing.client_items`, kind `todo`), drie weergaven: menu "Agenda" (alle klanten), de To do-tab per klant (vast op die klant) en "Jouw prio's voor vandaag" op het overzicht. Afvinken op de ene plek is overal afgevinkt.
- Migratie 030: `planned_date` (gepland op) naast `due_date` (deadline), tijd, duur, prioriteit (laag/normaal/hoog), type (taak/afspraak), interne taken (`client_id` leeg).
- Herhaling: een reeks is een rij met kind `todo_series`. De keren worden berekend, niet opgeslagen. Een aangepaste of afgevinkte keer wordt een eigen rij met `series_id` + `occ_date`; een overgeslagen keer kind `todo_skip`.
- Alleen voor het team. Klant-logins krijgen 403 op `/api/mkt/agenda*` en houden in hun To do-tab de oude lijst.
- Prio's op het overzicht: is er bij Gegevens een klant vastgezet (`overview_client_id`), dan alleen die klant, anders alle klanten. Een teamlid ziet de eigen taken en taken zonder eigenaar; de platform-admin alles.
- Achterstallig: niet afgevinkte taken van eerdere dagen, plus gemiste herhalingen van de laatste 7 dagen.
- Zonder migratie 030: het overzicht en de klanttab werken zoals voorheen; het menu Agenda meldt dat de migratie nodig is.
- Categorieën met een eigen kleur (migratie 031, `marketing.agenda_categories`, `client_items.category_id`): per werkplek bij Instellingen, beheer door eigenaar of manager. In de agenda de schakelaar "Kleur op klant" of "Kleur op categorie" (per browser onthouden). Een categorie verwijderen laat de taken staan. Zonder migratie 031 werkt de agenda zonder categorieën.
- Later: een abonnementslink (iCal) zodat Google- en Apple-agenda de taken kunnen tonen (eenrichting).

## Beveiligingsheaders
- `helmet` in `src/server.js` zet HSTS, X-Frame-Options, nosniff en Referrer-Policy. De volledige CSP van helmet staat bewust uit, omdat de pagina's veel inline scripts gebruiken.
- Daarnaast: Permissions-Policy (camera, microfoon, locatie, betalingen en USB uit) en een basis-CSP (`base-uri 'self'; object-src 'none'; frame-ancestors 'self'; upgrade-insecure-requests`). Terugdraaien: env `SECURITY_HEADERS_EXTRA=0`.
- Volgende stap (apart en per pagina getest): een strengere CSP met `script-src`, eerst als Report-Only.

## Toegang tot create-user
- Alleen de superadmin (`admin@dynamic-health-consultancy.nl`) mag in create-user. Andere admins alleen als de superadmin dat aanvinkt in het gebruikersvenster ("Toegang tot create-user", `public.users.create_user_access`, migratie 029). Standaard uit.
- Dit geldt voor de pagina en voor alle routes die create-user gebruikt: `/api/admin/users*`, `/api/admin/create-user*`, `/api/admin/login-report` en `/api/mkt/admin/*`. Het churn-dashboard en het portaal (`/api/admin/praktijk-overzicht`, `/api/admin/praktijken`) blijven voor alle admins.
- Zonder migratie 029: alleen de superadmin. Terugval naar de oude situatie (elke admin): env `CREATE_USER_ALL_ADMINS=1`.

## Platform-admins
- Een dashboard-admin die in de workspace inlogt met het admin-wachtwoord is platform-admin. De login wordt vastgelegd op `public.users` en niet op het marketing-account.
- Welke workspaces een platform-admin ziet: `public.users.mkt_workspace_ids` (migratie 028). NULL = alle workspaces. Dit geldt in de workspace-kiezer en in create-user (tab Marketing), niet in het churn-dashboard.
- Het label "Bron" (Facebook of Instagram-login) in de rapportage is alleen zichtbaar voor de superadmin in de workspace (`IS_SUPER`, vlag `superadmin` uit `/api/mkt/auth/me`). Andere gebruikers zien het niet.
- Instellen via create-user, tab Marketing, knop "Werkplekken" bij het account. Alleen de superadmin (`admin@dynamic-health-consultancy.nl`) ziet die knop en mag dit wijzigen. De superadmin ziet zelf altijd alles.
- Fleur heeft één e-mailadres met twee accounts: dashboard-admin (gebruiker 31) en owner van haar marketing-werkplek (account 2). Het wachtwoord bepaalt de route. Zijn beide wachtwoorden gelijk, dan wint het marketing-account en komt ze niet meer bij Dynamic.

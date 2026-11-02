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
- **Serac** (klant 13, werkplek Dynamic Health Consultancy): gekoppeld via Facebook voor advertenties (act_716966690997314) en de pagina (201507526585686). Het Instagram-account (17841403209406746, @serac.fitness) kon niet via het bedrijfsportfolio of een partnertoewijzing met Dynamic worden gedeeld. Daarom is Serac als Instagram-tester gekoppeld via de Instagram-login. De rapportage gebruikt daardoor de uitzondering hierboven. Dit hoort niet de normale route te zijn: na de app review moet Serac het Instagram-account alsnog via het bedrijfsportfolio delen.
- Het Facebook-token van een klant nooit leegmaken als er een advertentieaccount of pagina aan hangt.

### App review en live gaan
- Zolang de Meta-app in ontwikkelmodus staat, moet elke gebruiker een app-rol hebben (tester, ontwikkelaar of beheerder). Op naam toevoegen werkt alleen bij Facebook-vrienden. Gebruik anders de gebruikersnaam of het numerieke Facebook-ID uit de profiel-URL. De uitnodiging accepteren gaat via Facebook: Instellingen en privacy, Je activiteit, Apps en websites, Verzoeken.
- Instagram-testers (Instagram-login) zijn een aparte rol. Accepteren gaat op instagram.com in de browser (niet in de app): Instellingen, Apps en websites, Testeruitnodigingen. Het account moet een zakelijk of creator-account zijn.
- Na de app review: controleren dat alle klanten via de Facebook-route lopen, het delen via het bedrijfsportfolio of een partnertoewijzing werkt, en tokens automatisch worden ververst (`/api/mkt/cron/refresh-meta-tokens`).

### Gemeten definities (1 op 1 met de Instagram-app)
- "Afgelopen 30 dagen" = 30 volle dagen tot en met gisteren (Amsterdamse dagen). Meta accepteert maximaal 30 dagen per `total_value`-aanvraag, daarom in stukken knippen. Let op de zomertijd: 30 volle dagen kan 721 uur zijn.
- Netto volgers = `follows_and_unfollows` met breakdown `follow_type`: FOLLOWER min NON_FOLLOWER.
- Leeftijd = `follower_demographics` met breakdown `age,gender`, zonder gender U.
- `online_followers`: de uren staan in Pacific-tijd, per dag omrekenen naar Amsterdam.
- Interacties per contenttype: Meta telt gedeeld dubbel. Totaal min gedeeld = de som van de chips in de app. Kill switch: `MKT_FIX_SHARES_DOUBLE=0`. Het extra stukje in "Alles" van de app is niet via de API beschikbaar.
- `website_clicks` is vervallen. Klikken op de bio-link = de som per feedpost van `profile_activity` BIO_LINK_CLICKED.
- Correctieregels alleen als ze bewezen zijn door meting, nooit als schatting.
- Meten via de debug-pagina's (eigenaar of manager): `/api/mkt/debug-insights?client=<id>` en `/api/mkt/debug-profile-views?client=<id>`.

## Platform-admins
- Een dashboard-admin die in de workspace inlogt met het admin-wachtwoord is platform-admin. De login wordt vastgelegd op `public.users` en niet op het marketing-account.
- Welke workspaces een platform-admin ziet: `public.users.mkt_workspace_ids` (migratie 028). NULL = alle workspaces.

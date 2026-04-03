/**
 * EclubService.js - KPI versie op basis van Xploration PDF (13-03-2026)
 *
 * Endpoints:
 *   MembershipStatus → /api/memberships/{branchId}/status
 *   MemberVisit      → /api/membervisits/{branchId}
 *   Revenue          → /api/revenue/{branchId}
 *
 * Alle datums voor MembershipStatus/MemberVisit zijn UTC-0.
 * NL wintertijd = UTC+1, zomertijd = UTC+2.
 * Revenue gebruikt lokale datums (geen UTC conversie).
 */

import EclubAuthService from './EclubAuthService.js';
import EclubApiClient from './EclubApiClient.js';

export default class EclubService {
  constructor(withReadConnection, withWriteConnection) {
    this.withReadConnection = withReadConnection;
    this.withWriteConnection = withWriteConnection;

    this.authService = new EclubAuthService(withReadConnection, withWriteConnection);
    this.apiClient = new EclubApiClient(this.authService);

    this.businessId = process.env.ECLUB_BUSINESS_ID;
  }

  hasCredentials() {
    return !!(
      process.env.ECLUB_CLIENT_ID &&
      process.env.ECLUB_USERNAME &&
      process.env.ECLUB_PASSWORD &&
      this.businessId
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HULPFUNCTIES: datum conversie NL → UTC-0
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Geef de UTC-0 ISO string voor het begin van een NL kalendermaand.
   * Voorbeeld: jaar=2025, maand=1 → "2024-12-31T23:00:00Z" (wintertijd UTC+1)
   */
  _maandStartUtc(jaar, maand) {
    // Maak een datum op de 1e van de maand in lokale NL tijd (Europe/Amsterdam)
    const dt = new Date(`${jaar}-${String(maand).padStart(2, '0')}-01T00:00:00`);
    // Bereken UTC offset voor die datum (ms)
    const nlOffset = this._nlOffsetMs(dt);
    // Trek de offset af om UTC te krijgen
    return new Date(dt.getTime() - nlOffset).toISOString().replace('.000', '');
  }

  /**
   * Geef de UTC-0 ISO string voor het einde van een NL kalendermaand
   * (= begin van de volgende maand).
   */
  _maandEindUtc(jaar, maand) {
    let volgendJaar = jaar;
    let volgendeMaand = maand + 1;
    if (volgendeMaand > 12) { volgendeMaand = 1; volgendJaar++; }
    return this._maandStartUtc(volgendJaar, volgendeMaand);
  }

  /**
   * Bereken de UTC offset in milliseconden voor Europe/Amsterdam op een gegeven datum.
   * Zomertijd: UTC+2 (= -7200000 ms), wintertijd: UTC+1 (= -3600000 ms)
   */
  _nlOffsetMs(date) {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const nlStr  = date.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
    return new Date(nlStr) - new Date(utcStr);
  }

  /**
   * Huidige jaar en maand in NL tijd.
   */
  _huidigeMaand() {
    const nu = new Date();
    const nlStr = nu.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
    const d = new Date(nlStr);
    return { jaar: d.getFullYear(), maand: d.getMonth() + 1 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KPI: MembershipStatus  →  /api/memberships/{branchId}/status
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Haal MembershipStatus op voor één maand.
   * Retourneert de eerste entity uit de array.
   */
  async getMembershipStatus(branchId, jaar, maand, orgId = null) {
    const from  = this._maandStartUtc(jaar, maand);
    const neem  = 1;  // 1 periode van een maand

    console.log(`📊 [ECLUB] MembershipStatus branchId=${branchId} from=${from}`);

    const data = await this.apiClient.get({
      url: `/api/memberships/${branchId}/status`,
      params: { from, period: 3, take: neem },
      businessId: orgId || this.businessId
    });

    // API retourneert een array van MembershipStatus entities
    const rows = Array.isArray(data) ? data : (data?.value || []);
    return rows[0] || null;
  }

  /**
   * Haal MembershipStatus op voor twee opeenvolgende maanden.
   * Nodig voor Retentie en Churn berekening.
   * Retourneert [vorigeMaand, huidigeMaand].
   */
  async getMembershipStatusTweeMananden(branchId, jaar, maand, orgId = null) {
    // from = begin van vorige maand, take=2
    let vorigMaand = maand - 1;
    let vorigJaar  = jaar;
    if (vorigMaand < 1) { vorigMaand = 12; vorigJaar--; }

    const from = this._maandStartUtc(vorigJaar, vorigMaand);

    console.log(`📊 [ECLUB] MembershipStatus 2 maanden branchId=${branchId} from=${from}`);

    const data = await this.apiClient.get({
      url: `/api/memberships/${branchId}/status`,
      params: { from, period: 3, take: 2 },
      businessId: orgId || this.businessId
    });

    const rows = Array.isArray(data) ? data : (data?.value || []);
    return rows; // [0]=vorige maand, [1]=huidige maand
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KPI: MemberVisit  →  /api/membervisits/{branchId}
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Haal totaal aantal bezoeken op voor een maand.
   * accesspointid=0 = alle toegangspunten.
   */
  async getMemberVisits(branchId, jaar, maand, orgId = null) {
    const from  = this._maandStartUtc(jaar, maand);
    const until = this._maandEindUtc(jaar, maand);

    console.log(`📊 [ECLUB] MemberVisits branchId=${branchId} from=${from} until=${until}`);

    const data = await this.apiClient.get({
      url: `/api/membervisits/${branchId}`,
      params: { from, until, period: 3, accesspointid: 0 },
      businessId: orgId || this.businessId
    });

    const rows = Array.isArray(data) ? data : (data?.value || []);

    // Som alle visits op over alle toegangspunten
    const totalVisits = rows.reduce((sum, r) => sum + (parseInt(r.visits) || 0), 0);
    return totalVisits;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KPI: Revenue  →  /api/revenue/{branchId}
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Haal omzet op voor een maand.
   * Revenue gebruikt LOKALE datums (geen UTC), format: YYYY-MM-DD
   */
  async getRevenue(branchId, jaar, maand, orgId = null) {
    const from  = `${jaar}-${String(maand).padStart(2, '0')}-01`;
    let volgendJaar = jaar;
    let volgendeMaand = maand + 1;
    if (volgendeMaand > 12) { volgendeMaand = 1; volgendJaar++; }
    const until = `${volgendJaar}-${String(volgendeMaand).padStart(2, '0')}-01`;

    console.log(`📊 [ECLUB] Revenue branchId=${branchId} from=${from} until=${until}`);

    const data = await this.apiClient.get({
      url: `/api/revenue/${branchId}`,
      params: { from, until },
      businessId: orgId || this.businessId
    });

    const rows = Array.isArray(data) ? data : (data?.value || []);

    // Som excl. BTW omzet op
    const totalExcl = rows.reduce((sum, r) => sum + (parseFloat(r.excl) || 0), 0);
    const totalIncl = rows.reduce((sum, r) => sum + (parseFloat(r.incl) || 0), 0);

    return { excl: totalExcl, incl: totalIncl, rows };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HOOFD METHODE: alle KPI's voor een praktijk in één keer
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Haal alle KPI's op voor een praktijk voor de huidige maand.
   * @param {string} practiceCode  - DHC interne code (bijv. T6PV9A)
   * @param {number} [jaar]        - Optioneel: override jaar
   * @param {number} [maand]       - Optioneel: override maand (1-12)
   */
  async getKPIs(practiceCode, jaar = null, maand = null) {
    console.log(`🔄 [ECLUB] KPI's ophalen voor ${practiceCode}...`);

    if (!this.hasCredentials()) {
      throw new Error('Eclub credentials niet geconfigureerd');
    }

    // Haal branchId en orgId op uit database
    const { branchId, orgId } = await this._getEclubConfig(practiceCode);
    if (!branchId) {
      throw new Error(`Geen eClub branchId gevonden voor praktijk ${practiceCode}`);
    }

    // Gebruik huidige maand als niet opgegeven
    const huidig = this._huidigeMaand();
    const j = jaar  || huidig.jaar;
    const m = maand || huidig.maand;

    console.log(`📅 [ECLUB] Periode: ${j}-${String(m).padStart(2, '0')} | branchId: ${branchId} | orgId: ${orgId}`);

    // Alle API calls parallel uitvoeren voor snelheid
    // MemberVisits is optioneel — 404 = geen toegangspunten geconfigureerd
    const [statusRijen, totalVisits, revenue] = await Promise.all([
      this.getMembershipStatusTweeMananden(branchId, j, m, orgId),
      this.getMemberVisits(branchId, j, m, orgId).catch(err => {
        console.warn(`⚠️ [ECLUB] MemberVisits niet beschikbaar voor branchId ${branchId}: ${err.message}`);
        return 0;
      }),
      this.getRevenue(branchId, j, m, orgId).catch(err => {
        console.warn(`⚠️ [ECLUB] Revenue niet beschikbaar voor branchId ${branchId}: ${err.message}`);
        return { excl: 0, incl: 0, rows: [] };
      })
    ]);

    // statusRijen[0] = vorige maand (voor begin-leden retentie/churn)
    // statusRijen[1] = huidige maand
    const vorigeStatus  = statusRijen[0] || {};
    const huidigStatus  = statusRijen[1] || {};

    // ── Basiswaarden ──────────────────────────────────────────────────────
    const nieuw        = parseInt(huidigStatus.new)        || 0;
    const terugkerend  = parseInt(huidigStatus.returning)  || 0;
    const verlopen     = parseInt(huidigStatus.expiring)   || 0;
    const gepauzeerd   = parseInt(huidigStatus.paused)     || 0;
    const actief       = parseInt(huidigStatus.subscribed) || 0;
    const actief_begin = parseInt(vorigeStatus.subscribed) || 0;
    const gemDuurMnd   = parseFloat(huidigStatus.avgMembershipDuration) || 0;

    // ── Berekende KPI's ───────────────────────────────────────────────────

    // Netto ledengroei = (new + returning) - expiring
    const nettoGroei = (nieuw + terugkerend) - verlopen;

    // Gemiddeld bezoeken per lid
    const gemBezoeken = actief > 0
      ? Math.round((totalVisits / actief) * 10) / 10
      : 0;

    // Omzet per lid (excl. BTW)
    const omzetPerLid = actief > 0
      ? Math.round((revenue.excl / actief) * 100) / 100
      : 0;

    // Retentie % (Jan Middelkamp methode)
    // = ((subscribed_huidig - new_huidig - returning_huidig) / subscribed_vorig) * 100
    const retentie = actief_begin > 0
      ? Math.round(((actief - nieuw - terugkerend) / actief_begin) * 10000) / 100
      : 0;

    // Churn % = (expiring / subscribed_vorig) * 100
    const churn = actief_begin > 0
      ? Math.round((verlopen / actief_begin) * 10000) / 100
      : 0;

    const kpis = {
      periode:            `${j}-${String(m).padStart(2, '0')}`,
      branchId,
      // Leden
      leden_gestart:      nieuw,
      leden_gestopt:      verlopen,
      leden_terugkerend:  terugkerend,
      leden_bevroren:     gepauzeerd,
      leden_actief:       actief,
      netto_ledengroei:   nettoGroei,
      // Bezoeken
      totaal_bezoeken:    totalVisits,
      gem_bezoeken_lid:   gemBezoeken,
      // Duur
      gem_duur_lidmaatschap_maanden: gemDuurMnd,
      // Financieel
      omzet_excl_btw:     revenue.excl,
      omzet_incl_btw:     revenue.incl,
      omzet_per_lid:      omzetPerLid,
      // Percentages
      retentie_pct:       retentie,
      churn_pct:          churn,
      // Metadata
      opgehaald_op:       new Date().toISOString()
    };

    console.log(`✅ [ECLUB] KPI's klaar voor ${practiceCode}:`, {
      leden_actief: kpis.leden_actief,
      netto_groei:  kpis.netto_ledengroei,
      retentie:     `${kpis.retentie_pct}%`,
      churn:        `${kpis.churn_pct}%`,
      omzet:        `€${kpis.omzet_excl_btw}`
    });

    return kpis;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AUTHENTICATIE TEST
  // ─────────────────────────────────────────────────────────────────────────

  async testAuthentication() {
    if (!this.hasCredentials()) {
      return {
        success: false,
        error: 'Eclub credentials niet geconfigureerd',
        credentials: {
          clientId:   !!process.env.ECLUB_CLIENT_ID,
          username:   !!process.env.ECLUB_USERNAME,
          password:   !!process.env.ECLUB_PASSWORD,
          businessId: !!process.env.ECLUB_BUSINESS_ID
        }
      };
    }

    try {
      const cookie    = await this.authService.getValidToken(this.businessId);
      const tokenInfo = this.authService.getTokenInfo(this.businessId);

      return {
        success:      true,
        message:      'Authenticatie geslaagd',
        businessId:   orgId || this.businessId,
        tokenInfo,
        cookieLength: cookie ? cookie.length : 0
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DATABASE HULP: branchId opzoeken
  // ─────────────────────────────────────────────────────────────────────────

  async _getEclubConfig(practiceCode) {
    const result = await this.withReadConnection(async (client) => {
      return client.query(
        `SELECT eclub_branch_id, eclub_org_id FROM praktijken WHERE code = $1`,
        [practiceCode]
      );
    });
    const row = result.rows[0];
    return {
      branchId: row?.eclub_branch_id || null,
      orgId: row?.eclub_org_id || this.businessId  // fallback to global for Vitaal
    };
  }

  async _getBranchId(practiceCode) {
    const config = await this._getEclubConfig(practiceCode);
    return config.branchId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CACHE LEEGMAKEN
  // ─────────────────────────────────────────────────────────────────────────

  clearCaches() {
    this.authService.clearAllCaches();
    console.log(`🗑️ [ECLUB] Cache leeggemaakt`);
  }

  async getHistoricalData(practiceCode, aantalMaanden = 12) {
    console.log(`📈 [ECLUB] Historische data ophalen voor ${practiceCode} (${aantalMaanden} maanden)...`);

    if (!this.hasCredentials()) throw new Error('Eclub credentials niet geconfigureerd');

    const { branchId, orgId } = await this._getEclubConfig(practiceCode);
    if (!branchId) throw new Error(`Geen eClub branchId voor ${practiceCode}`);

    const huidig = this._huidigeMaand();
    let startJaar  = huidig.jaar;
    let startMaand = huidig.maand - aantalMaanden;
    while (startMaand <= 0) { startMaand += 12; startJaar--; }

    const from = this._maandStartUtc(startJaar, startMaand);
    const take = Math.min(aantalMaanden + 1, 12);

    console.log(`📅 [ECLUB] Historisch from=${from} take=${take} branchId=${branchId}`);

    const data = await this.apiClient.get({
      url: `/api/memberships/${branchId}/status`,
      params: { from, period: 3, take },
      businessId: orgId || this.businessId
    });

    const rows = Array.isArray(data) ? data : (data?.value || []);
    const resultaat = [];

    for (let i = 1; i < rows.length; i++) {
      const vorig  = rows[i - 1];
      const huidigRow = rows[i];

      const subscribed_begin = parseInt(vorig.subscribed)     || 0;
      const subscribed_einde = parseInt(huidigRow.subscribed) || 0;
      const nieuw            = parseInt(huidigRow.new)        || 0;
      const terugkerend      = parseInt(huidigRow.returning)  || 0;
      const verlopen         = parseInt(huidigRow.expiring)   || 0;
      const gepauzeerd       = parseInt(huidigRow.paused)     || 0;

      const retentie = subscribed_begin > 0
        ? Math.round(((subscribed_einde - nieuw - terugkerend) / subscribed_begin) * 10000) / 100 : 0;
      const churn = subscribed_begin > 0
        ? Math.round((verlopen / subscribed_begin) * 10000) / 100 : 0;

      const periodeLabel = huidigRow.from
        ? new Date(huidigRow.from).toLocaleDateString('nl-NL', { month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam' })
        : `Maand ${i}`;

      resultaat.push({ periode: periodeLabel, from: huidigRow.from,
        subscribed: subscribed_einde, expiring: verlopen,
        new: nieuw, returning: terugkerend, paused: gepauzeerd,
        retentie_pct: retentie, churn_pct: churn });
    }

    console.log(`✅ [ECLUB] ${resultaat.length} maanden historische data opgehaald`);
    return resultaat;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEDEN SYNC → leads tabel
  // Haalt alle leden op via GET /api/members (gepagineerd) en matcht
  // op emailadres met de leads tabel. Bij match: is_lid = true.
  // ─────────────────────────────────────────────────────────────────────────

  async syncLedenNaarLeads(practiceCode) {
    console.log(`🔄 [ECLUB-LEDEN] Starten leden sync voor ${practiceCode}...`);

    const config = await this._getEclubConfig(practiceCode);
    const { branchId, orgId } = config;

    if (!branchId) {
      throw new Error(`Geen eClub branchId gevonden voor praktijk ${practiceCode}`);
    }

    // Haal alle leden op via gepagineerde API — email + lidmaatschapsdatum
    const alleleden = await this.apiClient.getPaginated({
      url: `/api/members`,
      params: {
        branchId,
        select: 'email',
        select2: 'membershipBeginsOn'
      },
      businessId: orgId || this.businessId,
      pageSize: 50
    });

    // De API accepteert meerdere select params — axios gooit duplicaten weg.
    // Alternatieve aanpak: gebruik een custom params serializer.
    // We proberen eerst de standaard manier, anders vallen we terug op array.
    console.log(`📊 [ECLUB-LEDEN] ${alleleden.length} leden opgehaald voor branchId ${branchId}`);

    if (alleleden.length === 0) {
      return { success: true, matched: 0, updated: 0, total: 0 };
    }

    let matched = 0;
    let updated = 0;

    for (const lid of alleleden) {
      const email = (lid.email || '').toLowerCase().trim();
      const lidSinds = lid.membershipBeginsOn || null;

      if (!email) continue;

      try {
        const result = await this.withWriteConnection(async (client) => {
          return await client.query(`
            UPDATE public.leads
            SET
              is_lid          = true,
              lid_geworden_op = COALESCE(lid_geworden_op, $2::date),
              funnel_stage    = 'won'
            WHERE LOWER(emailadres) = $1
              AND praktijk_code = $3
              AND is_lid IS NOT TRUE
            RETURNING id
          `, [email, lidSinds, practiceCode]);
        });

        if (result.rows.length > 0) {
          matched++;
          updated += result.rows.length;
          console.log(`✅ [ECLUB-LEDEN] Lead gekoppeld: ${email} → lid sinds ${lidSinds}`);
        }
      } catch (err) {
        console.warn(`⚠️ [ECLUB-LEDEN] Fout bij verwerken ${email}:`, err.message);
      }
    }

    console.log(`✅ [ECLUB-LEDEN] Sync klaar: ${matched} leads bijgewerkt van ${alleleden.length} leden`);
    return { success: true, matched, updated, total: alleleden.length };
  }
}

// Patch: voeg getHistoricalData toe als losse export helper
// (wordt geïnjecteerd via monkey-patch na class definitie)

// src/marketing/router.js
// GEISOLEERDE marketing-module. Leeft volledig los van het churn-dashboard.
//  - Data: uitsluitend schema `marketing.*` in Neon.
//  - Routes: /marketing (shell) en /api/mkt/*  (nergens anders).
//  - Auth: eigen sessie-namespace req.session.mkt (botst niet met de DHC-login).
//  - Adminbeheer van workspaces/licenties: afgeschermd met de bestaande DHC-admin.
// Deze module raakt GEEN bestaande tabellen of endpoints aan.

import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { withReadConnection, withWriteConnection } from '../db.js';

// Cloudinary-config uit environment (staat in Render, niet in de code).
function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) return { cloudName, apiKey, apiSecret };
  return null;
}
// Cloudinary-handtekening: sha1 van gesorteerde params + secret.
function cloudinarySign(params, apiSecret) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Versleuteling voor gevoelige tokens (AES-256-GCM). Sleutel uit env MKT_SECRET_KEY.
// Zonder sleutel wordt in leesbare vorm opgeslagen (met 'raw:' prefix) als terugval.
function mktKey() {
  const s = process.env.MKT_SECRET_KEY;
  if (!s) return null;
  return crypto.createHash('sha256').update(String(s)).digest(); // 32 bytes
}
function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const key = mktKey();
  if (!key) return 'raw:' + String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}
function decryptSecret(stored) {
  if (stored == null) return null;
  if (stored.startsWith('raw:')) return stored.slice(4);
  if (!stored.startsWith('enc:v1:')) return null;
  const key = mktKey();
  if (!key) return null;
  try {
    const [, , ivb, tagb, ctb] = stored.split(':');
    const iv = Buffer.from(ivb, 'base64'), tag = Buffer.from(tagb, 'base64'), ct = Buffer.from(ctb, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (_) { return null; }
}
// Toon een token nooit volledig terug: alleen of het is ingesteld + laatste 4 tekens.
function maskSecret(stored) {
  const v = decryptSecret(stored);
  if (!v) return { set: false, hint: '' };
  const tail = v.length > 4 ? v.slice(-4) : v;
  return { set: true, hint: '••••' + tail };
}

const SALT_ROUNDS = 12;
const VALID_LICENSE = ['trial', '1m', '3m', '6m', '12m', '24m', 'unlimited'];
const VALID_MODULES = ['planner', 'reporting', 'publishing', 'assets', 'tasks', 'billing', 'integrations'];

function maandenVoorLicentie(t) {
  return ({ '1m': 1, '3m': 3, '6m': 6, '12m': 12, '24m': 24 })[t] || 0;
}
function licentieEinddatum(type) {
  if (!type || type === 'unlimited' || type === 'trial') {
    // trial = 14 dagen; unlimited = geen einddatum
    if (type === 'trial') {
      const d = new Date(); d.setDate(d.getDate() + 14); return d;
    }
    return null;
  }
  const d = new Date(); d.setMonth(d.getMonth() + maandenVoorLicentie(type)); return d;
}
function slugify(s) {
  const base = String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
  return base || ('ws-' + Date.now());
}

// ---- guards ------------------------------------------------------------
function requireDhcAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin toegang vereist' });
}
// Ingelogd op de marketing-module (account OF platform-admin, workspace optioneel).
// Gebruikt door /me zodat een platform-admin zonder gekozen workspace de kiezer kan zien.
function requireMktSession(req, res, next) {
  const m = req.session && req.session.mkt;
  if (m && (m.accountId || m.platformAdmin)) return next();
  return res.status(401).json({ error: 'Niet ingelogd' });
}
// Mag in een workspace werken: gewoon account, of platform-admin MET gekozen workspace.
// Hercontroleert bij elke aanvraag of het account/de workspace nog actief is, zodat een
// ingetrokken trial direct wordt afgesloten (niet pas als de sessie verloopt).
// Fail-open bij een infrafout (geen onterechte uitsluiting), fail-closed bij een echte blokkade.
async function requireMkt(req, res, next) {
  const m = req.session && req.session.mkt;
  if (!m) return res.status(401).json({ error: 'Niet ingelogd' });
  if (m.platformAdmin) {
    if (m.workspaceId) return next();
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  if (!m.accountId) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    const row = await withReadConnection(async (c) => (await c.query(
      `SELECT a.active AS a_active, a.banned AS a_banned, w.active AS w_active, w.license_end
         FROM marketing.accounts a JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE a.id = $1`, [m.accountId]
    )).rows[0]);
    if (row) {
      const blocked = row.a_active === false || row.a_banned === true || row.w_active === false ||
        (row.license_end && new Date(row.license_end) < new Date());
      if (blocked) { delete req.session.mkt; return res.status(403).json({ error: 'Toegang ingetrokken' }); }
    }
  } catch (_) { /* infrafout: doorlaten zodat legitieme gebruikers niet worden uitgesloten */ }
  return next();
}
function requireMktPlatform(req, res, next) {
  if (req.session && req.session.mkt && req.session.mkt.platformAdmin) return next();
  return res.status(403).json({ error: 'Alleen platform-admin' });
}

// ---- shell (statische marketing-werkplekpagina) ------------------------
// De omgeving heet workspace.html; /marketing en /workspace zijn aliassen.
router.get(['/marketing', '/workspace', '/workspace.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'workspace.html'));
});

// =======================================================================
// ADMIN (DHC-admin): workspaces + licenties beheren
// =======================================================================

// Lijst van alle marketing-workspaces met licentie + aantal accounts.
router.get('/api/mkt/admin/workspaces', requireDhcAdmin, async (req, res) => {
  try {
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT w.*,
              (SELECT COUNT(*) FROM marketing.accounts a WHERE a.workspace_id = w.id) AS accounts,
              (SELECT email FROM marketing.accounts a WHERE a.workspace_id = w.id AND a.role='owner' ORDER BY a.id ASC LIMIT 1) AS owner_email
         FROM marketing.workspaces w
        ORDER BY w.created_at DESC`
    )).rows);
    res.json({ success: true, workspaces: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nieuwe workspace + eigenaar-account + licentie aanmaken.
router.post('/api/mkt/admin/workspaces', requireDhcAdmin, async (req, res) => {
  try {
    const { name, ownerEmail, ownerName, ownerPassword,
            licenseType, maxSeats, maxClients, modules } = req.body || {};
    if (!name || !ownerEmail || !ownerPassword) {
      return res.status(400).json({ error: 'Naam, eigenaar e-mail en wachtwoord zijn verplicht' });
    }
    if (ownerPassword.length < 8 || !/[A-Z]/.test(ownerPassword) || !/[a-z]/.test(ownerPassword) || !/[0-9]/.test(ownerPassword)) {
      return res.status(400).json({ error: 'Wachtwoord: min. 8 tekens, hoofd- en kleine letter en een cijfer' });
    }
    const type = VALID_LICENSE.includes(licenseType) ? licenseType : 'trial';
    const mods = Array.isArray(modules) ? modules.filter(m => VALID_MODULES.includes(m)) : ['planner', 'reporting'];
    const seats = Math.max(1, parseInt(maxSeats, 10) || 3);
    const clients = Math.max(1, parseInt(maxClients, 10) || 5);
    const storageMb = Math.max(256, parseInt(req.body && req.body.storageMb, 10) || DEFAULT_STORAGE_MB);
    const email = String(ownerEmail).toLowerCase().trim();

    const dup = await withReadConnection(async (c) =>
      (await c.query('SELECT 1 FROM marketing.accounts WHERE email=$1', [email])).rows[0]);
    if (dup) return res.status(400).json({ error: 'Dit e-mailadres bestaat al binnen marketing' });

    const licenseEnd = licentieEinddatum(type);
    const hash = await bcrypt.hash(ownerPassword, SALT_ROUNDS);

    // Unieke slug bepalen.
    let slug = slugify(name);
    const exists = await withReadConnection(async (c) =>
      (await c.query('SELECT 1 FROM marketing.workspaces WHERE slug=$1', [slug])).rows[0]);
    if (exists) slug = `${slug}-${Date.now().toString(36)}`;

    const result = await withWriteConnection(async (c) => {
      const ws = (await c.query(
        `INSERT INTO marketing.workspaces (name, slug, license_type, license_end, max_seats, max_clients, modules)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, slug, type, licenseEnd, seats, clients, mods]
      )).rows[0];
      const acc = (await c.query(
        `INSERT INTO marketing.accounts (workspace_id, email, password_hash, full_name, role)
         VALUES ($1,$2,$3,$4,'owner') RETURNING id, email, role`,
        [ws.id, email, hash, ownerName || null]
      )).rows[0];
      await c.query(
        `INSERT INTO marketing.license_events (workspace_id, actie, details)
         VALUES ($1,'aangemaakt',$2)`,
        [ws.id, JSON.stringify({ license_type: type, max_seats: seats, max_clients: clients, modules: mods })]
      );
      return { ws, acc };
    });

    // Opslagquota apart en best-effort zetten (breekt niet als kolom nog niet bestaat).
    try {
      await withWriteConnection(async (c) => c.query('UPDATE marketing.workspaces SET storage_quota_mb=$1 WHERE id=$2', [storageMb, result.ws.id]));
      result.ws.storage_quota_mb = storageMb;
    } catch (_) { /* kolom bestaat nog niet: standaard 10 GB blijft gelden */ }

    res.json({ success: true, workspace: result.ws, owner: result.acc, temp_password: ownerPassword });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Licentie van een workspace bijwerken.
router.patch('/api/mkt/admin/workspaces/:id/license', requireDhcAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { licenseType, maxSeats, maxClients, modules, active } = req.body || {};
    const type = VALID_LICENSE.includes(licenseType) ? licenseType : null;
    const sets = [], vals = []; let i = 1;
    if (type) { sets.push(`license_type=$${i++}`); vals.push(type); sets.push(`license_end=$${i++}`); vals.push(licentieEinddatum(type)); }
    if (maxSeats != null) { sets.push(`max_seats=$${i++}`); vals.push(Math.max(1, parseInt(maxSeats, 10) || 1)); }
    if (maxClients != null) { sets.push(`max_clients=$${i++}`); vals.push(Math.max(1, parseInt(maxClients, 10) || 1)); }
    if (Array.isArray(modules)) { sets.push(`modules=$${i++}`); vals.push(modules.filter(m => VALID_MODULES.includes(m))); }
    if (typeof active === 'boolean') { sets.push(`active=$${i++}`); vals.push(active); }
    // Opslagquota apart en best-effort (breekt niet als de kolom nog niet bestaat).
    const storageMb = (req.body && req.body.storageMb != null) ? Math.max(256, parseInt(req.body.storageMb, 10) || DEFAULT_STORAGE_MB) : null;
    if (storageMb != null) {
      try { await withWriteConnection(async (c) => c.query('UPDATE marketing.workspaces SET storage_quota_mb=$1 WHERE id=$2', [storageMb, id])); } catch (_) { /* kolom nog niet aanwezig */ }
    }
    if (!sets.length) {
      if (storageMb != null) return res.json({ success: true, storageMb });
      return res.status(400).json({ error: 'Niets om bij te werken' });
    }
    vals.push(id);
    const row = await withWriteConnection(async (c) => {
      const r = (await c.query(`UPDATE marketing.workspaces SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)).rows[0];
      if (r) await c.query(`INSERT INTO marketing.license_events (workspace_id, actie, details) VALUES ($1,'bijgewerkt',$2)`,
        [id, JSON.stringify(req.body || {})]);
      return r;
    });
    if (!row) return res.status(404).json({ error: 'Workspace niet gevonden' });
    res.json({ success: true, workspace: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- BEHEERDERSCONSOLE: detail, accounts, resets --------------------------
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p); }
async function activeOwnerCount(client, workspaceId, exceptId) {
  return (await client.query(
    `SELECT COUNT(*)::int AS n FROM marketing.accounts
      WHERE workspace_id=$1 AND role='owner' AND active=true AND (banned IS NULL OR banned=false)
        ${exceptId ? 'AND id <> $2' : ''}`,
    exceptId ? [workspaceId, exceptId] : [workspaceId]
  )).rows[0].n;
}

// Detail van één workspace incl. accounts + aantal klanten.
router.get('/api/mkt/admin/workspaces/:id', requireDhcAdmin, async (req, res) => {
  try {
    const data = await withReadConnection(async (c) => {
      const ws = (await c.query('SELECT * FROM marketing.workspaces WHERE id=$1', [req.params.id])).rows[0];
      if (!ws) return null;
      const accounts = (await c.query(
        `SELECT a.id, a.email, a.full_name, a.role, a.active, a.banned, a.last_login_at, a.created_at,
                a.client_id, cl.name AS client_name
           FROM marketing.accounts a
           LEFT JOIN marketing.clients cl ON cl.id = a.client_id
          WHERE a.workspace_id=$1 ORDER BY (a.role='owner') DESC, a.created_at ASC`, [req.params.id]
      )).rows;
      const clients = (await c.query('SELECT COUNT(*)::int AS n FROM marketing.clients WHERE workspace_id=$1', [req.params.id])).rows[0].n;
      return { ws, accounts, clients };
    });
    if (!data) return res.status(404).json({ error: 'Workspace niet gevonden' });
    res.json({ success: true, workspace: data.ws, accounts: data.accounts, client_count: data.clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Klanten van een workspace incl. koppelingen/ID's en tellingen (voor beheer op afstand).
router.get('/api/mkt/admin/workspaces/:id/clients', requireDhcAdmin, async (req, res) => {
  try {
    const wsId = req.params.id;
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT cl.id, cl.name, cl.contact_name, cl.contact_email, cl.website, cl.brand_color, cl.status,
              i.meta_page_id, i.meta_ig_user_id, i.meta_pixel_id, i.meta_ad_account_id, i.meta_app_id,
              i.google_ads_customer_id, i.ga4_measurement_id, i.tiktok_pixel_id, i.notes,
              i.meta_access_token, i.meta_app_secret, i.google_ads_developer_token, i.tiktok_access_token,
              (SELECT COUNT(*)::int FROM marketing.campaign_links cll WHERE cll.client_id=cl.id) AS linked_campaigns,
              (SELECT COUNT(*)::int FROM marketing.content_posts p WHERE p.client_id=cl.id) AS posts,
              (SELECT COUNT(*)::int FROM marketing.assets a WHERE a.client_id=cl.id) AS assets,
              (SELECT COUNT(*)::int FROM marketing.accounts ac WHERE ac.client_id=cl.id) AS logins
         FROM marketing.clients cl
         LEFT JOIN marketing.client_integrations i ON i.client_id = cl.id
        WHERE cl.workspace_id=$1
        ORDER BY cl.name ASC`, [wsId]
    )).rows);
    // ID's volledig zichtbaar voor de admin; tokens gemaskeerd.
    const clients = rows.map((r) => ({
      id: r.id, name: r.name, contact_name: r.contact_name, contact_email: r.contact_email,
      website: r.website, brand_color: r.brand_color, status: r.status,
      linked_campaigns: r.linked_campaigns, posts: r.posts, assets: r.assets, logins: r.logins,
      integrations: {
        meta_page_id: r.meta_page_id || '', meta_ig_user_id: r.meta_ig_user_id || '',
        meta_pixel_id: r.meta_pixel_id || '', meta_ad_account_id: r.meta_ad_account_id || '', meta_app_id: r.meta_app_id || '',
        google_ads_customer_id: r.google_ads_customer_id || '', ga4_measurement_id: r.ga4_measurement_id || '',
        tiktok_pixel_id: r.tiktok_pixel_id || '', notes: r.notes || '',
        meta_access_token: maskSecret(r.meta_access_token), meta_app_secret: maskSecret(r.meta_app_secret),
        google_ads_developer_token: maskSecret(r.google_ads_developer_token), tiktok_access_token: maskSecret(r.tiktok_access_token),
      },
    }));
    res.json({ success: true, clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account toevoegen aan een workspace.
router.post('/api/mkt/admin/workspaces/:id/accounts', requireDhcAdmin, async (req, res) => {
  try {
    const { email, full_name, role, password, client_id } = req.body || {};
    const VALID_ROLE = ['owner', 'manager', 'member', 'client'];
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord: min. 8 tekens, hoofd- en kleine letter en een cijfer' });
    const r = VALID_ROLE.includes(role) ? role : 'member';
    const em = String(email).toLowerCase().trim();
    const ws = await withReadConnection(async (c) => (await c.query('SELECT id FROM marketing.workspaces WHERE id=$1', [req.params.id])).rows[0]);
    if (!ws) return res.status(404).json({ error: 'Workspace niet gevonden' });
    // Klant-login moet aan een klant van deze workspace gekoppeld zijn.
    let cid = null;
    if (r === 'client') {
      if (!client_id) return res.status(400).json({ error: 'Kies een klant om deze klant-login aan te koppelen' });
      const okc = await withReadConnection(async (c) => (await c.query(
        'SELECT id FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [client_id, req.params.id]
      )).rows[0]);
      if (!okc) return res.status(400).json({ error: 'Gekozen klant hoort niet bij deze workspace' });
      cid = okc.id;
    }
    const dup = await withReadConnection(async (c) => (await c.query('SELECT 1 FROM marketing.accounts WHERE email=$1', [em])).rows[0]);
    if (dup) return res.status(400).json({ error: 'Dit e-mailadres bestaat al binnen marketing' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.accounts (workspace_id, email, password_hash, full_name, role, client_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, role, active, banned`,
      [req.params.id, em, hash, full_name || null, r, cid]
    )).rows[0]);
    res.json({ success: true, account: row, temp_password: password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wachtwoord van een account resetten (support).
router.post('/api/mkt/admin/accounts/:id/reset-password', requireDhcAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord: min. 8 tekens, hoofd- en kleine letter en een cijfer' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const done = await withWriteConnection(async (c) => (await c.query(
      'UPDATE marketing.accounts SET password_hash=$1 WHERE id=$2 RETURNING id', [hash, req.params.id]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Account niet gevonden' });
    res.json({ success: true, temp_password: password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account bijwerken: rol, actief, banned. Beschermt de laatste eigenaar.
router.patch('/api/mkt/admin/accounts/:id', requireDhcAdmin, async (req, res) => {
  try {
    const { role, active, banned } = req.body || {};
    const VALID_ROLE = ['owner', 'manager', 'member', 'client'];
    const row = await withWriteConnection(async (c) => {
      const acc = (await c.query('SELECT id, workspace_id, role FROM marketing.accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!acc) return { notfound: true };
      // Zou dit de laatste actieve eigenaar uitschakelen/degraderen?
      const demoting = (role && role !== 'owner') || active === false || banned === true;
      if (acc.role === 'owner' && demoting) {
        const others = await activeOwnerCount(c, acc.workspace_id, acc.id);
        if (others < 1) return { lastOwner: true };
      }
      const sets = [], vals = []; let i = 1;
      if (role && VALID_ROLE.includes(role)) { sets.push(`role=$${i++}`); vals.push(role); }
      if (typeof active === 'boolean') { sets.push(`active=$${i++}`); vals.push(active); }
      if (typeof banned === 'boolean') { sets.push(`banned=$${i++}`); vals.push(banned); }
      if (!sets.length) return { nochange: true };
      vals.push(req.params.id);
      return { row: (await c.query(`UPDATE marketing.accounts SET ${sets.join(', ')} WHERE id=$${i} RETURNING id, email, role, active, banned`, vals)).rows[0] };
    });
    if (row.notfound) return res.status(404).json({ error: 'Account niet gevonden' });
    if (row.lastOwner) return res.status(400).json({ error: 'Dit is de laatste actieve eigenaar. Wijs eerst een andere eigenaar aan.' });
    if (row.nochange) return res.status(400).json({ error: 'Niets om bij te werken' });
    res.json({ success: true, account: row.row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account verwijderen (beschermt de laatste eigenaar).
router.delete('/api/mkt/admin/accounts/:id', requireDhcAdmin, async (req, res) => {
  try {
    const result = await withWriteConnection(async (c) => {
      const acc = (await c.query('SELECT id, workspace_id, role FROM marketing.accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!acc) return { notfound: true };
      if (acc.role === 'owner') {
        const others = await activeOwnerCount(c, acc.workspace_id, acc.id);
        if (others < 1) return { lastOwner: true };
      }
      await c.query('DELETE FROM marketing.accounts WHERE id=$1', [req.params.id]);
      return { ok: true };
    });
    if (result.notfound) return res.status(404).json({ error: 'Account niet gevonden' });
    if (result.lastOwner) return res.status(400).json({ error: 'Dit is de laatste eigenaar en kan niet verwijderd worden.' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Workspace resetten: verwijdert alle klanten (troubleshoot). Accounts blijven.
router.post('/api/mkt/admin/workspaces/:id/reset', requireDhcAdmin, async (req, res) => {
  try {
    const n = await withWriteConnection(async (c) => {
      const ws = (await c.query('SELECT id FROM marketing.workspaces WHERE id=$1', [req.params.id])).rows[0];
      if (!ws) return null;
      const del = await c.query('DELETE FROM marketing.clients WHERE workspace_id=$1', [req.params.id]);
      return del.rowCount;
    });
    if (n === null) return res.status(404).json({ error: 'Workspace niet gevonden' });
    res.json({ success: true, deleted_clients: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Workspace volledig verwijderen (cascade: accounts, klanten, licentie-events).
router.delete('/api/mkt/admin/workspaces/:id', requireDhcAdmin, async (req, res) => {
  try {
    const done = await withWriteConnection(async (c) => (await c.query(
      'DELETE FROM marketing.workspaces WHERE id=$1 RETURNING id', [req.params.id]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Workspace niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// MARKETING AUTH (eigen accounts, eigen sessie-namespace)
// =======================================================================
router.post('/api/mkt/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    const em = String(email).toLowerCase().trim();

    // 1) Marketing-account(s). Eén e-mailadres kan (na de multi-workspace-migratie)
    // in meerdere workspaces bestaan met hetzelfde wachtwoord. Vandaag is er precies
    // één rij per e-mail, dus dit gedraagt zich identiek aan voorheen.
    const accs = await withReadConnection(async (c) => (await c.query(
      `SELECT a.*, w.name AS workspace_name, w.slug AS workspace_slug, w.active AS ws_active,
              w.license_type, w.license_end, w.modules
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE a.email=$1 AND a.active=true AND (a.banned IS NULL OR a.banned=false)
        ORDER BY w.name ASC`, [em]
    )).rows);
    if (accs.length && await bcrypt.compare(password, accs[0].password_hash)) {
      // Toegankelijke workspaces = rijen met dezelfde credential (gedeeld wachtwoord).
      const accessible = accs.filter((a) => a.password_hash === accs[0].password_hash);
      if (accessible.length > 1) {
        // Meerdere workspaces onder één login: laat de gebruiker kiezen.
        req.session.mkt = { pending: true, email: em, allowed: accessible.map((a) => a.id) };
        return req.session.save(() => res.json({
          success: true, needsWorkspace: true,
          choices: accessible.map((a) => ({ accountId: a.id, workspaceId: a.workspace_id, name: a.workspace_name, role: a.role }))
        }));
      }
      const acc = accessible[0];
      if (!acc.ws_active) return res.status(403).json({ error: 'Deze workspace is niet actief' });
      if (acc.license_end && new Date(acc.license_end) < new Date())
        return res.status(403).json({ error: 'De licentie van deze workspace is verlopen' });
      req.session.mkt = { accountId: acc.id, workspaceId: acc.workspace_id, role: acc.role, email: acc.email, clientId: acc.client_id || null };
      await withWriteConnection(async (c) => c.query('UPDATE marketing.accounts SET last_login_at=now() WHERE id=$1', [acc.id]));
      return req.session.save(() => res.json({
        success: true, platformAdmin: false,
        account: { id: acc.id, email: acc.email, role: acc.role, name: acc.full_name },
        workspace: { id: acc.workspace_id, name: acc.workspace_name, slug: acc.workspace_slug, modules: acc.modules }
      }));
    }

    // 2) DHC platform-admin: krijgt overzicht over alle workspaces.
    const admin = await withReadConnection(async (c) => (await c.query(
      `SELECT id, email, password_hash FROM public.users
        WHERE email=$1 AND role='admin' AND active=TRUE AND (banned IS NULL OR banned=FALSE)`, [em]
    )).rows[0]);
    if (admin && await bcrypt.compare(password, admin.password_hash)) {
      req.session.mkt = { platformAdmin: true, role: 'platform_admin', email: admin.email, workspaceId: null };
      return req.session.save(() => res.json({ success: true, platformAdmin: true, email: admin.email }));
    }

    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kies een workspace na inloggen, als hetzelfde e-mailadres in meerdere
// workspaces bestaat. Alleen mogelijk vanuit de 'pending'-staat die de login
// zet, en alleen voor de accounts die daar zijn geautoriseerd.
router.post('/api/mkt/auth/choose-workspace', async (req, res) => {
  try {
    const m = req.session && req.session.mkt;
    if (!m || !m.pending || !Array.isArray(m.allowed)) return res.status(401).json({ error: 'Geen workspace-keuze in behandeling' });
    const chosen = (req.body && req.body.accountId);
    if (!m.allowed.map(String).includes(String(chosen))) return res.status(403).json({ error: 'Niet toegestaan' });
    const acc = await withReadConnection(async (c) => (await c.query(
      `SELECT a.*, w.name AS workspace_name, w.slug AS workspace_slug, w.active AS ws_active,
              w.license_type, w.license_end, w.modules
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE a.id=$1 AND a.active=true AND (a.banned IS NULL OR a.banned=false)`, [chosen]
    )).rows[0]);
    if (!acc) return res.status(404).json({ error: 'Account niet gevonden' });
    if (!acc.ws_active) return res.status(403).json({ error: 'Deze workspace is niet actief' });
    if (acc.license_end && new Date(acc.license_end) < new Date())
      return res.status(403).json({ error: 'De licentie van deze workspace is verlopen' });
    req.session.mkt = { accountId: acc.id, workspaceId: acc.workspace_id, role: acc.role, email: acc.email, clientId: acc.client_id || null };
    await withWriteConnection(async (c) => c.query('UPDATE marketing.accounts SET last_login_at=now() WHERE id=$1', [acc.id]));
    return req.session.save(() => res.json({
      success: true, platformAdmin: false,
      account: { id: acc.id, email: acc.email, role: acc.role, name: acc.full_name },
      workspace: { id: acc.workspace_id, name: acc.workspace_name, slug: acc.workspace_slug, modules: acc.modules }
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mkt/auth/logout', (req, res) => {
  if (req.session) delete req.session.mkt;
  res.json({ success: true });
});

router.get('/api/mkt/auth/me', requireMktSession, async (req, res) => {
  try {
    const m = req.session.mkt;
    if (m.platformAdmin) {
      let workspace = null;
      if (m.workspaceId) {
        workspace = await withReadConnection(async (c) => (await c.query(
          `SELECT id, name, slug, modules, license_type, license_end, max_seats, max_clients
             FROM marketing.workspaces WHERE id=$1`, [m.workspaceId]
        )).rows[0]) || null;
      }
      return res.json({ success: true, platformAdmin: true, email: m.email, workspace });
    }
    const data = await withReadConnection(async (c) => (await c.query(
      `SELECT a.id, a.email, a.full_name, a.role, a.client_id,
              cl.name AS client_name,
              w.id AS workspace_id, w.name AS workspace_name, w.slug, w.modules,
              w.license_type, w.license_end, w.max_seats, w.max_clients
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id=a.workspace_id
         LEFT JOIN marketing.clients cl ON cl.id=a.client_id
        WHERE a.id=$1`, [m.accountId]
    )).rows[0]);
    if (!data) { delete req.session.mkt; return res.status(401).json({ error: 'Sessie verlopen' }); }
    res.json({ success: true, platformAdmin: false, account: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PLATFORM-ADMIN: overzicht + workspace kiezen -------------------------
router.get('/api/mkt/platform/workspaces', requireMktPlatform, async (req, res) => {
  try {
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT w.id, w.name, w.slug, w.license_type, w.license_end, w.active,
              (SELECT COUNT(*)::int FROM marketing.accounts a WHERE a.workspace_id=w.id) AS accounts,
              (SELECT COUNT(*)::int FROM marketing.clients cl WHERE cl.workspace_id=w.id) AS clients
         FROM marketing.workspaces w ORDER BY w.name ASC`
    )).rows);
    res.json({ success: true, workspaces: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/platform/enter', requireMktPlatform, async (req, res) => {
  try {
    const { workspaceId } = req.body || {};
    const ws = await withReadConnection(async (c) => (await c.query('SELECT id, name, slug FROM marketing.workspaces WHERE id=$1', [workspaceId])).rows[0]);
    if (!ws) return res.status(404).json({ error: 'Workspace niet gevonden' });
    req.session.mkt.workspaceId = ws.id;
    req.session.save(() => res.json({ success: true, workspace: ws }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/platform/exit', requireMktPlatform, (req, res) => {
  req.session.mkt.workspaceId = null;
  req.session.save(() => res.json({ success: true }));
});

// =======================================================================
// STAP 2 - CLIENT SPACES (klanten binnen een workspace)
// Alles strikt gescopet op req.session.mkt.workspaceId.
// =======================================================================
const CLIENT_STATUS = ['active', 'paused', 'archived'];
function mktCanManage(req) { const m = req.session?.mkt; return m && (m.platformAdmin || m.role !== 'client'); }
function mktIsOwnerOrManager(req) { const m = req.session?.mkt; return m && (m.platformAdmin || m.role === 'owner' || m.role === 'manager'); }
// Een klant-account is opgesloten in de eigen klant-brand.
function mktClientLocked(req) { const m = req.session?.mkt; return !!(m && m.role === 'client'); }
function mktLockedClientId(req) { const m = req.session?.mkt; return m ? m.clientId : null; }
// Geeft true als deze (evt. klant-)gebruiker bij deze klant mag.
function mktClientAllowed(req, clientId) {
  if (!mktClientLocked(req)) return true;
  return String(clientId) === String(mktLockedClientId(req));
}

// Lijst klanten van de eigen workspace (standaard zonder gearchiveerde).
router.get('/api/mkt/clients', requireMkt, async (req, res) => {
  try {
    const includeArchived = String(req.query.archived || '') === '1';
    // Klant-account ziet uitsluitend de eigen klant-brand.
    const lock = mktClientLocked(req) ? mktLockedClientId(req) : null;
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT cl.id, cl.name, cl.contact_name, cl.contact_email, cl.website, cl.brand_color, cl.status, cl.archived, cl.created_at,
              (SELECT COUNT(*)::int FROM marketing.content_posts p
                 WHERE p.workspace_id = cl.workspace_id AND p.client_id = cl.id AND p.approval = 'changes') AS open_actions
         FROM marketing.clients cl
        WHERE cl.workspace_id = $1 ${includeArchived ? '' : 'AND cl.archived = false'}
          ${lock ? 'AND cl.id = $2' : ''}
        ORDER BY cl.name ASC`,
      lock ? [req.session.mkt.workspaceId, lock] : [req.session.mkt.workspaceId]
    )).rows);
    res.json({ success: true, clients: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nieuwe klant aanmaken (owner/manager/member). Respecteert max_clients van de licentie.
router.post('/api/mkt/clients', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om klanten te beheren' });
    const { name, contact_name, contact_email, website, brand_color, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Klantnaam is verplicht' });

    const wsId = req.session.mkt.workspaceId;
    const limit = await withReadConnection(async (c) => {
      const ws = (await c.query('SELECT max_clients FROM marketing.workspaces WHERE id=$1', [wsId])).rows[0];
      const used = (await c.query('SELECT COUNT(*)::int AS n FROM marketing.clients WHERE workspace_id=$1 AND archived=false', [wsId])).rows[0].n;
      return { max: ws ? ws.max_clients : 0, used };
    });
    if (limit.used >= limit.max) {
      return res.status(403).json({ error: `Je licentie staat maximaal ${limit.max} actieve klanten toe. Archiveer een klant of upgrade de licentie.` });
    }

    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.clients (workspace_id, name, contact_name, contact_email, website, brand_color, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, contact_name, contact_email, website, brand_color, status, archived, created_at`,
      [wsId, String(name).trim(), contact_name || null, contact_email || null, website || null, brand_color || null, notes || null, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, client: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eén klant ophalen (alleen binnen eigen workspace).
router.get('/api/mkt/clients/:id', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.id)) return res.status(403).json({ error: 'Geen toegang' });
    const row = await withReadConnection(async (c) => (await c.query(
      `SELECT * FROM marketing.clients WHERE id=$1 AND workspace_id=$2`,
      [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Klant niet gevonden' });
    res.json({ success: true, client: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Klant bijwerken (owner/manager/member).
router.patch('/api/mkt/clients/:id', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om klanten te beheren' });
    const b = req.body || {};
    const sets = [], vals = []; let i = 1;
    const map = { name: 'name', contact_name: 'contact_name', contact_email: 'contact_email', website: 'website', brand_color: 'brand_color', notes: 'notes' };
    for (const k of Object.keys(map)) {
      if (b[k] !== undefined) { sets.push(`${map[k]}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
    }
    if (b.status !== undefined && CLIENT_STATUS.includes(b.status)) { sets.push(`status=$${i++}`); vals.push(b.status); }
    if (typeof b.archived === 'boolean') { sets.push(`archived=$${i++}`); vals.push(b.archived); }
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
    vals.push(req.params.id, req.session.mkt.workspaceId);
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.clients SET ${sets.join(', ')} WHERE id=$${i++} AND workspace_id=$${i} RETURNING *`, vals
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Klant niet gevonden' });
    res.json({ success: true, client: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Klant verwijderen (alleen owner/manager).
router.delete('/api/mkt/clients/:id', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen een eigenaar of manager kan een klant verwijderen' });
    const done = await withWriteConnection(async (c) => (await c.query(
      `DELETE FROM marketing.clients WHERE id=$1 AND workspace_id=$2 RETURNING id`,
      [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Klant niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 3 - CONTENTKALENDER (posts per klant)
// Alles strikt gescopet op workspace_id EN de klant moet in die workspace zitten.
// =======================================================================
const POST_STATUS = ['idea', 'draft', 'scheduled', 'approved', 'published'];
const POST_CHANNELS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'blog', 'other'];
// Vaste labels (gekleurde tags) op contentkaarten; alleen deze sleutels worden opgeslagen.
const CONTENT_LABEL_KEYS = ['tekst_geschreven', 'beeld_nodig', 'klaar_controle', 'wordt_overlegd', 'klaar_inplannen', 'nog_editen', 'goedgekeurd', 'gepost'];

// Detecteren of migratie 007 al gedraaid is (labels-kolom + opmerkingen-tabel).
// We cachen het resultaat zodat we niet elke request opnieuw kijken.
let _hasContentLabels = null;
let _hasContentComments = null;
async function contentLabelsAvailable() {
  if (_hasContentLabels === true) return true; // alleen een 'ja' onthouden
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='labels'"
    )).rows);
    if (r.length > 0) _hasContentLabels = true;
    return r.length > 0;
  } catch (_) { return false; }
}
async function contentCommentsAvailable() {
  if (_hasContentComments === true) return true; // alleen een 'ja' onthouden
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='content_comments'"
    )).rows);
    if (r.length > 0) _hasContentComments = true;
    return r.length > 0;
  } catch (_) { return false; }
}
let _hasContentBlocks = null;
async function contentBlocksAvailable() {
  if (_hasContentBlocks === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='content_blocks'"
    )).rows);
    if (r.length > 0) _hasContentBlocks = true;
    return r.length > 0;
  } catch (_) { return false; }
}
const POST_TYPES = ['bericht', 'reel', 'story', 'carrousel'];
let _hasPostType = null;
async function postTypeAvailable() {
  if (_hasPostType === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='post_type'"
    )).rows);
    if (r.length > 0) _hasPostType = true;
    return r.length > 0;
  } catch (_) { return false; }
}
let _hasFollowerSnapshots = null;
async function followerSnapshotsAvailable() {
  if (_hasFollowerSnapshots === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='follower_snapshots'"
    )).rows);
    if (r.length > 0) _hasFollowerSnapshots = true;
    return r.length > 0;
  } catch (_) { return false; }
}
let _hasClientItems = null;
async function clientItemsAvailable() {
  if (_hasClientItems === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='client_items'"
    )).rows);
    if (r.length > 0) _hasClientItems = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Zijn de extra to-do-kolommen (toegewezen persoon + deadline) al aanwezig?
// (migratie 014). Zo niet, dan werkt de to-do als voorheen (zonder taggen/deadline).
let _hasClientItemsExtra = null;
async function clientItemsEnhancedAvailable() {
  if (_hasClientItemsExtra === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='client_items' AND column_name='due_date'"
    )).rows);
    if (r.length > 0) _hasClientItemsExtra = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Alleen een account uit deze workspace dat geen klant-login is kan een taak krijgen.
// Ongeldige waarde valt terug op null (niet toegewezen).
async function validateAssignee(wsId, val) {
  if (val === undefined || val === null || val === '') return null;
  const id = parseInt(val, 10);
  if (!Number.isInteger(id)) return null;
  const ok = await withReadConnection(async (c) => (await c.query(
    "SELECT 1 FROM marketing.accounts WHERE id=$1 AND workspace_id=$2 AND role <> 'client'", [id, wsId]
  )).rows[0]);
  return ok ? id : null;
}
function validateDueDate(val) {
  if (val === undefined || val === null || val === '') return null;
  const s = String(val).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return s;
}
let _hasContentLabelDefs = null;
async function contentLabelDefsAvailable() {
  if (_hasContentLabelDefs === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='content_labels'"
    )).rows);
    if (r.length > 0) _hasContentLabelDefs = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Zijn de eigen Planning-kolommen beschikbaar (migratie 015)?
let _hasContentColumns = null;
async function contentColumnsAvailable() {
  if (_hasContentColumns === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='content_columns'"
    )).rows);
    if (r.length > 0) _hasContentColumns = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Kleur per kolom (migratie 020). Degradeert netjes: tot de migratie gedraaid is
// werkt het hernoemen gewoon, alleen de kleur wordt dan nog niet bewaard.
let _hasColumnColor = null;
async function contentColumnsColorAvailable() {
  if (_hasColumnColor === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_columns' AND column_name='color'"
    )).rows);
    if (r.length > 0) _hasColumnColor = true;
    return r.length > 0;
  } catch (_) { return false; }
}
function validColHexColor(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null; // leeg = geen kleur
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : undefined; // undefined = ongeldig
}
// De vier standaardkolommen van het Planning-bord. Worden de eerste keer in de
// database gezet (per werkplek) zodat ze daarna te hernoemen/verplaatsen/verwijderen zijn.
const DEFAULT_CONTENT_COLS = [
  { col_key: 'idea', label: 'Ideeen' },
  { col_key: 'draft', label: 'Concept' },
  { col_key: 'scheduled', label: 'Ingepland' },
  { col_key: 'approved', label: 'Goedgekeurd' },
];
// Een post-status is geldig als het een standaardstatus is (POST_STATUS) of een
// eigen kolom-sleutel van deze werkplek. Zo kun je posts naar eigen kolommen slepen.
async function isValidPostStatus(wsId, status) {
  if (status == null) return false;
  if (POST_STATUS.includes(status)) return true;
  if (!(await contentColumnsAvailable())) return false;
  const ok = await withReadConnection(async (c) => (await c.query(
    'SELECT 1 FROM marketing.content_columns WHERE workspace_id=$1 AND col_key=$2', [wsId, String(status)]
  )).rows[0]);
  return !!ok;
}
// Zijn de kaart-extra's (toegewezen personen + checklist) beschikbaar (migratie 016)?
let _hasPostExtras = null;
async function postExtrasAvailable() {
  if (_hasPostExtras === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='checklist'"
    )).rows);
    if (r.length > 0) _hasPostExtras = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Is de handmatige kolom-volgorde (board_position) beschikbaar (migratie 017)?
let _hasBoardPos = null;
async function postBoardPosAvailable() {
  if (_hasBoardPos === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='board_position'"
    )).rows);
    if (r.length > 0) _hasBoardPos = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Zijn carousel-posts beschikbaar (migratie 018)?
let _hasCarousel = null;
async function postCarouselAvailable() {
  if (_hasCarousel === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='carousel_asset_ids'"
    )).rows);
    if (r.length > 0) _hasCarousel = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Is de week-indeling (board_week, los van de status) beschikbaar (migratie 019)?
let _hasBoardWeek = null;
async function postBoardWeekAvailable() {
  if (_hasBoardWeek === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='board_week'"
    )).rows);
    if (r.length > 0) _hasBoardWeek = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Is de omslagkleur van een kaart beschikbaar (migratie 021)?
let _hasCoverColor = null;
async function postCoverAvailable() {
  if (_hasCoverColor === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='marketing' AND table_name='content_posts' AND column_name='cover_color'"
    )).rows);
    if (r.length > 0) _hasCoverColor = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Controleert dat een lijst asset-ids bij deze klant hoort en publiek (Cloudinary) is;
// geeft ze terug in dezelfde volgorde als gevraagd, met url + type.
async function resolveCarouselAssets(wsId, clientId, ids) {
  const clean = (Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Number.isInteger).slice(0, 10);
  if (!clean.length) return [];
  const rows = await withReadConnection(async (c) => (await c.query(
    "SELECT id, url, resource_type, provider FROM marketing.assets WHERE id = ANY($1::int[]) AND client_id=$2 AND workspace_id=$3",
    [clean, clientId, wsId]
  )).rows);
  const byId = {}; rows.forEach((a) => { byId[a.id] = a; });
  return clean.map((id) => byId[id]).filter((a) => a && a.provider === 'cloudinary' && a.url)
    .map((a) => ({ id: a.id, url: a.url, mediaType: a.resource_type === 'video' ? 'video' : 'image' }));
}
// Is het activiteiten-log beschikbaar (migratie 016)?
let _hasPostActivity = null;
async function postActivityAvailable() {
  if (_hasPostActivity === true) return true;
  try {
    const r = await withReadConnection(async (c) => (await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='marketing' AND table_name='content_post_activity'"
    )).rows);
    if (r.length > 0) _hasPostActivity = true;
    return r.length > 0;
  } catch (_) { return false; }
}
// Een activiteit vastleggen (best-effort; nooit de hoofdactie laten mislukken).
async function logPostActivity(wsId, postId, actorId, actorName, action, detail) {
  try {
    if (!(await postActivityAvailable())) return;
    await withWriteConnection(async (c) => c.query(
      'INSERT INTO marketing.content_post_activity (workspace_id, post_id, actor_account_id, actor_name, action, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [wsId, postId, actorId || null, actorName || null, String(action).slice(0, 40), detail != null ? String(detail).slice(0, 300) : null]
    ));
  } catch (_) { /* log is bijzaak */ }
}
// Opschonen van een checklist uit de client: [{text, done}], max 50 items.
function sanitizeChecklist(input) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, 50).map((x) => ({
    text: String((x && x.text) || '').slice(0, 300),
    done: !!(x && x.done),
  })).filter((x) => x.text);
}
// Alleen geldige workspace-leden (geen klant-login) als toegewezen personen.
async function sanitizeAssignees(wsId, input) {
  if (!Array.isArray(input) || !input.length) return [];
  const ids = [...new Set(input.map((x) => parseInt(x, 10)).filter(Number.isInteger))];
  if (!ids.length) return [];
  const rows = await withReadConnection(async (c) => (await c.query(
    "SELECT id FROM marketing.accounts WHERE workspace_id=$1 AND role <> 'client' AND id = ANY($2::int[])", [wsId, ids]
  )).rows);
  return rows.map((r) => r.id);
}
// Blokken opschonen: max 30 blokken, tekst max 4000 tekens, type text|media.
function sanitizeBlocks(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const b of input) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'media') { out.push({ type: 'media' }); }
    else if (b.type === 'text') { out.push({ type: 'text', text: String(b.text || '').slice(0, 4000) }); }
    if (out.length >= 30) break;
  }
  return out;
}

// Controleert dat de klant bestaat EN bij de actieve workspace hoort.
// Geeft het klant-id terug, of null als het niet mag.
async function clientInWorkspace(clientId, wsId) {
  return await withReadConnection(async (c) => {
    const row = (await c.query(
      'SELECT id FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [clientId, wsId]
    )).rows[0];
    return row ? row.id : null;
  });
}

// Lijst posts van een klant (optioneel filteren op status), nieuwste/geplande eerst.
router.get('/api/mkt/clients/:clientId/posts', requireMkt, async (req, res) => {
  try {
    const wsId = req.session.mkt.workspaceId;
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = String(req.query.status || '');
    const filterStatus = POST_STATUS.includes(status) ? status : null;
    // Klant-account ziet alleen wat gedeeld is (ter goedkeuring, goedgekeurd of wijzigingen).
    const clientOnly = mktClientLocked(req);
    const hasLabels = await contentLabelsAvailable();
    const hasComments = await contentCommentsAvailable();
    const hasBlocks = await contentBlocksAvailable();
    const hasType = await postTypeAvailable();
    const hasExtras = await postExtrasAvailable();
    const hasBoardPos = await postBoardPosAvailable();
    const hasCarousel = await postCarouselAvailable();
    const hasBoardWeek = await postBoardWeekAvailable();
    const hasCover = await postCoverAvailable();
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT p.id, p.client_id, p.title, p.body, p.channel, p.status, p.scheduled_at,
              p.approval, p.approval_note, p.approval_at, p.client_note, p.created_at, p.updated_at,
              p.auto_publish, p.publish_channel, p.published_at, p.publish_error,
              ${hasLabels ? 'p.labels,' : ''}
              ${hasBlocks ? 'p.content_blocks,' : ''}
              ${hasType ? 'p.post_type,' : ''}
              ${hasExtras ? 'p.assignees, p.checklist,' : ''}
              ${hasBoardPos ? 'p.board_position,' : ''}
              ${hasCarousel ? 'p.carousel_asset_ids,' : ''}
              ${hasBoardWeek ? 'p.board_week,' : ''}
              ${hasCover ? 'p.cover_color,' : ''}
              ${hasComments ? '(SELECT COUNT(*)::int FROM marketing.content_comments cc WHERE cc.post_id=p.id) AS comment_count,' : ''}
              p.asset_id, a.url AS asset_url, a.resource_type AS asset_type, a.filename AS asset_name
         FROM marketing.content_posts p
         LEFT JOIN marketing.assets a ON a.id = p.asset_id
        WHERE p.workspace_id=$1 AND p.client_id=$2
          ${filterStatus ? 'AND p.status=$3' : ''}
          ${clientOnly ? "AND (p.approval <> 'none' OR p.status='published')" : ''}
        ORDER BY p.scheduled_at ASC NULLS LAST, p.created_at DESC`,
      filterStatus ? [wsId, okClient, filterStatus] : [wsId, okClient]
    )).rows);
    res.json({ success: true, posts: rows, extras: hasExtras, activity: await postActivityAvailable() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nieuwe post aanmaken voor een klant.
router.post('/api/mkt/clients/:clientId/posts', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const { title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Titel is verplicht' });
    const ch = POST_CHANNELS.includes(channel) ? channel : 'other';
    const st = (await isValidPostStatus(wsId, status)) ? status : 'idea';
    let when = null;
    if (scheduled_at) {
      const d = new Date(scheduled_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Ongeldige planningsdatum' });
      when = d;
    }
    // Optionele koppeling aan een asset: moet bij dezelfde klant horen.
    let assetId = null;
    if (asset_id) {
      const ok = await withReadConnection(async (c) => (await c.query(
        'SELECT id FROM marketing.assets WHERE id=$1 AND client_id=$2 AND workspace_id=$3', [asset_id, okClient, wsId]
      )).rows[0]);
      if (ok) assetId = ok.id;
    }
    const autoPub = auto_publish === true && !!when;
    const pubCh = (publish_channel === 'facebook') ? 'facebook' : 'instagram';
    const extras = await postExtrasAvailable();
    const assignees = extras ? await sanitizeAssignees(wsId, req.body && req.body.assignees) : [];
    const checklist = extras ? (sanitizeChecklist(req.body && req.body.checklist) || []) : [];
    const row = await withWriteConnection(async (c) => (await c.query(
      extras
        ? `INSERT INTO marketing.content_posts (workspace_id, client_id, title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel, created_by, assignees, checklist)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             RETURNING id, client_id, title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel, approval, approval_note, approval_at, created_at, updated_at, assignees, checklist`
        : `INSERT INTO marketing.content_posts (workspace_id, client_id, title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id, client_id, title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel, approval, approval_note, approval_at, created_at, updated_at`,
      extras
        ? [wsId, okClient, String(title).trim(), body || null, ch, st, when, assetId, autoPub, pubCh, req.session.mkt.accountId || null, assignees, JSON.stringify(checklist)]
        : [wsId, okClient, String(title).trim(), body || null, ch, st, when, assetId, autoPub, pubCh, req.session.mkt.accountId || null]
    )).rows[0]);
    // Carousel-bestanden opslaan (als meegegeven en de kolom beschikbaar is).
    if (Array.isArray(req.body && req.body.carousel_asset_ids) && await postCarouselAvailable()) {
      const items = await resolveCarouselAssets(wsId, okClient, req.body.carousel_asset_ids);
      const cids = items.map((x) => x.id);
      try { await withWriteConnection(async (c) => c.query('UPDATE marketing.content_posts SET carousel_asset_ids=$1 WHERE id=$2 AND workspace_id=$3', [cids, row.id, wsId])); row.carousel_asset_ids = cids; } catch (_) { /* niet blokkerend */ }
    }
    // Week (los van de status) opslaan.
    if (req.body && req.body.board_week !== undefined && await postBoardWeekAvailable()) {
      let wk = null; const n = parseInt(req.body.board_week, 10); if (Number.isInteger(n) && n >= 1 && n <= 5) wk = n;
      try { await withWriteConnection(async (c) => c.query('UPDATE marketing.content_posts SET board_week=$1 WHERE id=$2 AND workspace_id=$3', [wk, row.id, wsId])); row.board_week = wk; } catch (_) { /* niet blokkerend */ }
    }
    await logPostActivity(wsId, row.id, req.session.mkt.accountId, req.session.mkt.email, 'created', null);
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post bijwerken (titel, tekst, kanaal, status, planning).
router.patch('/api/mkt/posts/:id', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const b = req.body || {};
    const extras = await postExtrasAvailable();
    // Oude status onthouden om een verplaatsing in het activiteiten-log te zetten.
    let oldStatus = null;
    if (b.status !== undefined) {
      oldStatus = await withReadConnection(async (c) => { const r = (await c.query('SELECT status FROM marketing.content_posts WHERE id=$1 AND workspace_id=$2', [req.params.id, wsId])).rows[0]; return r ? r.status : null; });
    }
    const sets = [], vals = []; let i = 1;
    if (b.title !== undefined) {
      if (!String(b.title).trim()) return res.status(400).json({ error: 'Titel mag niet leeg zijn' });
      sets.push(`title=$${i++}`); vals.push(String(b.title).trim());
    }
    if (b.body !== undefined) { sets.push(`body=$${i++}`); vals.push(b.body === '' ? null : b.body); }
    if (b.channel !== undefined && POST_CHANNELS.includes(b.channel)) { sets.push(`channel=$${i++}`); vals.push(b.channel); }
    if (b.status !== undefined && await isValidPostStatus(wsId, b.status)) { sets.push(`status=$${i++}`); vals.push(b.status); }
    if (b.post_type !== undefined && POST_TYPES.includes(b.post_type) && await postTypeAvailable()) { sets.push(`post_type=$${i++}`); vals.push(b.post_type); }
    if (b.carousel_asset_ids !== undefined && await postCarouselAvailable()) {
      const prow = await withReadConnection(async (c) => (await c.query('SELECT client_id FROM marketing.content_posts WHERE id=$1 AND workspace_id=$2', [req.params.id, wsId])).rows[0]);
      if (prow) { const items = await resolveCarouselAssets(wsId, prow.client_id, b.carousel_asset_ids); sets.push(`carousel_asset_ids=$${i++}`); vals.push(items.map((x) => x.id)); }
    }
    if (b.board_week !== undefined && await postBoardWeekAvailable()) {
      let wk = null; const n = parseInt(b.board_week, 10); if (Number.isInteger(n) && n >= 1 && n <= 5) wk = n;
      sets.push(`board_week=$${i++}`); vals.push(wk);
    }
    if (b.cover_color !== undefined && await postCoverAvailable()) {
      const cc = validColHexColor(b.cover_color); if (cc === undefined) return res.status(400).json({ error: 'Ongeldige omslagkleur (gebruik #RRGGBB)' });
      sets.push(`cover_color=$${i++}`); vals.push(cc);
    }
    if (b.labels !== undefined && await contentLabelsAvailable()) {
      const clean = Array.isArray(b.labels) ? b.labels.map((x) => String(x)).filter((x) => CONTENT_LABEL_KEYS.includes(x) || /^c\d+$/.test(x)) : [];
      sets.push(`labels=$${i++}`); vals.push(clean);
    }
    if (b.blocks !== undefined && await contentBlocksAvailable()) {
      const clean = sanitizeBlocks(b.blocks);
      if (clean) {
        sets.push(`content_blocks=$${i++}::jsonb`); vals.push(JSON.stringify(clean));
        // body synchroon houden met de tekstblokken (voor caption/publiceren) als de client geen aparte body meestuurt.
        if (b.body === undefined) {
          const joined = clean.filter((x) => x.type === 'text' && x.text).map((x) => x.text).join('\n\n');
          sets.push(`body=$${i++}`); vals.push(joined || null);
        }
      }
    }
    if (extras && b.assignees !== undefined) { const a = await sanitizeAssignees(wsId, b.assignees); sets.push(`assignees=$${i++}`); vals.push(a); }
    if (extras && b.checklist !== undefined) { const cl = sanitizeChecklist(b.checklist) || []; sets.push(`checklist=$${i++}::jsonb`); vals.push(JSON.stringify(cl)); }
    // Marketeer mag alleen 'ter goedkeuring' zetten of intrekken; goedkeuren doet de klant via de portal.
    if (b.approval !== undefined && (b.approval === 'pending' || b.approval === 'none')) {
      sets.push(`approval=$${i++}`); vals.push(b.approval);
      sets.push(`approval_note=NULL`); sets.push(`approval_at=NULL`);
    }
    if (b.scheduled_at !== undefined) {
      if (b.scheduled_at === '' || b.scheduled_at === null) { sets.push(`scheduled_at=$${i++}`); vals.push(null); }
      else {
        const d = new Date(b.scheduled_at);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Ongeldige planningsdatum' });
        sets.push(`scheduled_at=$${i++}`); vals.push(d);
      }
    }
    // Asset koppelen of loskoppelen. Alleen een asset van dezelfde klant is toegestaan.
    if (b.asset_id !== undefined) {
      if (!b.asset_id) { sets.push(`asset_id=$${i++}`); vals.push(null); }
      else {
        const ok = await withReadConnection(async (c) => (await c.query(
          `SELECT a.id FROM marketing.assets a
             JOIN marketing.content_posts p ON p.client_id = a.client_id
            WHERE a.id=$1 AND p.id=$2 AND a.workspace_id=$3`, [b.asset_id, req.params.id, wsId]
        )).rows[0]);
        if (ok) { sets.push(`asset_id=$${i++}`); vals.push(ok.id); }
      }
    }
    if (b.publish_channel !== undefined && (b.publish_channel === 'instagram' || b.publish_channel === 'facebook')) {
      sets.push(`publish_channel=$${i++}`); vals.push(b.publish_channel);
    }
    // Automatisch publiceren aan/uit. Bij aanzetten: teller en status resetten zodat de planner opnieuw kan afvuren.
    if (b.auto_publish !== undefined) {
      const on = b.auto_publish === true;
      sets.push(`auto_publish=$${i++}`); vals.push(on);
      if (on) { sets.push(`publish_attempts=0`); sets.push(`published_at=NULL`); sets.push(`publish_error=NULL`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
    sets.push(`updated_at=now()`);
    vals.push(req.params.id, wsId);
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_posts SET ${sets.join(', ')}
        WHERE id=$${i++} AND workspace_id=$${i}
       RETURNING id, client_id, title, body, channel, status, scheduled_at, asset_id, auto_publish, publish_channel, published_at, publish_error, approval, approval_note, approval_at, created_at, updated_at${extras ? ', assignees, checklist' : ''}`, vals
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });
    if (b.status !== undefined && oldStatus !== null && row.status !== oldStatus) {
      await logPostActivity(wsId, row.id, req.session.mkt.accountId, req.session.mkt.email, 'moved', row.status);
    }
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post verwijderen.
router.delete('/api/mkt/posts/:id', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const done = await withWriteConnection(async (c) => (await c.query(
      `DELETE FROM marketing.content_posts WHERE id=$1 AND workspace_id=$2 RETURNING id`,
      [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Post niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activiteiten-log van een kaart (aangemaakt, verplaatst, ...).
router.get('/api/mkt/clients/:clientId/posts/:postId/activity', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await postActivityAvailable())) return res.json({ success: true, activity: [] });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (!(await postInClient(req.params.postId, okClient, wsId))) return res.status(404).json({ error: 'Kaart niet gevonden' });
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, actor_account_id, actor_name, action, detail, created_at
         FROM marketing.content_post_activity
        WHERE workspace_id=$1 AND post_id=$2
        ORDER BY created_at DESC LIMIT 50`, [wsId, req.params.postId]
    )).rows);
    res.json({ success: true, activity: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Handmatige volgorde van kaarten binnen een kolom opslaan (verticaal slepen).
// Ontvangt de volledige volgorde van post-ids van een kolom en zet board_position.
router.post('/api/mkt/clients/:clientId/posts/reorder', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (!(await postBoardPosAvailable())) return res.json({ success: true, saved: false });
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    if (!ids.length) return res.json({ success: true, saved: true });
    await withWriteConnection(async (c) => {
      for (let i = 0; i < ids.length; i++) {
        await c.query(
          'UPDATE marketing.content_posts SET board_position=$1 WHERE id=$2 AND workspace_id=$3 AND client_id=$4',
          [i, ids[i], wsId, okClient]
        );
      }
    });
    res.json({ success: true, saved: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Opmerkingen op een contentkaart (agency <-> klant) ----
// Controleert dat de post bij deze klant + workspace hoort.
async function postInClient(postId, clientId, wsId) {
  return await withReadConnection(async (c) => (await c.query(
    'SELECT id FROM marketing.content_posts WHERE id=$1 AND client_id=$2 AND workspace_id=$3', [postId, clientId, wsId]
  )).rows[0]);
}
router.get('/api/mkt/clients/:clientId/posts/:postId/comments', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentCommentsAvailable())) return res.json({ success: true, comments: [] });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, author_account_id, author_role, author_name, body, created_at, updated_at
         FROM marketing.content_comments WHERE workspace_id=$1 AND client_id=$2 AND post_id=$3 ORDER BY created_at ASC`,
      [wsId, okClient, req.params.postId]
    )).rows);
    res.json({ success: true, comments: rows, me: req.session.mkt.accountId || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/clients/:clientId/posts/:postId/comments', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentCommentsAvailable())) return res.status(503).json({ error: 'Opmerkingen zijn nog niet ingeschakeld (migratie 007 nog niet gedraaid).' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (!(await postInClient(req.params.postId, okClient, wsId))) return res.status(404).json({ error: 'Post niet gevonden' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Bericht is leeg' });
    if (body.length > 4000) return res.status(400).json({ error: 'Bericht te lang (max 4000 tekens)' });
    const m = req.session.mkt;
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.content_comments (workspace_id, client_id, post_id, author_account_id, author_role, author_name, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, author_account_id, author_role, author_name, body, created_at, updated_at`,
      [wsId, okClient, req.params.postId, m.accountId || null, m.role || null, m.email || null, body]
    )).rows[0]);
    res.json({ success: true, comment: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/api/mkt/clients/:clientId/posts/:postId/comments/:commentId', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentCommentsAvailable())) return res.status(503).json({ error: 'Opmerkingen zijn nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Bericht is leeg' });
    if (body.length > 4000) return res.status(400).json({ error: 'Bericht te lang (max 4000 tekens)' });
    const m = req.session.mkt;
    const out = await withWriteConnection(async (c) => {
      const row = (await c.query('SELECT id, author_account_id FROM marketing.content_comments WHERE id=$1 AND workspace_id=$2 AND client_id=$3 AND post_id=$4', [req.params.commentId, wsId, okClient, req.params.postId])).rows[0];
      if (!row) return { code: 404, error: 'Opmerking niet gevonden' };
      if (!mktMayEditFeedback(m, row)) return { code: 403, error: 'Geen rechten om deze opmerking te bewerken' };
      const upd = (await c.query('UPDATE marketing.content_comments SET body=$1, updated_at=now() WHERE id=$2 RETURNING id, author_account_id, author_role, author_name, body, created_at, updated_at', [body, req.params.commentId])).rows[0];
      return { comment: upd };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ success: true, comment: out.comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/api/mkt/clients/:clientId/posts/:postId/comments/:commentId', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentCommentsAvailable())) return res.status(503).json({ error: 'Opmerkingen zijn nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const m = req.session.mkt;
    const out = await withWriteConnection(async (c) => {
      const row = (await c.query('SELECT id, author_account_id FROM marketing.content_comments WHERE id=$1 AND workspace_id=$2 AND client_id=$3 AND post_id=$4', [req.params.commentId, wsId, okClient, req.params.postId])).rows[0];
      if (!row) return { code: 404, error: 'Opmerking niet gevonden' };
      if (!mktMayEditFeedback(m, row)) return { code: 403, error: 'Geen rechten om deze opmerking te verwijderen' };
      await c.query('DELETE FROM marketing.content_comments WHERE id=$1', [req.params.commentId]);
      return { ok: true };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Client-items: To do en Documenten per klant ----
router.get('/api/mkt/clients/:clientId/items', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await clientItemsAvailable())) return res.json({ success: true, items: [], enhanced: false });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const kind = (req.query.kind === 'document') ? 'document' : 'todo';
    const enhanced = await clientItemsEnhancedAvailable();
    const rows = await withReadConnection(async (c) => (await c.query(
      enhanced
        ? `SELECT ci.id, ci.kind, ci.title, ci.url, ci.done, ci.created_at,
                  ci.assignee_account_id, to_char(ci.due_date,'YYYY-MM-DD') AS due_date,
                  COALESCE(ac.full_name, ac.email) AS assignee_name
             FROM marketing.client_items ci
             LEFT JOIN marketing.accounts ac ON ac.id = ci.assignee_account_id
            WHERE ci.workspace_id=$1 AND ci.client_id=$2 AND ci.kind=$3
            ORDER BY ci.done ASC, ci.due_date ASC NULLS LAST, ci.created_at DESC`
        : 'SELECT id, kind, title, url, done, created_at FROM marketing.client_items WHERE workspace_id=$1 AND client_id=$2 AND kind=$3 ORDER BY done ASC, created_at DESC',
      [wsId, okClient, kind]
    )).rows);
    res.json({ success: true, items: rows, enhanced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/clients/:clientId/items', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await clientItemsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld (migratie 010 nog niet gedraaid).' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const kind = (req.body && req.body.kind === 'document') ? 'document' : 'todo';
    const title = String((req.body && req.body.title) || '').trim();
    if (!title) return res.status(400).json({ error: 'Titel is verplicht' });
    let url = String((req.body && req.body.url) || '').trim().slice(0, 2000) || null;
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    const enhanced = await clientItemsEnhancedAvailable();
    const assignee = enhanced ? await validateAssignee(wsId, req.body && req.body.assignee_account_id) : null;
    const due = enhanced ? validateDueDate(req.body && req.body.due_date) : null;
    const row = await withWriteConnection(async (c) => (await c.query(
      enhanced
        ? `INSERT INTO marketing.client_items (workspace_id, client_id, kind, title, url, created_by, assignee_account_id, due_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id, kind, title, url, done, created_at, assignee_account_id, to_char(due_date,'YYYY-MM-DD') AS due_date`
        : `INSERT INTO marketing.client_items (workspace_id, client_id, kind, title, url, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, title, url, done, created_at`,
      enhanced
        ? [wsId, okClient, kind, title.slice(0, 500), url, req.session.mkt.accountId || null, assignee, due]
        : [wsId, okClient, kind, title.slice(0, 500), url, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, item: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/api/mkt/clients/:clientId/items/:id', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await clientItemsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const enhanced = await clientItemsEnhancedAvailable();
    const b = req.body || {}; const sets = []; const vals = []; let i = 1;
    if (b.title !== undefined) { if (!String(b.title).trim()) return res.status(400).json({ error: 'Titel mag niet leeg zijn' }); sets.push(`title=$${i++}`); vals.push(String(b.title).trim().slice(0, 500)); }
    if (b.url !== undefined) { let u = String(b.url || '').trim().slice(0, 2000); if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u; sets.push(`url=$${i++}`); vals.push(u || null); }
    if (b.done !== undefined) { sets.push(`done=$${i++}`); vals.push(b.done === true); }
    if (enhanced && b.assignee_account_id !== undefined) { const a = await validateAssignee(wsId, b.assignee_account_id); sets.push(`assignee_account_id=$${i++}`); vals.push(a); }
    if (enhanced && b.due_date !== undefined) { const dd = validateDueDate(b.due_date); sets.push(`due_date=$${i++}`); vals.push(dd); }
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
    vals.push(req.params.id, wsId, okClient);
    const ret = enhanced
      ? `id, kind, title, url, done, created_at, assignee_account_id, to_char(due_date,'YYYY-MM-DD') AS due_date`
      : `id, kind, title, url, done, created_at`;
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.client_items SET ${sets.join(', ')} WHERE id=$${i++} AND workspace_id=$${i++} AND client_id=$${i} RETURNING ${ret}`, vals
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Item niet gevonden' });
    res.json({ success: true, item: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/api/mkt/clients/:clientId/items/:id', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await clientItemsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const done = await withWriteConnection(async (c) => (await c.query(
      'DELETE FROM marketing.client_items WHERE id=$1 AND workspace_id=$2 AND client_id=$3 RETURNING id', [req.params.id, wsId, okClient]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Item niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Teamleden van deze workspace (geen klant-logins). Voor het taggen van een to-do.
router.get('/api/mkt/members', requireMkt, async (req, res) => {
  try {
    const wsId = req.session.mkt.workspaceId;
    const rows = await withReadConnection(async (c) => (await c.query(
      "SELECT id, COALESCE(full_name, email) AS name, email FROM marketing.accounts WHERE workspace_id=$1 AND role <> 'client' AND active=true ORDER BY COALESCE(full_name, email) ASC",
      [wsId]
    )).rows);
    res.json({ success: true, members: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Beheer: de client-logins (rol 'client') gegroepeerd per klant. Alleen eigenaar/manager.
router.get('/api/mkt/client-users', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const data = await withReadConnection(async (c) => {
      const clients = (await c.query(
        'SELECT id, name FROM marketing.clients WHERE workspace_id=$1 ORDER BY name ASC', [wsId]
      )).rows;
      const users = (await c.query(
        "SELECT id, client_id, COALESCE(full_name, email) AS name, email, active, to_char(last_login_at,'YYYY-MM-DD') AS last_login FROM marketing.accounts WHERE workspace_id=$1 AND role='client' AND client_id IS NOT NULL ORDER BY COALESCE(full_name, email) ASC",
        [wsId]
      )).rows;
      return { clients, users };
    });
    const byClient = {};
    data.users.forEach((u) => { (byClient[u.client_id] = byClient[u.client_id] || []).push({ id: u.id, name: u.name, email: u.email, active: u.active, last_login: u.last_login }); });
    const clients = data.clients.map((cl) => ({ id: cl.id, name: cl.name, users: byClient[cl.id] || [] }));
    res.json({ success: true, clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Beheer: een client-login toevoegen voor een klant (eigenaar/manager).
router.post('/api/mkt/client-users', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const { client_id, email, full_name, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord zijn verplicht' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord: minimaal 8 tekens, met een hoofdletter, een kleine letter en een cijfer' });
    if (!client_id) return res.status(400).json({ error: 'Kies een klant om deze client-login aan te koppelen' });
    const em = String(email).toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'Vul een geldig e-mailadres in' });
    const okc = await withReadConnection(async (c) => (await c.query(
      'SELECT id, name FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [client_id, wsId]
    )).rows[0]);
    if (!okc) return res.status(400).json({ error: 'Gekozen klant hoort niet bij deze workspace' });
    const dup = await withReadConnection(async (c) => (await c.query('SELECT 1 FROM marketing.accounts WHERE email=$1', [em])).rows[0]);
    if (dup) return res.status(400).json({ error: 'Dit e-mailadres bestaat al' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.accounts (workspace_id, email, password_hash, full_name, role, client_id)
       VALUES ($1,$2,$3,$4,'client',$5) RETURNING id, email, full_name, client_id`,
      [wsId, em, hash, full_name ? String(full_name).slice(0, 120) : null, okc.id]
    )).rows[0]);
    res.json({ success: true, account: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mijn openstaande to-do's (aan mij toegewezen, nog niet afgevinkt) over alle
// klanten in deze workspace. Voedt het meldingen-badge en de overzichtspagina.
router.get('/api/mkt/my-tasks', requireMkt, async (req, res) => {
  try {
    if (!(await clientItemsAvailable()) || !(await clientItemsEnhancedAvailable())) {
      return res.json({ success: true, tasks: [], total: 0, overdue: 0 });
    }
    const wsId = req.session.mkt.workspaceId;
    const me = req.session.mkt.accountId;
    if (!me) return res.json({ success: true, tasks: [], total: 0, overdue: 0 });
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT ci.id, ci.client_id, ci.title, ci.url, to_char(ci.due_date,'YYYY-MM-DD') AS due_date,
              cl.name AS client_name
         FROM marketing.client_items ci
         JOIN marketing.clients cl ON cl.id = ci.client_id
        WHERE ci.workspace_id=$1 AND ci.kind='todo' AND ci.done=false AND ci.assignee_account_id=$2
        ORDER BY ci.due_date ASC NULLS LAST, ci.created_at DESC`,
      [wsId, me]
    )).rows);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = rows.filter((r) => r.due_date && r.due_date < today).length;
    res.json({ success: true, tasks: rows, total: rows.length, overdue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eerstvolgende geplande posts over alle klanten, voor de overzichtspagina.
router.get('/api/mkt/upcoming-posts', requireMkt, async (req, res) => {
  try {
    const wsId = req.session.mkt.workspaceId;
    const lock = mktClientLocked(req) ? mktLockedClientId(req) : null;
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT p.id, p.client_id, p.title, p.channel, p.status, p.scheduled_at, cl.name AS client_name
         FROM marketing.content_posts p
         JOIN marketing.clients cl ON cl.id = p.client_id
        WHERE p.workspace_id=$1 AND p.scheduled_at IS NOT NULL AND p.scheduled_at >= now()
          AND p.status <> 'published'
          ${lock ? 'AND p.client_id = $2' : ''}
        ORDER BY p.scheduled_at ASC
        LIMIT 8`,
      lock ? [wsId, lock] : [wsId]
    )).rows);
    res.json({ success: true, posts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Eigen (custom) labels per werkplek ----
router.get('/api/mkt/label-defs', requireMkt, async (req, res) => {
  try {
    if (!(await contentLabelDefsAvailable())) return res.json({ success: true, labels: [] });
    const rows = await withReadConnection(async (c) => (await c.query(
      'SELECT id, label, color FROM marketing.content_labels WHERE workspace_id=$1 ORDER BY created_at ASC',
      [req.session.mkt.workspaceId]
    )).rows);
    res.json({ success: true, labels: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/label-defs', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentLabelDefsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld (migratie 011 nog niet gedraaid).' });
    const label = String((req.body && req.body.label) || '').trim().slice(0, 40);
    if (!label) return res.status(400).json({ error: 'Labelnaam is verplicht' });
    let color = String((req.body && req.body.color) || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#6366f1';
    const row = await withWriteConnection(async (c) => (await c.query(
      'INSERT INTO marketing.content_labels (workspace_id, label, color) VALUES ($1,$2,$3) RETURNING id, label, color',
      [req.session.mkt.workspaceId, label, color]
    )).rows[0]);
    res.json({ success: true, label: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/api/mkt/label-defs/:id', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentLabelDefsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld.' });
    const done = await withWriteConnection(async (c) => (await c.query(
      'DELETE FROM marketing.content_labels WHERE id=$1 AND workspace_id=$2 RETURNING id', [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Label niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Eigen kolommen voor de Planning (contentplanning-bord) ----
// Zet de standaardkolommen eenmalig neer als de werkplek er nog geen heeft.
async function ensureContentColumns(wsId) {
  const cnt = await withReadConnection(async (c) => (await c.query(
    'SELECT COUNT(*)::int AS n FROM marketing.content_columns WHERE workspace_id=$1', [wsId]
  )).rows[0].n);
  if (cnt === 0) {
    await withWriteConnection(async (c) => {
      for (let i = 0; i < DEFAULT_CONTENT_COLS.length; i++) {
        const d = DEFAULT_CONTENT_COLS[i];
        await c.query(
          'INSERT INTO marketing.content_columns (workspace_id, col_key, label, position) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, col_key) DO NOTHING',
          [wsId, d.col_key, d.label, i]
        );
      }
    });
  }
}
router.get('/api/mkt/columns', requireMkt, async (req, res) => {
  try {
    if (!(await contentColumnsAvailable())) {
      return res.json({ success: true, columns: DEFAULT_CONTENT_COLS.map((d, i) => ({ id: null, col_key: d.col_key, label: d.label, position: i })), custom: false });
    }
    const wsId = req.session.mkt.workspaceId;
    await ensureContentColumns(wsId);
    const hasColor = await contentColumnsColorAvailable();
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, col_key, label, position${hasColor ? ', color' : ''} FROM marketing.content_columns WHERE workspace_id=$1 ORDER BY position ASC, id ASC`, [wsId]
    )).rows);
    res.json({ success: true, columns: rows, custom: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/columns', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentColumnsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld (migratie 015 nog niet gedraaid).' });
    const wsId = req.session.mkt.workspaceId;
    await ensureContentColumns(wsId);
    const label = String((req.body && req.body.label) || '').trim().slice(0, 40);
    if (!label) return res.status(400).json({ error: 'Kolomnaam is verplicht' });
    const hasColor = await contentColumnsColorAvailable();
    let color = null;
    if (hasColor) { const cc = validColHexColor(req.body && req.body.color); if (cc === undefined) return res.status(400).json({ error: 'Ongeldige kleur (gebruik #RRGGBB)' }); color = cc; }
    const colKey = 'col_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const row = await withWriteConnection(async (c) => {
      const pos = (await c.query('SELECT COALESCE(MAX(position),-1)+1 AS p FROM marketing.content_columns WHERE workspace_id=$1', [wsId])).rows[0].p;
      return (await c.query(
        hasColor
          ? 'INSERT INTO marketing.content_columns (workspace_id, col_key, label, position, color) VALUES ($1,$2,$3,$4,$5) RETURNING id, col_key, label, position, color'
          : 'INSERT INTO marketing.content_columns (workspace_id, col_key, label, position) VALUES ($1,$2,$3,$4) RETURNING id, col_key, label, position',
        hasColor ? [wsId, colKey, label, pos, color] : [wsId, colKey, label, pos]
      )).rows[0];
    });
    res.json({ success: true, column: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/api/mkt/columns/:id', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentColumnsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const hasColor = await contentColumnsColorAvailable();
    const b = req.body || {}; const sets = []; const vals = []; let i = 1;
    if (b.label !== undefined) { const l = String(b.label).trim().slice(0, 40); if (!l) return res.status(400).json({ error: 'Kolomnaam mag niet leeg zijn' }); sets.push(`label=$${i++}`); vals.push(l); }
    if (b.position !== undefined) { const p = parseInt(b.position, 10); if (Number.isInteger(p)) { sets.push(`position=$${i++}`); vals.push(p); } }
    if (hasColor && b.color !== undefined) { const cc = validColHexColor(b.color); if (cc === undefined) return res.status(400).json({ error: 'Ongeldige kleur (gebruik #RRGGBB)' }); sets.push(`color=$${i++}`); vals.push(cc); }
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
    vals.push(req.params.id, wsId);
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_columns SET ${sets.join(', ')} WHERE id=$${i++} AND workspace_id=$${i} RETURNING id, col_key, label, position${hasColor ? ', color' : ''}`, vals
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Kolom niet gevonden' });
    res.json({ success: true, column: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/api/mkt/columns/:id', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!(await contentColumnsAvailable())) return res.status(503).json({ error: 'Nog niet ingeschakeld.' });
    const wsId = req.session.mkt.workspaceId;
    const cnt = await withReadConnection(async (c) => (await c.query('SELECT COUNT(*)::int AS n FROM marketing.content_columns WHERE workspace_id=$1', [wsId])).rows[0].n);
    if (cnt <= 1) return res.status(400).json({ error: 'Er moet minstens een kolom overblijven' });
    const done = await withWriteConnection(async (c) => (await c.query(
      'DELETE FROM marketing.content_columns WHERE id=$1 AND workspace_id=$2 RETURNING id', [req.params.id, wsId]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Kolom niet gevonden' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// =======================================================================
const ASSET_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per bestand
const ASSET_MIME_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const assetUploadParser = express.json({ limit: '12mb' });

// Lijst assets van een klant (alleen metadata, niet de bytes).
router.get('/api/mkt/clients/:clientId/assets', requireMkt, async (req, res) => {
  try {
    const wsId = req.session.mkt.workspaceId;
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, filename, mime, size_bytes, created_at,
              provider, url, public_id, resource_type, format
         FROM marketing.assets
        WHERE workspace_id=$1 AND client_id=$2
        ORDER BY created_at DESC`,
      [wsId, okClient]
    )).rows);
    res.json({ success: true, assets: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vraag een upload-handtekening voor Cloudinary (browser uploadt rechtstreeks).
router.post('/api/mkt/clients/:clientId/assets/sign', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const cfg = cloudinaryConfig();
    if (!cfg) return res.status(500).json({ error: 'Cloudinary is niet geconfigureerd op de server' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `mkt/ws${wsId}/client${okClient}`;
    const signature = cloudinarySign({ folder, timestamp }, cfg.apiSecret);
    res.json({ success: true, cloudName: cfg.cloudName, apiKey: cfg.apiKey, timestamp, folder, signature });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Opslaginfo van een werkplek. Deploy-veilig: als de kolom storage_quota_mb nog
// niet bestaat (migratie nog niet gedraaid), vallen we terug op 10 GB standaard.
const DEFAULT_STORAGE_MB = 10240; // 10 GB
async function workspaceStorageInfo(wsId) {
  let quotaMb = DEFAULT_STORAGE_MB;
  try {
    const q = await withReadConnection(async (c) => c.query('SELECT storage_quota_mb FROM marketing.workspaces WHERE id=$1', [wsId]));
    const v = q.rows[0] && q.rows[0].storage_quota_mb;
    if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) quotaMb = Number(v);
  } catch (_) { /* kolom bestaat nog niet: standaard 10 GB */ }
  let usedBytes = 0;
  try {
    const u = await withReadConnection(async (c) => c.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS b FROM marketing.assets WHERE workspace_id=$1', [wsId]));
    usedBytes = Number((u.rows[0] && u.rows[0].b) || 0);
  } catch (_) { usedBytes = 0; }
  return { quotaMb, quotaBytes: quotaMb * 1024 * 1024, usedBytes };
}
function storageFullError(info) {
  return 'Opslag van de werkplek is vol (limiet ' + Math.round(info.quotaBytes / 1048576) + ' MB). Verwijder oude bestanden of vraag meer opslag aan.';
}

// Huidig opslaggebruik van de werkplek.
router.get('/api/mkt/workspace/storage', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const info = await workspaceStorageInfo(req.session.mkt.workspaceId);
    res.json({ success: true, quotaMb: info.quotaMb, quotaBytes: info.quotaBytes, usedBytes: info.usedBytes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registreer een geuploade Cloudinary-asset in de database.
// Body: { public_id, url, resource_type, format, bytes, filename, mime }.
router.post('/api/mkt/clients/:clientId/assets/register', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const b = req.body || {};
    if (!b.public_id || !b.url) return res.status(400).json({ error: 'Onvolledige upload-gegevens' });
    const rtype = (b.resource_type === 'video' || b.resource_type === 'image') ? b.resource_type : 'image';
    const name = (b.filename && String(b.filename).trim().slice(0, 200)) || 'bestand';
    const size = Number.isFinite(Number(b.bytes)) ? Math.max(0, Math.floor(Number(b.bytes))) : 0;
    const stor = await workspaceStorageInfo(wsId);
    if (size > 0 && stor.usedBytes + size > stor.quotaBytes) {
      return res.status(413).json({ error: storageFullError(stor) });
    }
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.assets (workspace_id, client_id, filename, mime, size_bytes, provider, public_id, url, resource_type, format, created_by)
       VALUES ($1,$2,$3,$4,$5,'cloudinary',$6,$7,$8,$9,$10)
       RETURNING id, filename, mime, size_bytes, created_at, provider, url, public_id, resource_type, format`,
      [wsId, okClient, name, b.mime || null, size, String(b.public_id), String(b.url), rtype, b.format || null, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, asset: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload een asset (base64). Body: { filename, mime, data_base64 }.
router.post('/api/mkt/clients/:clientId/assets', assetUploadParser, requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const { filename, mime, data_base64 } = req.body || {};
    if (!mime || !ASSET_MIME_OK.includes(mime)) {
      return res.status(400).json({ error: 'Alleen afbeeldingen (PNG, JPG, WEBP, GIF) zijn toegestaan' });
    }
    if (!data_base64 || typeof data_base64 !== 'string') {
      return res.status(400).json({ error: 'Geen bestand ontvangen' });
    }
    let buf;
    try { buf = Buffer.from(data_base64, 'base64'); } catch (_) { buf = null; }
    if (!buf || !buf.length) return res.status(400).json({ error: 'Bestand kon niet worden gelezen' });
    if (buf.length > ASSET_MAX_BYTES) {
      return res.status(413).json({ error: 'Bestand is te groot (max 8 MB)' });
    }
    const storU = await workspaceStorageInfo(wsId);
    if (storU.usedBytes + buf.length > storU.quotaBytes) {
      return res.status(413).json({ error: storageFullError(storU) });
    }
    const name = (filename && String(filename).trim().slice(0, 200)) || 'afbeelding';
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.assets (workspace_id, client_id, filename, mime, size_bytes, data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, filename, mime, size_bytes, created_at`,
      [wsId, okClient, name, mime, buf.length, buf, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, asset: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serveer de bytes van een asset (voor <img> en download). Gescopet op workspace.
router.get('/api/mkt/assets/:id', requireMkt, async (req, res) => {
  try {
    // Klant-account mag alleen de eigen assets ophalen.
    const lockCid = mktClientLocked(req) ? mktLockedClientId(req) : null;
    const row = await withReadConnection(async (c) => (await c.query(
      `SELECT filename, mime, data FROM marketing.assets
        WHERE id=$1 AND workspace_id=$2 ${lockCid ? 'AND client_id=$3' : ''}`,
      lockCid ? [req.params.id, req.session.mkt.workspaceId, lockCid] : [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Asset niet gevonden' });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(row.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verwijder een bestand bij Cloudinary (best-effort, blokkeert de DB-delete niet).
async function cloudinaryDestroy(publicId, resourceType) {
  const cfg = cloudinaryConfig();
  if (!cfg || !publicId) return;
  const rtype = resourceType === 'video' ? 'video' : 'image';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = cloudinarySign({ public_id: publicId, timestamp }, cfg.apiSecret);
  const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: cfg.apiKey, signature });
  await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/${rtype}/destroy`, { method: 'POST', body });
}

// Asset verwijderen (uit DB, en bij Cloudinary als het daar staat).
router.delete('/api/mkt/assets/:id', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om assets te beheren' });
    const done = await withWriteConnection(async (c) => (await c.query(
      `DELETE FROM marketing.assets WHERE id=$1 AND workspace_id=$2
       RETURNING id, provider, public_id, resource_type`,
      [req.params.id, req.session.mkt.workspaceId]
    )).rows[0]);
    if (!done) return res.status(404).json({ error: 'Asset niet gevonden' });
    if (done.provider === 'cloudinary' && done.public_id) {
      try { await cloudinaryDestroy(done.public_id, done.resource_type); } catch (_) { /* best-effort */ }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 4 - KOPPELINGEN per klant (API-sleutels, pixels, tokens)
// Eén rij per klant. Gevoelige tokens worden versleuteld opgeslagen en
// nooit volledig teruggegeven (alleen gemaskeerd).
// =======================================================================
const INT_PLAIN = ['meta_page_id', 'meta_ig_user_id', 'meta_pixel_id', 'meta_ad_account_id', 'meta_app_id', 'google_ads_customer_id', 'ga4_measurement_id', 'tiktok_pixel_id', 'notes'];
const INT_SECRET = ['meta_access_token', 'meta_app_secret', 'google_ads_developer_token', 'tiktok_access_token'];
// ID's die in de workspace gemaskeerd worden (wel volledig in create-user voor de admin).
const INT_MASKED_IDS = ['meta_page_id', 'meta_ig_user_id', 'meta_pixel_id', 'meta_ad_account_id', 'meta_app_id', 'google_ads_customer_id', 'ga4_measurement_id', 'tiktok_pixel_id'];

// Maskeer een gewone (niet-versleutelde) waarde: alleen of hij is gezet + laatste 4 tekens.
function maskPlain(v) {
  if (!v) return { set: false, hint: '' };
  const s = String(v);
  const tail = s.length > 4 ? s.slice(-4) : s;
  return { set: true, hint: '••••' + tail };
}

function integrationsView(row) {
  const out = {};
  for (const f of INT_MASKED_IDS) out[f] = maskPlain(row ? row[f] : null);
  out.notes = row ? (row.notes || '') : '';
  for (const f of INT_SECRET) out[f] = maskSecret(row ? row[f] : null);
  out.encrypted = !!mktKey();
  return out;
}

// Koppelingen ophalen (gemaskeerd).
router.get('/api/mkt/clients/:clientId/integrations', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan koppelingen bekijken' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const row = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]);
    res.json({ success: true, integrations: integrationsView(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Snel koppelen: met de meegegeven token de beschikbare pagina's + Instagram-accounts
// en advertentieaccounts ophalen, zodat de gebruiker het juiste kan kiezen.
router.post('/api/mkt/clients/:clientId/meta-discover', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const token = String((req.body && req.body.token) || '').trim();
    if (token.length < 20) return res.status(400).json({ error: 'Plak eerst een geldig access token.' });
    const pageMap = {};
    const igMap = {}; // alle gevonden Instagram-accounts: id -> { id, username }
    // Een Instagram-account kan op twee manieren aan een pagina hangen: als
    // instagram_business_account (gekoppeld via Meta Business, nodig om te
    // publiceren) of als connected_instagram_account (via de pagina-instellingen).
    // We nemen het eerste dat er is, zodat we de koppeling in beide gevallen zien.
    const igFrom = (p) => {
      const b = p && p.instagram_business_account;
      const c = p && p.connected_instagram_account;
      const src = (b && b.id) ? b : ((c && c.id) ? c : null);
      return { id: src ? src.id : null, username: src ? (src.username || null) : null };
    };
    const addPage = (p) => {
      if (!p || !p.id || pageMap[p.id]) return;
      const ig = igFrom(p);
      // _token = pagina-token: Meta geeft het Instagram-account vaak alleen terug
      // als je de pagina met HAAR eigen token bevraagt, niet met het gebruikerstoken.
      pageMap[p.id] = { id: p.id, name: p.name || '(zonder naam)', ig_id: ig.id, ig_username: ig.username, _token: p.access_token || null };
    };
    // access_token per pagina meevragen zodat we hieronder met het pagina-token kunnen terugvallen.
    const PF = 'name,id,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}';
    // 1. Pagina's met een directe rol.
    try {
      const r = await graphGet('me/accounts', { fields: PF, limit: '200', access_token: token });
      (r.data || []).forEach(addPage);
    } catch (e) { return res.status(400).json({ error: 'Kon accounts niet ophalen: ' + e.message }); }
    const addIg = (x) => { if (x && x.id && !igMap[x.id]) igMap[x.id] = { id: x.id, username: x.username || null }; };
    // 2. Pagina's die via haar account/business zijn toegewezen (owned + client pages),
    //    EN de Instagram-accounts die direct onder de Business vallen. Zo vinden we
    //    een Instagram ook als Meta die niet via de pagina teruggeeft (bv. bij een
    //    client-pagina waar we geen pagina-token voor krijgen).
    try {
      const b = await graphGet('me/businesses', { fields: 'id,name', limit: '100', access_token: token });
      for (const biz of (b.data || [])) {
        for (const edge of ['owned_pages', 'client_pages']) {
          try {
            const pr = await graphGet(`${biz.id}/${edge}`, { fields: PF, limit: '200', access_token: token });
            (pr.data || []).forEach(addPage);
          } catch (_) { /* deze edge overslaan */ }
        }
        for (const edge of ['owned_instagram_accounts', 'client_instagram_accounts']) {
          try {
            const ir = await graphGet(`${biz.id}/${edge}`, { fields: 'id,username', limit: '200', access_token: token });
            (ir.data || []).forEach(addIg);
          } catch (_) { /* deze edge overslaan */ }
        }
      }
    } catch (_) { /* geen business-toegang: alleen directe pagina's */ }
    // Terugval: voor pagina's zonder gevonden Instagram de pagina direct bevragen,
    // bij voorkeur met het pagina-token (geeft het gekoppelde IG-account vaker terug).
    for (const pg of Object.values(pageMap)) {
      if (pg.ig_id) continue;
      const pgToken = pg._token || token;
      try {
        const d = await graphGet(`${pg.id}`, { fields: 'instagram_business_account{id,username},connected_instagram_account{id,username}', access_token: pgToken });
        const ig = igFrom(d);
        if (ig.id) { pg.ig_id = ig.id; pg.ig_username = ig.username; }
      } catch (_) { /* terugval mislukt: laat leeg */ }
    }
    // Instagram-accounts die via een pagina gevonden zijn ook in de lijst opnemen.
    Object.values(pageMap).forEach((p) => { if (p.ig_id) addIg({ id: p.ig_id, username: p.ig_username }); });
    // Diagnose alleen als er helemaal geen Instagram-account gevonden is: ligt het
    // aan een ontbrekende permissie (instagram_basic) of aan een ontbrekende koppeling?
    let ig_hint = null;
    if (Object.keys(igMap).length === 0) {
      try {
        const perms = await graphGet('me/permissions', { access_token: token });
        const granted = (perms.data || []).filter((x) => x.status === 'granted').map((x) => x.permission);
        if (!granted.includes('instagram_basic')) {
          ig_hint = 'Je access token mist de permissie instagram_basic. Genereer het token opnieuw met instagram_basic (en pages_show_list) erbij; dan vindt Meta het Instagram-account.';
        } else {
          ig_hint = 'Geen Instagram-account gevonden onder dit token. Zorg dat het Instagram-account een professioneel account is (Bedrijf of Creator) en in Meta Business is toegevoegd of aan een Facebook-pagina gekoppeld, en probeer opnieuw.';
        }
      } catch (_) { /* diagnose optioneel */ }
    }
    // Pagina-tokens NOOIT naar de frontend sturen.
    const pages = Object.values(pageMap).map((p) => ({ id: p.id, name: p.name, ig_id: p.ig_id, ig_username: p.ig_username }));
    const igaccounts = Object.values(igMap);
    let adaccounts = [];
    try {
      const a = await graphGet('me/adaccounts', { fields: 'name,account_id', limit: '200', access_token: token });
      adaccounts = (a.data || []).map((x) => ({ id: 'act_' + (x.account_id || ''), name: x.name || ('act_' + x.account_id) }));
    } catch (_) { /* ad accounts optioneel */ }
    res.json({ success: true, pages, igaccounts, adaccounts, ig_hint });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Koppelingen opslaan. Lege tokenvelden laten het bestaande token ongemoeid.
router.put('/api/mkt/clients/:clientId/integrations', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan koppelingen wijzigen' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const b = req.body || {};

    const existing = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};

    const vals = {};
    for (const f of INT_PLAIN) {
      vals[f] = (b[f] !== undefined) ? (String(b[f]).trim() || null) : (existing[f] || null);
    }
    for (const f of INT_SECRET) {
      if (b[f] !== undefined && String(b[f]).trim() !== '') vals[f] = encryptSecret(String(b[f]).trim());
      else vals[f] = existing[f] || null;
    }

    const cols = [...INT_PLAIN, ...INT_SECRET];
    const insertCols = ['client_id', 'workspace_id', ...cols, 'updated_at'];
    const params = [okClient, wsId, ...cols.map((f) => vals[f])];
    const placeholders = params.map((_, i) => `$${i + 1}`).join(',') + ',now()';
    const updates = cols.map((f) => `${f}=EXCLUDED.${f}`).join(', ') + ', updated_at=now()';
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.client_integrations (${insertCols.join(',')})
       VALUES (${placeholders})
       ON CONFLICT (client_id) DO UPDATE SET ${updates}
       RETURNING *`, params
    )).rows[0]);
    res.json({ success: true, integrations: integrationsView(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wis de volledige Meta-koppeling van een klant, zodat hij terugvalt op het
// hoofdaccount van de werkplek. Handig als er per ongeluk een verkeerd of
// verlopen token is ingevoerd en dat niet via het formulier te legen is.
router.delete('/api/mkt/clients/:clientId/integrations', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan koppelingen wijzigen' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    await withWriteConnection(async (c) => c.query(
      'DELETE FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [okClient, wsId]
    ));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Client-veilige Meta-ID's (GEEN token/secret): de klant mag zelf zijn eigen
// ad account, Facebook Page, Instagram en pixel invullen. Alleen deze vier.
const CLIENT_META_ID_FIELDS = ['meta_ad_account_id', 'meta_page_id', 'meta_ig_user_id', 'meta_pixel_id'];
router.get('/api/mkt/clients/:clientId/meta-ids', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const row = await withReadConnection(async (c) => (await c.query(
      'SELECT meta_ad_account_id, meta_page_id, meta_ig_user_id, meta_pixel_id FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};
    res.json({ success: true, ids: {
      meta_ad_account_id: row.meta_ad_account_id || '', meta_page_id: row.meta_page_id || '',
      meta_ig_user_id: row.meta_ig_user_id || '', meta_pixel_id: row.meta_pixel_id || '',
    } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/api/mkt/clients/:clientId/meta-ids', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const b = req.body || {};
    const clean = (v) => (v === undefined) ? undefined : (String(v == null ? '' : v).trim() || null);
    const existing = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};
    const cols = CLIENT_META_ID_FIELDS;
    const vals = {};
    for (const f of cols) { const cv = clean(b[f]); vals[f] = (cv !== undefined) ? cv : (existing[f] || null); }
    const insertCols = ['client_id', 'workspace_id', ...cols, 'updated_at'];
    const params = [okClient, wsId, ...cols.map((f) => vals[f])];
    const placeholders = params.map((_, i) => `$${i + 1}`).join(',') + ',now()';
    const updates = cols.map((f) => `${f}=EXCLUDED.${f}`).join(', ') + ', updated_at=now()';
    await withWriteConnection(async (c) => c.query(
      `INSERT INTO marketing.client_integrations (${insertCols.join(',')})
       VALUES (${placeholders})
       ON CONFLICT (client_id) DO UPDATE SET ${updates}`, params
    ));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wis alleen de koppeling van één platform (Meta/Google/TikTok) voor een klant.
// De kolomnamen komen uit een vaste whitelist; het platform wordt gevalideerd.
router.post('/api/mkt/clients/:clientId/integrations/clear-platform', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan koppelingen wijzigen' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const platform = String((req.body && req.body.platform) || '').toLowerCase();
    const COLS = {
      meta: ['meta_page_id', 'meta_ig_user_id', 'meta_pixel_id', 'meta_ad_account_id', 'meta_app_id', 'meta_access_token', 'meta_app_secret'],
      google: ['google_ads_customer_id', 'google_ads_developer_token', 'ga4_measurement_id'],
      tiktok: ['tiktok_pixel_id', 'tiktok_access_token'],
    };
    const cols = COLS[platform];
    if (!cols) return res.status(400).json({ error: 'Onbekend platform' });
    const sets = cols.map((c) => `${c}=NULL`).join(', ');
    await withWriteConnection(async (c) => c.query(
      `UPDATE marketing.client_integrations SET ${sets}, updated_at=now() WHERE client_id=$1 AND workspace_id=$2`,
      [okClient, wsId]
    ));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 16 - WORKSPACE-KOPPELING (gedeelde Meta-basis voor alle klanten)
// De eigenaar vult token + App ID/Secret + Ad Account eenmalig in op
// workspace-niveau. Klanten vallen hierop terug (client-waarde wint als die
// is ingevuld). Page ID / Instagram ID blijven per klant.
// =======================================================================
const WS_INT_SECRET = ['meta_access_token', 'meta_app_secret'];
const WS_INT_IDS = ['meta_ad_account_id', 'meta_app_id', 'meta_page_id', 'meta_ig_user_id', 'meta_pixel_id'];

function workspaceIntegrationsView(row) {
  return {
    meta_ad_account_id: maskPlain(row ? row.meta_ad_account_id : null),
    meta_app_id: maskPlain(row ? row.meta_app_id : null),
    meta_page_id: maskPlain(row ? row.meta_page_id : null),
    meta_ig_user_id: maskPlain(row ? row.meta_ig_user_id : null),
    meta_pixel_id: maskPlain(row ? row.meta_pixel_id : null),
    meta_access_token: maskSecret(row ? row.meta_access_token : null),
    meta_app_secret: maskSecret(row ? row.meta_app_secret : null),
    encrypted: !!mktKey(),
  };
}

router.get('/api/mkt/workspace/integrations', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const row = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
    )).rows[0]);
    res.json({ success: true, integrations: workspaceIntegrationsView(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/mkt/workspace/integrations', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const b = req.body || {};
    // Werkplek-brede page/ig/pixel zijn later toegevoegd; zorg dat de kolommen bestaan.
    await withWriteConnection(async (c) => {
      await c.query('ALTER TABLE marketing.workspace_integrations ADD COLUMN IF NOT EXISTS meta_page_id TEXT').catch(() => {});
      await c.query('ALTER TABLE marketing.workspace_integrations ADD COLUMN IF NOT EXISTS meta_ig_user_id TEXT').catch(() => {});
      await c.query('ALTER TABLE marketing.workspace_integrations ADD COLUMN IF NOT EXISTS meta_pixel_id TEXT').catch(() => {});
    });
    const existing = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
    )).rows[0]) || {};
    const vals = {};
    for (const f of WS_INT_IDS) vals[f] = (b[f] !== undefined && String(b[f]).trim() !== '') ? String(b[f]).trim() : (existing[f] || null);
    for (const f of WS_INT_SECRET) vals[f] = (b[f] !== undefined && String(b[f]).trim() !== '') ? encryptSecret(String(b[f]).trim()) : (existing[f] || null);
    const cols = [...WS_INT_IDS, ...WS_INT_SECRET];
    const params = [wsId, ...cols.map((f) => vals[f])];
    const placeholders = params.map((_, i) => `$${i + 1}`).join(',') + ',now()';
    const updates = cols.map((f) => `${f}=EXCLUDED.${f}`).join(', ') + ', updated_at=now()';
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.workspace_integrations (workspace_id, ${cols.join(',')}, updated_at)
       VALUES (${placeholders})
       ON CONFLICT (workspace_id) DO UPDATE SET ${updates}
       RETURNING *`, params
    )).rows[0]);
    res.json({ success: true, integrations: workspaceIntegrationsView(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verleng het workspace-token naar ~60 dagen.
router.post('/api/mkt/workspace/meta/extend-token', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const wi = await withReadConnection(async (c) => (await c.query(
      'SELECT meta_app_id, meta_app_secret, meta_access_token FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
    )).rows[0]);
    if (!wi) return res.status(400).json({ error: 'Geen workspace-koppeling ingesteld' });
    const appId = wi.meta_app_id || process.env.META_APP_ID || null;
    const appSecret = decryptSecret(wi.meta_app_secret) || process.env.META_APP_SECRET || null;
    const shortTok = decryptSecret(wi.meta_access_token);
    if (!appId || !appSecret) return res.status(400).json({ error: 'Vul App ID en App Secret in (of centraal via env)' });
    if (!shortTok) return res.status(400).json({ error: 'Er is nog geen access token ingevuld om te verlengen' });
    const r = await graphGet('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortTok });
    if (!r.access_token) return res.status(400).json({ error: 'Meta gaf geen langlevend token terug' });
    const expSecsWs = r.expires_in ? Number(r.expires_in) : 60 * 24 * 3600;
    await withWriteConnection(async (c) => {
      await c.query('ALTER TABLE marketing.workspace_integrations ADD COLUMN IF NOT EXISTS meta_token_expires_at TIMESTAMPTZ').catch(() => {});
      try {
        await c.query(
          "UPDATE marketing.workspace_integrations SET meta_access_token=$1, meta_token_expires_at=now() + ($2 || ' seconds')::interval, updated_at=now() WHERE workspace_id=$3",
          [encryptSecret(r.access_token), String(expSecsWs), wsId]
        );
      } catch (_) {
        await c.query('UPDATE marketing.workspace_integrations SET meta_access_token=$1, updated_at=now() WHERE workspace_id=$2', [encryptSecret(r.access_token), wsId]);
      }
    });
    res.json({ success: true, days: r.expires_in ? Math.round(r.expires_in / 86400) : 60 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Meta-gegevens voor een klant: client-waarde wint, anders terugval op de workspace-koppeling.
async function resolveClientMeta(wsId, clientId) {
  const ci = await withReadConnection(async (c) => (await c.query(
    'SELECT * FROM marketing.client_integrations WHERE client_id=$1 AND workspace_id=$2', [clientId, wsId]
  )).rows[0]) || {};
  const wi = await withReadConnection(async (c) => (await c.query(
    'SELECT * FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
  )).rows[0]) || {};
  return {
    token: decryptSecret(ci.meta_access_token) || decryptSecret(wi.meta_access_token) || null,
    appId: ci.meta_app_id || wi.meta_app_id || process.env.META_APP_ID || null,
    appSecret: decryptSecret(ci.meta_app_secret) || decryptSecret(wi.meta_app_secret) || process.env.META_APP_SECRET || null,
    adAccount: normalizeAdAccount(ci.meta_ad_account_id || wi.meta_ad_account_id),
    pageId: ci.meta_page_id || wi.meta_page_id || null,
    igUserId: ci.meta_ig_user_id || wi.meta_ig_user_id || null,
    pixelId: ci.meta_pixel_id || wi.meta_pixel_id || null,
  };
}

// =======================================================================
// STAP 7 - PUBLICEREN naar Meta (Instagram / Facebook) via Graph API
// Werkt met een access token dat per klant is opgeslagen (Koppelingen-tab).
// In dev-modus van de Meta-app kun je op je eigen accounts posten.
// =======================================================================
const GRAPH = 'https://graph.facebook.com/v21.0';

// Bouwt een leesbare foutmelding uit een Meta-foutobject. Meta stopt de nuttige
// uitleg vaak in error_user_title/error_user_msg in plaats van in message.
function metaErrorMessage(j) {
  const e = j && j.error;
  if (!e) return 'Meta API-fout';
  const parts = [];
  if (e.error_user_title || e.error_user_msg) {
    parts.push([e.error_user_title, e.error_user_msg].filter(Boolean).join(': '));
  }
  if (!parts.length && e.message) parts.push(e.message);
  let msg = parts.join(' ') || 'Meta API-fout';
  const codes = [];
  if (e.code) codes.push('code ' + e.code);
  if (e.error_subcode) codes.push('subcode ' + e.error_subcode);
  if (codes.length) msg += ' (' + codes.join(', ') + ')';
  return msg;
}
// Meta legt op sommige (nieuwe) ad accounts een strenge limiet op: 1 verzoek
// per 30 seconden (code 613, subcode 4841018). Deze helper herkent die fout.
function isRateLimit613(j) {
  const e = j && j.error;
  return !!e && (Number(e.code) === 613 || Number(e.error_subcode) === 4841018);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// Telt leads uit een Meta actions-array zonder dubbel te tellen: Meta rapporteert
// een lead vaak onder meerdere action_types tegelijk. We nemen daarom EEN canoniek
// type met prioriteit, niet de som van alles met 'lead' erin.
function pickLeadCount(actions) {
  if (!Array.isArray(actions)) return null;
  const byType = {}; let any = false;
  for (const a of actions) {
    if (a && typeof a.action_type === 'string' && /lead/i.test(a.action_type)) { byType[a.action_type] = Number(a.value) || 0; any = true; }
  }
  if (!any) return null;
  const pri = ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_conversion.lead_grouped', 'onsite_conversion.lead', 'leadgen.other'];
  for (const t of pri) { if (byType[t] != null) return byType[t]; }
  return Math.max.apply(null, Object.values(byType));
}
// Datumperiode uit de query (since/until als YYYY-MM-DD). Zonder geldige periode:
// de laatste 30 dagen. Geeft een object dat in Meta ads-insights past.
// Meta-presets die we toestaan (matchen 1-op-1 met Meta's date_preset in de UI).
const ADS_DATE_PRESETS = ['last_7d', 'last_14d', 'last_30d', 'this_week_mon_today', 'last_week_mon_sun', 'this_month', 'last_month', 'maximum'];
function adsDateSel(req) {
  const s = String((req && req.query && req.query.since) || '').trim();
  const u = String((req && req.query && req.query.until) || '').trim();
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}$/.test(u) && s <= u;
  if (ok) return { time_range: JSON.stringify({ since: s, until: u }) };
  const preset = String((req && req.query && req.query.preset) || '').trim();
  if (ADS_DATE_PRESETS.includes(preset)) return { date_preset: preset };
  return { date_preset: 'last_30d' };
}
async function graphPost(pathAndId, params) {
  const body = new URLSearchParams(params);
  const r = await fetch(`${GRAPH}/${pathAndId}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(metaErrorMessage(j));
  return j;
}
async function graphGet(pathAndId, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${GRAPH}/${pathAndId}?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(metaErrorMessage(j));
  return j;
}

// Thumbnail-URL voor een Cloudinary-video: Cloudinary levert een stilstaand
// voorbeeldframe als je dezelfde URL met een afbeeldings-extensie opvraagt.
function cloudinaryVideoThumb(url) {
  let t = String(url || '').replace(/\.(mp4|mov|webm|m4v|avi|mkv)(\?.*)?$/i, '.jpg');
  if (t === String(url || '')) t = String(url || '').replace(/\.[a-z0-9]+(\?.*)?$/i, '.jpg');
  return t;
}

// Upload een video (via publieke URL) naar Meta en wacht tot Meta klaar is met
// verwerken. Een video-advertentie kan pas gemaakt worden als de video 'ready' is.
async function uploadMetaVideoAndWait(adAccount, token, videoUrl) {
  const up = await graphPost(`${adAccount}/advideos`, { file_url: videoUrl, access_token: token });
  const videoId = up && up.id;
  if (!videoId) throw new Error('Video-upload naar Meta is mislukt');
  const deadline = Date.now() + 80 * 1000; // max ~80 seconden wachten (onder de proxy-timeout)
  while (Date.now() < deadline) {
    let st = null;
    try {
      const info = await graphGet(`${videoId}`, { fields: 'status', access_token: token });
      st = info && info.status && info.status.video_status;
    } catch (_) { st = null; }
    if (st === 'ready') return videoId;
    if (st === 'error') throw new Error('Meta kon de video niet verwerken. Probeer een ander videobestand.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('De video wordt nog door Meta verwerkt. Wacht een halve minuut en maak de advertentie opnieuw aan.');
}

// We zetten op elke advertentie ALTIJD een titel (Kop). Laten we die leeg, dan
// pakt Meta de (vaak gecachete) titel van de bestemmingspagina erbij, en dan
// verschijnt bijvoorbeeld "Aanmelden - Dynamic Health Consultancy". Daarom valt
// een lege Kop terug op deze neutrale standaardkop. De creative zelf wordt
// opgebouwd in buildCreative hieronder.
const DEFAULT_AD_HEADLINE = 'Meld je hier aan';

// Alle Advantage+ creatieve verbeteringen (AI) die we willen uitzetten. De oude
// verzamelsleutel 'standard_enhancements' is door Meta afgeschaft (fout 3858504),
// dus zetten we elke verbetering los op OPT_OUT.
const AI_ENHANCEMENT_KEYS = [
  'add_text_overlay', 'creative_stickers', 'description_automation', 'image_animation', 'image_background_gen',
  'image_templates', 'image_touchups', 'image_uncrop', 'inline_comment', 'media_type_automation',
  'music_generation', 'pac_relaxation', 'product_extensions', 'profile_card', 'reveal_details_over_time',
  'show_destination_blurbs', 'show_summary', 'site_extensions', 'text_optimizations', 'text_translation',
  'translate_voiceover', 'video_auto_crop', 'video_highlights',
];
function aiOptOutSpec() {
  const cfs = {};
  for (const k of AI_ENHANCEMENT_KEYS) cfs[k] = { enroll_status: 'OPT_OUT' };
  return JSON.stringify({ creative_features_spec: cfs });
}
// contextual_multi_ads OPT_OUT = 'Advertenties van meerdere adverteerders' staat uit.
// Dit is een veld bovenin de creative (niet in creative_features_spec).
const MULTI_ADS_OFF = JSON.stringify({ enroll_status: 'OPT_OUT' });

// Maakt een adcreative aan en zet Meta's Advantage+ creatieve verbeteringen (AI) en
// 'advertenties van meerdere adverteerders' uit. Dit gebeurt in laagjes, zodat het
// aanmaken nooit breekt: lukt de volledige opt-out niet, dan proberen we minstens
// 'meerdere adverteerders' uit te zetten, en anders een kale creative.
// 'built' is of een object_story_spec (string), of een object { primary, fallback? }
// waarbij primary/fallback elk de losse creative-velden zijn ({ object_story_spec,
// asset_feed_spec? }). Weigert Meta de flexibele creative (meerdere teksten), dan
// valt hij terug op de enkele-tekst-variant, zodat het aanmaken nooit stuk gaat.
async function createAdCreativeNoAI(adAccount, token, name, built) {
  // Normaliseer naar { tries: [velden...], fallback? }. 'tries' zijn de meerdere-
  // teksten-varianten die op volgorde geprobeerd worden; 'fallback' is 1 tekst.
  let norm;
  if (typeof built === 'string') norm = { tries: [{ object_story_spec: built }] };
  else if (built && Array.isArray(built.tries)) norm = { tries: built.tries, fallback: built.fallback };
  else if (built && built.primary) norm = { tries: [built.primary].concat(built.altFlex ? [built.altFlex] : []), fallback: built.fallback };
  else norm = { tries: [built] };
  const attempt = async (fields) => {
    const base = { name, ...fields, access_token: token };
    // 1) AI-verbeteringen uit EN meerdere-adverteerders uit.
    try {
      return await graphPost(`${adAccount}/adcreatives`, {
        ...base,
        degrees_of_freedom_spec: aiOptOutSpec(),
        contextual_multi_ads: MULTI_ADS_OFF,
      });
    } catch (_) { /* door naar stap 2 */ }
    // 2) Minstens meerdere-adverteerders uit (AI-opt-out desnoods overslaan).
    try {
      return await graphPost(`${adAccount}/adcreatives`, { ...base, contextual_multi_ads: MULTI_ADS_OFF });
    } catch (_) { /* door naar stap 3 */ }
    // 3) Kale creative, zodat het aanmaken nooit breekt.
    return await graphPost(`${adAccount}/adcreatives`, base);
  };
  // Probeer elke meerdere-teksten-variant; de eerste die Meta accepteert wint.
  let lastErr = '';
  for (const fields of (norm.tries || [])) {
    try { return await attempt(fields); }
    catch (e) { lastErr = (e && e.message) || lastErr; }
  }
  // Alle flexibele varianten geweigerd: terugval op 1 tekst (indien beschikbaar).
  if (norm.fallback) {
    try { console.warn('[MKT] flexibele creative geweigerd, terugval op 1 tekst:', lastErr); } catch (_) { /* noop */ }
    const r = await attempt(norm.fallback);
    if (r && typeof r === 'object') { r._usedFallback = true; r._flexError = lastErr; }
    return r;
  }
  throw new Error(lastErr || 'Creatief aanmaken mislukt');
}

// Upload een afbeelding (via publieke URL) naar de advertentierekening en geef de
// image-hash terug. Nodig voor een flexibele creative (asset_feed_spec) met een afbeelding.
async function uploadMetaImageHash(adAccount, token, imageUrl) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error('Kon de afbeelding niet ophalen voor Meta');
  const buf = Buffer.from(await r.arrayBuffer());
  const form = new FormData();
  form.append('access_token', token);
  form.append('filename', new Blob([buf]), 'ad-image.jpg');
  const up = await fetch(`${GRAPH}/${adAccount}/adimages`, { method: 'POST', body: form });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || j.error) throw new Error(metaErrorMessage(j));
  const first = Object.values(j.images || {})[0];
  if (!first || !first.hash) throw new Error('Meta gaf geen image-hash terug');
  return first.hash;
}

// Bouwt de creative-velden voor een advertentie. Bij 1 tekst een gewone creative;
// bij 2 tot 5 teksten een flexibele creative (asset_feed_spec) zodat Meta tussen
// de teksten afwisselt. Geeft { primary, fallback? } terug voor createAdCreativeNoAI.
// Video wordt eenmalig geupload en hergebruikt in beide varianten.
async function buildCreative(adAccount, token, pageId, asset, captions, link, cta, headline) {
  const head = (String(headline || '').trim().slice(0, 255)) || DEFAULT_AD_HEADLINE;
  const texts = (Array.isArray(captions) ? captions : [captions])
    .map((t) => String(t || '').trim()).filter(Boolean).slice(0, 5);
  const isVideo = asset.resource_type === 'video';

  let videoId = null;
  if (isVideo) videoId = await uploadMetaVideoAndWait(adAccount, token, asset.url);

  // Enkele-tekst creative (ook de terugval als Meta het flexibele formaat weigert).
  const singleSpec = () => {
    if (isVideo) {
      return JSON.stringify({ page_id: pageId, video_data: {
        video_id: videoId, message: texts[0] || '', image_url: cloudinaryVideoThumb(asset.url),
        call_to_action: { type: cta, value: { link } }, title: head,
      } });
    }
    return JSON.stringify({ page_id: pageId, link_data: {
      message: texts[0] || '', link, picture: asset.url,
      call_to_action: { type: cta, value: { link } }, name: head,
    } });
  };

  if (texts.length <= 1) {
    return { primary: { object_story_spec: singleSpec() } };
  }

  // optimization_type DEGREES_OF_FREEDOM = een FLEXIBELE advertentie (meerdere
  // tekstopties die Meta afwisselt). Dit maakt de ad set NIET dynamisch, dus je
  // kunt gewoon meerdere advertenties in dezelfde ad set houden. Zonder dit veld
  // behandelt Meta het als dynamisch materiaal (max 1 advertentie per ad set).
  const mediaHash = isVideo ? null : await uploadMetaImageHash(adAccount, token, asset.url);
  const afs = {
    optimization_type: 'DEGREES_OF_FREEDOM',
    ad_formats: [isVideo ? 'SINGLE_VIDEO' : 'AUTOMATIC_FORMAT'],
    bodies: texts.map((t) => ({ text: t })),
    titles: [{ text: head }],
    link_urls: [{ website_url: link }],
    call_to_action_types: [cta],
  };
  if (isVideo) {
    afs.videos = [{ video_id: videoId, thumbnail_url: cloudinaryVideoThumb(asset.url) }];
  } else {
    afs.images = [{ hash: mediaHash }];
  }
  const cta2 = { type: cta, value: { link } };
  // 2e poging: beeld ZONDER kop in object_story_spec, en de kop (titels) + teksten in
  // asset_feed_spec. Zo wordt ook het 'Kop'-veld in de Meta-editor gevuld.
  const altStoryNoHead = isVideo
    ? { page_id: pageId, video_data: { video_id: videoId, image_url: cloudinaryVideoThumb(asset.url), call_to_action: cta2 } }
    : { page_id: pageId, link_data: { link, image_hash: mediaHash, call_to_action: cta2 } };
  const altFeedTitles = { bodies: texts.map((t) => ({ text: t })), titles: [{ text: head }], optimization_type: 'DEGREES_OF_FREEDOM' };
  // 3e poging (huidige werkende variant): beeld + kop in object_story_spec, alleen de
  // teksten in asset_feed_spec. Hierop valt hij terug als de 2e poging wordt geweigerd,
  // zodat de meerdere teksten altijd behouden blijven.
  const altStoryHead = isVideo
    ? { page_id: pageId, video_data: { video_id: videoId, image_url: cloudinaryVideoThumb(asset.url), call_to_action: cta2, title: head } }
    : { page_id: pageId, link_data: { link, image_hash: mediaHash, call_to_action: cta2, name: head } };
  const altFeedBodies = { bodies: texts.map((t) => ({ text: t })), optimization_type: 'DEGREES_OF_FREEDOM' };
  return {
    // Op volgorde geprobeerd; de eerste die Meta accepteert wint. Pas als alle
    // meerdere-teksten-varianten falen, valt hij terug op 1 tekst (fallback).
    // 1) standaard flexibel (beeld in asset_feed_spec) 2) kop+teksten in de feed,
    // beeld in object_story_spec 3) kop+beeld in object_story_spec, teksten in de feed.
    tries: [
      { object_story_spec: JSON.stringify({ page_id: pageId }), asset_feed_spec: JSON.stringify(afs) },
      { object_story_spec: JSON.stringify(altStoryNoHead), asset_feed_spec: JSON.stringify(altFeedTitles) },
      { object_story_spec: JSON.stringify(altStoryHead), asset_feed_spec: JSON.stringify(altFeedBodies) },
    ],
    fallback: { object_story_spec: singleSpec() },
  };
}

// Attributie zoals wij campagnes beoordelen: 7 dagen klik, 1 dag betrokkenheid
// (video), 1 dag weergave. Als Meta dit voor dit ad-set-type afwijst, maken we de
// ad set zonder attributie-instelling aan (Meta gebruikt dan zijn standaard).
const ATTRIBUTION_SPEC = [
  { event_type: 'CLICK_THROUGH', window_days: 7 },
  { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 },
  { event_type: 'VIEW_THROUGH', window_days: 1 },
];
async function createAdSetWithAttribution(adAccount, token, params) {
  try {
    return await graphPost(`${adAccount}/adsets`, { ...params, attribution_spec: JSON.stringify(ATTRIBUTION_SPEC) });
  } catch (_) {
    return await graphPost(`${adAccount}/adsets`, params);
  }
}

// Publiceert naar Meta. Gebruikt door de handmatige knop en de planner.
// Gooit een fout met een leesbare melding als er iets misgaat.
// Vertaalt ruwe Meta-fouten naar een duidelijke, bruikbare melding. Vooral
// code 10 (ontbrekende permissie) laten we uitleggen wat er moet gebeuren.
function friendlyPublishError(msg, channel) {
  const m = String(msg || '');
  if (/\(#?10\)|code\s*10|does not have permission|permission for this action/i.test(m)) {
    if (channel === 'instagram') {
      return 'Instagram weigert het publiceren (rechtenfout, code 10). Het access token mist de permissie instagram_content_publish. Genereer het token opnieuw met die permissie erbij en sla het weer op bij de koppeling. Voor echte klantaccounts is daarnaast Meta App Review nodig.';
    }
    return 'Meta weigert het publiceren (rechtenfout, code 10). Het access token mist de benodigde permissie. Genereer het token opnieuw met de juiste rechten en sla het weer op bij de koppeling.';
  }
  return m;
}

async function publishToMeta(intg, token, channel, mediaUrl, mediaType, caption) {
  const cap = (caption != null) ? String(caption) : '';
  if (channel === 'instagram') {
    if (!intg.meta_ig_user_id) throw new Error('Instagram user ID ontbreekt in de koppelingen');
    if (!mediaUrl) throw new Error('Instagram vereist een afbeelding of video');
    const igId = intg.meta_ig_user_id;
    const createParams = mediaType === 'video'
      ? { media_type: 'REELS', video_url: mediaUrl, caption: cap, access_token: token }
      : { image_url: mediaUrl, caption: cap, access_token: token };
    const created = await graphPost(`${igId}/media`, createParams);
    if (mediaType === 'video') {
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await graphGet(`${created.id}`, { fields: 'status_code', access_token: token });
        if (st.status_code === 'FINISHED') ready = true;
        else if (st.status_code === 'ERROR') throw new Error('Video-verwerking bij Instagram is mislukt');
      }
      if (!ready) throw new Error('Video-verwerking duurt te lang');
    }
    const pub = await graphPost(`${igId}/media_publish`, { creation_id: created.id, access_token: token });
    return { id: pub.id, channel: 'instagram' };
  }
  if (!intg.meta_page_id) throw new Error('Facebook Page ID ontbreekt in de koppelingen');
  const pageId = intg.meta_page_id;
  let pageToken = token;
  try { const pg = await graphGet(`${pageId}`, { fields: 'access_token', access_token: token }); if (pg.access_token) pageToken = pg.access_token; } catch (_) { /* val terug op het meegegeven token */ }
  if (mediaUrl && mediaType === 'image') {
    const pub = await graphPost(`${pageId}/photos`, { url: mediaUrl, caption: cap, access_token: pageToken });
    return { id: pub.post_id || pub.id, channel: 'facebook' };
  }
  const pub = await graphPost(`${pageId}/feed`, { message: cap, access_token: pageToken });
  return { id: pub.id, channel: 'facebook' };
}

// Publiceert een carousel (meerdere foto's/video's) als organische Instagram-post.
// Elk item wordt eerst een container; video's worden verwerkt; daarna een carousel-
// container en dan publiceren. items = [{ url, mediaType }]. Alleen Instagram.
async function publishCarouselToInstagram(igId, token, items, caption) {
  if (!igId) throw new Error('Instagram user ID ontbreekt in de koppelingen');
  const list = (Array.isArray(items) ? items : []).slice(0, 10);
  if (list.length < 2) throw new Error('Een carousel heeft minimaal 2 bestanden nodig (maximaal 10)');
  // 1) Item-containers aanmaken (parallel).
  const containers = await Promise.all(list.map(async (it) => {
    const params = (it.mediaType === 'video')
      ? { media_type: 'VIDEO', video_url: it.url, is_carousel_item: 'true', access_token: token }
      : { image_url: it.url, is_carousel_item: 'true', access_token: token };
    const c = await graphPost(`${igId}/media`, params);
    return { id: c.id, isVideo: it.mediaType === 'video' };
  }));
  // 2) Wachten tot alle video-containers klaar zijn (parallel, max ~75s totaal).
  const deadline = Date.now() + 75 * 1000;
  await Promise.all(containers.map(async (c) => {
    if (!c.isVideo) return;
    while (Date.now() < deadline) {
      const st = await graphGet(`${c.id}`, { fields: 'status_code', access_token: token });
      if (st.status_code === 'FINISHED') return;
      if (st.status_code === 'ERROR') throw new Error('Een van de video\'s kon niet door Instagram verwerkt worden. Probeer een ander/korter videobestand.');
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('De video-verwerking bij Instagram duurt te lang. Probeer het over een halve minuut opnieuw of gebruik kortere/kleinere video\'s.');
  }));
  // 3) Carousel-container aanmaken.
  const carousel = await graphPost(`${igId}/media`, {
    media_type: 'CAROUSEL',
    children: containers.map((c) => c.id).join(','),
    caption: (caption != null) ? String(caption) : '',
    access_token: token,
  });
  // 4) Carousel-container kan (bij video's) nog verwerkt worden; kort wachten.
  const d2 = Date.now() + 30 * 1000;
  while (Date.now() < d2) {
    let sc = null;
    try { const st = await graphGet(`${carousel.id}`, { fields: 'status_code', access_token: token }); sc = st.status_code; } catch (_) { sc = null; }
    if (sc === 'FINISHED') break;
    if (sc === 'ERROR') throw new Error('De carousel kon niet door Instagram verwerkt worden');
    await new Promise((r) => setTimeout(r, 2500));
  }
  // 5) Publiceren.
  const pub = await graphPost(`${igId}/media_publish`, { creation_id: carousel.id, access_token: token });
  return { id: pub.id, channel: 'instagram', carousel: true, items: list.length };
}

router.post('/api/mkt/clients/:clientId/publish', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om te publiceren' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const { channel, caption, assetId, postId, carouselAssetIds } = req.body || {};
    if (channel !== 'instagram' && channel !== 'facebook') return res.status(400).json({ error: 'Kies Instagram of Facebook' });

    // Client-koppeling met terugval op de workspace-koppeling.
    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    if (!token) return res.status(400).json({ error: 'Geen Meta access token (niet bij de klant en niet op de workspace)' });
    const intg = { meta_ig_user_id: creds.igUserId, meta_page_id: creds.pageId };
    const cap = (caption != null) ? String(caption) : '';

    let result;
    if (Array.isArray(carouselAssetIds) && carouselAssetIds.length >= 2) {
      // Carousel: alleen op Instagram.
      if (channel !== 'instagram') return res.status(400).json({ error: 'Een carousel kan alleen op Instagram geplaatst worden' });
      const items = await resolveCarouselAssets(wsId, okClient, carouselAssetIds);
      if (items.length < 2) return res.status(400).json({ error: 'Kies minimaal 2 publieke bestanden (uit Content) voor de carousel' });
      result = await publishCarouselToInstagram(creds.igUserId, token, items, cap);
    } else {
      // Enkel bestand (foto/video) of alleen tekst (Facebook).
      let mediaUrl = null, mediaType = 'image';
      if (assetId) {
        const asset = await withReadConnection(async (c) => (await c.query(
          'SELECT url, resource_type, provider FROM marketing.assets WHERE id=$1 AND client_id=$2 AND workspace_id=$3',
          [assetId, okClient, wsId]
        )).rows[0]);
        if (!asset) return res.status(404).json({ error: 'Gekozen bestand niet gevonden' });
        if (asset.provider !== 'cloudinary' || !asset.url) return res.status(400).json({ error: 'Alleen bestanden met een publieke URL kunnen worden gepubliceerd' });
        mediaUrl = asset.url;
        mediaType = asset.resource_type === 'video' ? 'video' : 'image';
      }
      result = await publishToMeta(intg, token, channel, mediaUrl, mediaType, cap);
    }

    // Post markeren als gepubliceerd.
    if (postId) {
      try {
        await withWriteConnection(async (c) => c.query(
          `UPDATE marketing.content_posts SET status='published', updated_at=now() WHERE id=$1 AND workspace_id=$2 AND client_id=$3`,
          [postId, wsId, okClient]
        ));
      } catch (_) { /* niet blokkerend */ }
    }
    res.json({ success: true, result });
  } catch (e) {
    const ch = (req.body && req.body.channel === 'facebook') ? 'facebook' : 'instagram';
    res.status(400).json({ error: friendlyPublishError(e.message, ch) });
  }
});

// =======================================================================
// STAP 8 - ADVERTENTIECAMPAGNES (Meta Marketing API)
// Bouwt campagne + advertentieset + creatief + advertentie, altijd PAUSED.
// Er wordt nooit automatisch budget uitgegeven; activeren doe je in Meta zelf.
// =======================================================================
const CAMPAIGN_OBJECTIVES = {
  OUTCOME_TRAFFIC: 'LINK_CLICKS',
  OUTCOME_AWARENESS: 'REACH',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
  // Leads en Verkoop: dit is de TERUGVAL (linkklikken) als er geen Meta Pixel is.
  // Mét een pixel zetten we bij het aanmaken OFFSITE_CONVERSIONS + het LEAD-event,
  // dus echte conversie-optimalisatie met 7-daagse attributie.
  OUTCOME_LEADS: 'LINK_CLICKS',
  OUTCOME_SALES: 'LINK_CLICKS',
};
const CTA_TYPES = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'BOOK_TRAVEL', 'CONTACT_US', 'GET_OFFER', 'SUBSCRIBE'];

function normalizeAdAccount(id) {
  const s = String(id || '').trim().replace(/^act_/, '');
  return s ? ('act_' + s) : '';
}

// =======================================================================
// AI-HULP (Claude) - copy/targeting-suggestie + analyse in gewone taal.
//  - Praat rechtstreeks met de officiele Anthropic Messages API via fetch.
//  - Sleutel staat in Render (ANTHROPIC_API_KEY), nooit in de code.
//  - Zonder sleutel valt alles netjes terug met een duidelijke melding.
// =======================================================================
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-5';

function aiConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim());
}

// Roept Claude aan en geeft de platte tekst van het antwoord terug.
async function callClaude(system, userText, maxTokens = 1500) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('AI is niet geconfigureerd (ANTHROPIC_API_KEY ontbreekt in Render)');
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) { /* geen json */ }
    throw new Error('AI-verzoek mislukt (' + resp.status + ')' + (detail ? ': ' + detail : ''));
  }
  const data = await resp.json();
  const parts = Array.isArray(data.content) ? data.content : [];
  const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
  if (!text) throw new Error('AI gaf een leeg antwoord terug');
  return text;
}

// Haalt het eerste JSON-object uit een tekst (Claude zet er soms uitleg omheen).
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI gaf geen bruikbaar JSON-antwoord');
  return JSON.parse(s.slice(start, end + 1));
}

// Lijst eerder aangemaakte campagnes (uit onze database).
router.get('/api/mkt/clients/:clientId/campaigns', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, name, objective, daily_budget_cents, status, meta_campaign_id, link, created_at
         FROM marketing.campaigns WHERE workspace_id=$1 AND client_id=$2 ORDER BY created_at DESC`,
      [wsId, okClient]
    )).rows);
    res.json({ success: true, campaigns: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Maak een nieuwe (gepauzeerde) campagne aan bij Meta.
router.post('/api/mkt/clients/:clientId/campaigns', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan campagnes aanmaken' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Campagnenaam is verplicht' });
    const objective = CAMPAIGN_OBJECTIVES[b.objective] ? b.objective : null;
    if (!objective) return res.status(400).json({ error: 'Kies een geldig campagnedoel' });
    // Koppelingen ophalen (client met terugval op workspace). Voor alleen een
    // campagne hebben we token + ad-account nodig (geen pagina of beeld).
    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    const adAccount = creds.adAccount;
    if (!token) return res.status(400).json({ error: 'Meta access token ontbreekt (klant en workspace)' });
    if (!adAccount) return res.status(400).json({ error: 'Ad Account ID ontbreekt (klant en workspace)' });

    // Alleen de campagne aanmaken (gepauzeerd, net als Meta). De advertentieset en
    // advertentie voeg je daarna apart toe via het campagne-overzicht.
    const campaign = await graphPost(`${adAccount}/campaigns`, {
      name, objective, status: 'PAUSED', special_ad_categories: '[]',
      is_adset_budget_sharing_enabled: 'false', access_token: token,
    });
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.campaigns
         (workspace_id, client_id, name, objective, daily_budget_cents, status, meta_campaign_id, meta_adset_id, meta_creative_id, meta_ad_id, asset_id, link, created_by)
       VALUES ($1,$2,$3,$4,$5,'PAUSED',$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, name, objective, daily_budget_cents, status, meta_campaign_id, link, created_at`,
      [wsId, okClient, name, objective, null, campaign.id, null, null, null, null, null, null, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, campaign: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Extra advertentieset toevoegen aan een bestaande campagne (alleen de ad set).
router.post('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/adsets', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Naam van de advertentieset is verplicht' });
    const euros = Number(b.dailyBudget);
    if (!Number.isFinite(euros) || euros < 1) return res.status(400).json({ error: 'Vul een dagbudget in van minimaal 1 euro' });
    const budgetCents = Math.round(euros * 100);
    const country = String(b.country || 'NL').trim().toUpperCase().slice(0, 2);
    const ageMin = Math.min(65, Math.max(13, parseInt(b.ageMin, 10) || 18));
    const ageMax = Math.min(65, Math.max(ageMin, parseInt(b.ageMax, 10) || 65));
    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    const adAccount = creds.adAccount;
    if (!token) return res.status(400).json({ error: 'Meta access token ontbreekt (klant en workspace)' });
    if (!adAccount) return res.status(400).json({ error: 'Ad Account ID ontbreekt (klant en workspace)' });

    // Een nieuwe ad set moet matchen met de campagne. Betrouwbaarste manier: de
    // optimalisatie + het gepromote object (pixel + event) OVERNEMEN van een
    // bestaande ad set in dezelfde campagne. Zo volgt de nieuwe ad set precies wat
    // er al draait, ook als de campagne handmatig in Meta is gemaakt (met conversies).
    // We kiezen bij voorkeur een bestaande conversie-ad-set (met gepromote object),
    // zodat we nooit per ongeluk een eerder fout gemaakte linkklik-ad-set kopieren.
    // Lukt dat niet (geen bestaande ad set), dan vallen we terug op het campagnedoel.
    let optimizationGoal = 'LINK_CLICKS';
    let promotedObject = null;
    let billingEvent = 'IMPRESSIONS';
    let pixelWarning = false;
    let matchedExisting = false;
    try {
      const ex = await graphGet(`${req.params.campaignId}/adsets`, {
        fields: 'optimization_goal,promoted_object,billing_event', limit: '25', access_token: token,
      });
      const list = (ex && ex.data) || [];
      const pick = list.find((s) => s && s.promoted_object) || list[0];
      if (pick && pick.optimization_goal) {
        optimizationGoal = pick.optimization_goal;
        if (pick.billing_event) billingEvent = pick.billing_event;
        if (pick.promoted_object) promotedObject = JSON.stringify(pick.promoted_object);
        matchedExisting = true;
      }
    } catch (_) { /* geen bestaande ad set te lezen: val terug op het campagnedoel */ }
    if (!matchedExisting) {
      try {
        const camp = await graphGet(`${req.params.campaignId}`, { fields: 'objective', access_token: token });
        if (camp && camp.objective && CAMPAIGN_OBJECTIVES[camp.objective]) optimizationGoal = CAMPAIGN_OBJECTIVES[camp.objective];
        if (camp && (camp.objective === 'OUTCOME_LEADS' || camp.objective === 'OUTCOME_SALES')) {
          if (creds.pixelId) {
            optimizationGoal = 'OFFSITE_CONVERSIONS';
            promotedObject = JSON.stringify({ pixel_id: String(creds.pixelId), custom_event_type: 'LEAD' });
          } else {
            pixelWarning = true; // Leads/Verkoop zonder pixel en geen bestaande ad set om te matchen.
          }
        }
      } catch (_) { /* val terug op LINK_CLICKS */ }
    }

    const genders = ['all', 'men', 'women'].includes(b.genders) ? b.genders : 'all';
    const interestIds = Array.isArray(b.interests) ? b.interests.map((x) => String((x && x.id) || x)).filter(Boolean).slice(0, 25) : [];
    const audienceIds = Array.isArray(b.audiences) ? b.audiences.map((x) => String((x && x.id) || x)).filter(Boolean).slice(0, 20) : [];
    const bidStrategy = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(b.bidStrategy) ? b.bidStrategy : 'LOWEST_COST_WITHOUT_CAP';
    let bidCapCents = null;
    if (bidStrategy === 'LOWEST_COST_WITH_BID_CAP') {
      const cap = Number(b.bidCap);
      if (!Number.isFinite(cap) || cap < 0.5) return res.status(400).json({ error: 'Vul een biedlimiet in van minimaal 0,50 euro' });
      bidCapCents = Math.round(cap * 100);
    }
    const placement = (b.placement === 'manual') ? 'manual' : 'automatic';

    // Locatie: straal rondom een gekozen plaats, of anders het hele land.
    const geoKey = String(b.geoKey || '').trim();
    let geoRadius = parseInt(b.geoRadius, 10);
    if (!Number.isFinite(geoRadius)) geoRadius = 25;
    if (geoRadius < 17) geoRadius = 17; // Meta hanteert 17 km als minimale straal
    if (geoRadius > 80) geoRadius = 80;
    const targetingObj = { age_min: ageMin, age_max: ageMax };
    if (geoKey) targetingObj.geo_locations = { cities: [{ key: geoKey, radius: geoRadius, distance_unit: 'kilometer' }] };
    else targetingObj.geo_locations = { countries: [country] };
    if (genders === 'men') targetingObj.genders = [1];
    else if (genders === 'women') targetingObj.genders = [2];
    if (interestIds.length) targetingObj.flexible_spec = [{ interests: interestIds.map((id) => ({ id })) }];
    if (audienceIds.length) targetingObj.custom_audiences = audienceIds.map((id) => ({ id }));
    if (placement === 'manual') {
      targetingObj.publisher_platforms = ['facebook', 'instagram'];
      targetingObj.facebook_positions = ['feed'];
      targetingObj.instagram_positions = ['stream'];
    }
    const targeting = JSON.stringify(targetingObj);
    const launchStatus = (b.launch === 'active') ? 'ACTIVE' : 'PAUSED';

    // Begunstigde/betaler (DSA, verplicht voor EU): de klantnaam.
    const benRow = await withReadConnection(async (c) => (await c.query(
      'SELECT name FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]);
    const beneficiary = String((benRow && benRow.name) || name).slice(0, 100);
    const adsetParams = {
      name, campaign_id: req.params.campaignId, daily_budget: String(budgetCents),
      billing_event: billingEvent, optimization_goal: optimizationGoal,
      bid_strategy: bidStrategy, targeting, status: launchStatus,
      dsa_beneficiary: beneficiary, dsa_payor: beneficiary,
      start_time: new Date(Date.now() + 3600 * 1000).toISOString(), access_token: token,
    };
    if (promotedObject) adsetParams.promoted_object = promotedObject;
    if (bidCapCents != null) adsetParams.bid_amount = String(bidCapCents);
    // Alleen de advertentieset aanmaken; de advertentie (beeld, kop, tekst) voegt
    // de gebruiker daarna apart toe via "Advertentie toevoegen".
    const adset = await createAdSetWithAttribution(adAccount, token, adsetParams);
    res.json({ success: true, adset_id: adset.id, status: launchStatus, pixelWarning });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Targeting van een advertentieset bewerken (land, leeftijd, geslacht, interesses, naam).
router.post('/api/mkt/clients/:clientId/meta-adsets/:adsetId/targeting', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });

    const b = req.body || {};
    const country = String(b.country || 'NL').trim().toUpperCase().slice(0, 2);
    const ageMin = Math.min(65, Math.max(13, parseInt(b.ageMin, 10) || 18));
    const ageMax = Math.min(65, Math.max(ageMin, parseInt(b.ageMax, 10) || 65));
    const genders = ['all', 'men', 'women'].includes(b.genders) ? b.genders : 'all';
    const interestIds = Array.isArray(b.interests) ? b.interests.map((x) => String((x && x.id) || x)).filter(Boolean).slice(0, 25) : [];

    // Locatie: straal rondom een gekozen plaats, of anders het hele land.
    const geoKey = String(b.geoKey || '').trim();
    let geoRadius = parseInt(b.geoRadius, 10);
    if (!Number.isFinite(geoRadius)) geoRadius = 25;
    if (geoRadius < 17) geoRadius = 17; // Meta hanteert 17 km als minimale straal
    if (geoRadius > 80) geoRadius = 80;
    const targetingObj = { age_min: ageMin, age_max: ageMax };
    if (geoKey) targetingObj.geo_locations = { cities: [{ key: geoKey, radius: geoRadius, distance_unit: 'kilometer' }] };
    else targetingObj.geo_locations = { countries: [country] };
    if (genders === 'men') targetingObj.genders = [1];
    else if (genders === 'women') targetingObj.genders = [2];
    if (interestIds.length) targetingObj.flexible_spec = [{ interests: interestIds.map((id) => ({ id })) }];

    const params = { targeting: JSON.stringify(targetingObj), access_token: token };
    const nm = b.name != null ? String(b.name).trim().slice(0, 200) : '';
    if (nm) params.name = nm;
    await graphPost(`${req.params.adsetId}`, params);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Interesses zoeken voor targeting (Meta targeting search).
router.get('/api/mkt/clients/:clientId/meta/interests', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, interests: [] });
    const creds = await resolveClientMeta(wsId, okClient);
    if (!creds.token) return res.json({ success: true, interests: [], configured: false });
    const r = await graphGet('search', { type: 'adinterest', q, limit: '20', access_token: creds.token });
    const interests = (r.data || []).map((i) => ({ id: i.id, name: i.name, audience_size: i.audience_size_lower_bound || i.audience_size || null }));
    res.json({ success: true, interests });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Locatie zoeken (steden) voor targeting met een straal.
router.get('/api/mkt/clients/:clientId/meta/geo', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, locations: [] });
    const creds = await resolveClientMeta(wsId, okClient);
    if (!creds.token) return res.json({ success: true, locations: [], configured: false });
    const r = await graphGet('search', { type: 'adgeolocation', location_types: JSON.stringify(['city']), q, limit: '10', access_token: creds.token });
    const locations = (r.data || []).map((l) => ({ key: l.key, name: l.name, region: l.region || null, country: l.country_name || l.country_code || null }));
    res.json({ success: true, locations });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Custom/lookalike audiences van het ad account.
router.get('/api/mkt/clients/:clientId/meta/audiences', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const creds = await resolveClientMeta(wsId, okClient);
    if (!creds.token || !creds.adAccount) return res.json({ success: true, audiences: [], configured: false });
    const r = await graphGet(`${creds.adAccount}/customaudiences`, { fields: 'id,name,subtype', limit: '50', access_token: creds.token });
    const audiences = (r.data || []).map((a) => ({ id: a.id, name: a.name, subtype: a.subtype || null }));
    res.json({ success: true, audiences });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// AI-ADVERTENTIE-ASSISTENT - prompt in, copy + targeting-voorstel uit.
//  De marketeer levert een korte briefing; Claude stelt advertentietekst,
//  call-to-action, doel, leeftijd/geslacht en interessewoorden voor.
//  Het beeld kiest de marketeer zelf; de campagne blijft altijd PAUSED.
// =======================================================================
router.post('/api/mkt/clients/:clientId/ai/ad-suggestion', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is nog niet geconfigureerd. Zet ANTHROPIC_API_KEY in Render.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const brief = String((req.body && req.body.prompt) || '').trim();
    if (brief.length < 5) return res.status(400).json({ error: 'Geef een korte briefing van minimaal een paar woorden' });

    const client = await withReadConnection(async (c) => (await c.query(
      'SELECT name, website, notes, brand_color FROM marketing.clients WHERE id=$1 AND workspace_id=$2',
      [okClient, wsId]
    )).rows[0]) || {};

    const system = [
      'Je bent een ervaren Nederlandse Meta-advertentiespecialist.',
      'Je schrijft advertentieteksten en stelt targeting voor op basis van een korte briefing.',
      'Schrijf altijd in het Nederlands. Gebruik NOOIT em-dashes of dubbele streepjes.',
      'Antwoord UITSLUITEND met een geldig JSON-object, zonder uitleg eromheen, met exact deze velden:',
      '{',
      '  "name": "korte campagnenaam (max 60 tekens)",',
      '  "caption": "advertentietekst, pakkend, max 500 tekens, mag emoji bevatten",',
      '  "objective": "een van OUTCOME_TRAFFIC, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES",',
      '  "cta": "een van LEARN_MORE, SHOP_NOW, SIGN_UP, BOOK_TRAVEL, CONTACT_US, GET_OFFER, SUBSCRIBE",',
      '  "ageMin": getal 13 t/m 65,',
      '  "ageMax": getal 13 t/m 65,',
      '  "genders": "een van all, men, women",',
      '  "interests": ["max 5 losse interessewoorden in het Nederlands of Engels voor Meta targeting"],',
      '  "rationale": "1 tot 2 korte zinnen waarom deze keuzes passen"',
      '}',
    ].join('\n');

    const ctx = [
      'Briefing van de marketeer: ' + brief,
      'Klantnaam: ' + (client.name || 'onbekend'),
      client.website ? ('Website: ' + client.website) : '',
      client.notes ? ('Notities over de klant: ' + String(client.notes).slice(0, 500)) : '',
    ].filter(Boolean).join('\n');

    const raw = await callClaude(system, ctx, 1200);
    const j = extractJson(raw);

    // Opschonen en binnen veilige grenzen houden.
    const objective = CAMPAIGN_OBJECTIVES[j.objective] ? j.objective : 'OUTCOME_TRAFFIC';
    const cta = CTA_TYPES.includes(j.cta) ? j.cta : 'LEARN_MORE';
    const genders = ['all', 'men', 'women'].includes(j.genders) ? j.genders : 'all';
    let ageMin = Math.min(65, Math.max(13, parseInt(j.ageMin, 10) || 18));
    let ageMax = Math.min(65, Math.max(ageMin, parseInt(j.ageMax, 10) || 65));
    const interestWords = Array.isArray(j.interests)
      ? j.interests.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5)
      : [];

    // Interessewoorden best-effort omzetten naar echte Meta-interesses.
    let resolvedInterests = [];
    try {
      const creds = await resolveClientMeta(wsId, okClient);
      if (creds.token && interestWords.length) {
        for (const w of interestWords) {
          if (w.length < 2) continue;
          try {
            const r = await graphGet('search', { type: 'adinterest', q: w, limit: '1', access_token: creds.token });
            const hit = (r.data || [])[0];
            if (hit && hit.id && !resolvedInterests.some((i) => i.id === hit.id)) {
              resolvedInterests.push({ id: hit.id, name: hit.name });
            }
          } catch (_) { /* dit woord overslaan */ }
        }
      }
    } catch (_) { /* geen koppeling: alleen woorden teruggeven */ }

    res.json({
      success: true,
      suggestion: {
        name: String(j.name || '').slice(0, 60),
        caption: String(j.caption || '').slice(0, 500),
        objective, cta, ageMin, ageMax, genders,
        interestWords,
        interests: resolvedInterests,
        rationale: String(j.rationale || '').slice(0, 400),
      },
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// AI-ANALYSE - leest de advertentie- en accountcijfers en geeft een
// verslag in gewone taal terug (wat gaat goed, wat kan beter, tips).
// =======================================================================
router.post('/api/mkt/clients/:clientId/ai/analysis', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is nog niet geconfigureerd. Zet ANTHROPIC_API_KEY in Render.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const client = await withReadConnection(async (c) => (await c.query(
      'SELECT name FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};

    const creds = await resolveClientMeta(wsId, okClient);
    if (!creds.token) return res.status(400).json({ error: 'Geen Meta-koppeling voor deze klant. Analyse is niet mogelijk.' });

    // Cijfers ophalen (zelfde bronnen als de rapportage).
    const figures = { account: null, ads: null, topPosts: [] };
    if (creds.igUserId) {
      try {
        const a = await graphGet(`${creds.igUserId}`, { fields: 'username,followers_count,media_count', access_token: creds.token });
        figures.account = { username: a.username || null, followers: a.followers_count ?? null, media: a.media_count ?? null };
      } catch (_) { /* overslaan */ }
      try {
        const m = await graphGet(`${creds.igUserId}/media`, {
          fields: 'caption,media_type,like_count,comments_count', limit: '10', access_token: creds.token,
        });
        const posts = (m.data || []).map((p) => ({
          caption: (p.caption || '').slice(0, 80), type: p.media_type, likes: p.like_count ?? 0, comments: p.comments_count ?? 0,
        }));
        posts.sort((x, y) => (y.likes + y.comments) - (x.likes + x.comments));
        figures.topPosts = posts.slice(0, 5);
      } catch (_) { /* overslaan */ }
    }
    if (creds.adAccount) {
      // Alleen de campagnes die aan DEZE klant gekoppeld zijn meenemen, zodat
      // cijfers van andere klanten op hetzelfde ad-account niet meelekken.
      let campIds = [];
      try {
        campIds = await withReadConnection(async (c) => (await c.query(
          `SELECT meta_campaign_id FROM marketing.campaign_links
             WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id IS NOT NULL
           UNION
           SELECT meta_campaign_id FROM marketing.campaigns
             WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id IS NOT NULL`,
          [wsId, okClient]
        )).rows.map((r) => r.meta_campaign_id).filter(Boolean));
      } catch (_) { campIds = []; }

      if (campIds.length) {
        try {
          const ins = await graphGet(`${creds.adAccount}/insights`, {
            level: 'campaign',
            fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm',
            date_preset: 'last_30d',
            filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
            access_token: creds.token,
          });
          const rows = ins.data || [];
          if (rows.length) {
            let spend = 0; let impressions = 0; let reach = 0; let clicks = 0;
            for (const r of rows) {
              spend += parseFloat(r.spend || 0) || 0;
              impressions += parseInt(r.impressions || 0, 10) || 0;
              reach += parseInt(r.reach || 0, 10) || 0;
              clicks += parseInt(r.clicks || 0, 10) || 0;
            }
            figures.ads = {
              spend: spend.toFixed(2), impressions, reach, clicks,
              ctr: impressions ? (clicks / impressions * 100).toFixed(2) : '0.00',
              cpc: clicks ? (spend / clicks).toFixed(2) : '0.00',
              cpm: impressions ? (spend / impressions * 1000).toFixed(2) : '0.00',
              campagnes: rows.length,
            };
          } else {
            figures.ads = { empty: true };
          }
        } catch (_) { /* overslaan */ }
      } else {
        figures.adsNote = 'Geen campagnes gekoppeld aan deze klant; advertentiecijfers zijn overgeslagen.';
      }
    }

    const hasData = figures.account || (figures.ads && !figures.ads.empty) || figures.topPosts.length;
    if (!hasData) return res.status(400).json({ error: 'Geen cijfers beschikbaar om te analyseren' });

    const system = [
      'Je bent een ervaren Nederlandse Meta-specialist die cijfers uitlegt aan een klant zonder marketingkennis.',
      'Schrijf in het Nederlands, in gewone taal, kort en concreet. Gebruik NOOIT em-dashes of dubbele streepjes.',
      'Er zijn twee losse onderdelen die je STRIKT gescheiden houdt en nooit door elkaar haalt:',
      '1. Organisch: het Instagram-account, de volgers en de gewone posts (het veld topPosts en account). Dit zijn GEEN advertenties.',
      '2. Advertenties: betaalde Meta-campagnes (het veld ads). Bespreek dit ALLEEN als er echte advertentiecijfers in ads staan. Staat er een adsNote of ontbreekt ads, dan lopen er GEEN campagnes: zeg dat in een zin en geef geen advertentie-analyse en geen advertentie-tips.',
      'Gebruik precies deze kopjes (gewone tekst, geen JSON):',
      'Samenvatting: 2 tot 3 zinnen over hoe het ervoor staat.',
      'Organische posts: wat gaat goed en wat kan beter, alleen op basis van de posts en volgers.',
      'Advertenties: alleen als er advertentiecijfers zijn; anders precies 1 zin dat er nog geen campagnes lopen.',
      'Concrete tips: 2 tot 4 acties, en zeg per tip duidelijk of het over organische posts of over advertenties gaat.',
      'Baseer alles alleen op de aangeleverde cijfers. Verzin geen getallen.',
    ].join('\n');

    const userText = 'Klant: ' + (client.name || 'onbekend') + '\n'
      + 'Cijfers laatste 30 dagen (Meta):\n' + JSON.stringify(figures, null, 2);

    const report = await callClaude(system, userText, 1600);
    res.json({ success: true, report, figures });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// AI-KPI-ANALYSE - toetst de reeds berekende campagnecijfers ("Campagne
// data algemeen") aan de DHC-normering v2.0 en geeft een kort, concreet
// advies: eindoordeel, funnel-bottleneck, observaties en verbeteracties.
// De cijfers komen uit de body (exact wat de workspace toont), er wordt
// dus geen extra Meta-call gedaan.
// =======================================================================
router.post('/api/mkt/clients/:clientId/ai/kpi-analysis', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is nog niet geconfigureerd. Zet ANTHROPIC_API_KEY in Render.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const ads = (req.body && typeof req.body.ads === 'object' && req.body.ads) ? req.body.ads : null;
    if (!ads || ads.empty || ads.impressions == null) {
      return res.status(400).json({ error: 'Geen campagnecijfers om te analyseren' });
    }
    const period = String((req.body && req.body.period) || 'laatste 30 dagen').slice(0, 60);

    const client = await withReadConnection(async (c) => (await c.query(
      'SELECT name FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};

    const system = [
      'Je bent een ervaren Nederlandse Meta-marketingspecialist bij Dynamic Health Consultancy (DHC).',
      'Je beoordeelt de cijfers van EEN betaalde Meta-leadcampagne (lokale fysio/leefstijl) volgens de vaste DHC-normering v2.0.',
      'Schrijf in het Nederlands, kort en concreet. Gebruik NOOIT em-dashes of dubbele streepjes.',
      'Baseer je uitsluitend op de aangeleverde cijfers. Verzin nooit getallen.',
      '',
      'DHC-normering v2.0 (per KPI):',
      '- Cost per Lead (CPL): PRIMAIRE resultaat-KPI. Doel < EUR 20. Beoordeel ALTIJD eerst CPL en het aantal leads.',
      '- Betrouwbaarheid op leadvolume: 0 tot 1 lead = geen harde conclusies (alleen signaleren); 2 = voorzichtig; 3 tot 4 = indicatief; 5 tot 9 = bruikbaar; 10 of meer = sterker onderbouwd.',
      '- CPM: < EUR 15 is norm, EUR 10 tot 13 is sterk.',
      '- Frequentie: DIAGNOSTISCH, geen afkeurgrens. < 2,5 normaal; 2,5 tot 3,5 monitoren; 3,5 tot 5 verhoogd (creative fatigue checken); > 5 alleen ingrijpen als CTR daalt en CPC/CPL stijgen. Keur een campagne NOOIT af op frequentie alleen.',
      '- Unieke CTR: >= 2% is norm, >= 3% is sterk. (CTR alle staat er ook bij als context; beoordeel op unieke CTR.)',
      '- CPC link: functioneel tot EUR 0,65, streefwaarde < EUR 0,50.',
      '- Klik naar landingspagina: >= 60% norm, >= 70% goed.',
      '- Landingspagina naar lead: >= 3% functioneel, >= 5% ambitie.',
      '',
      'Beslisregels om de bottleneck te bepalen:',
      '- CPL < EUR 20: eindresultaat binnen doel, niet onnodig ingrijpen.',
      '- Unieke CTR < 2%: advertentie/boodschap spreekt onvoldoende aan (creative, hook, propositie, doelgroep, CTA).',
      '- Unieke CTR goed maar CPC > EUR 0,65: verkeer is duur (veiling, doelgroep, plaatsingen, creative).',
      '- Unieke CTR goed + klik naar LP goed + LP naar lead < 3%: verlies zit NA de klik (landingspagina, aanbod, formulier, vertrouwen, CTA).',
      '- Klik naar LP < 60%: technische overgang (laadsnelheid, mobiel, link, tracking).',
      '- LP naar lead >= 5% maar CPL hoog: pagina converteert sterk maar verkeer is te duur (CPM, CPC, targeting).',
      '',
      'KERNREGEL: beoordeel eerst het commerciele resultaat (CPL en volume), bepaal daarna waar in de funnel winst of verlies ontstaat, en optimaliseer de bottleneck, niet de KPI die toevallig het meest rood kleurt.',
      '',
      'Verdiepingslenzen per bottleneck (gebruik de lens die bij de gevonden bottleneck hoort om de acties concreet te maken):',
      '- Advertentie (lage unieke CTR): kijk naar de creative zoals een ervaren ads-specialist. Loop langs beeld en scroll-stop (stopt het de duim?), de invalshoek (pijn, verlangen, vijand, bewijs, mechanisme, herkenning of status), de tekst op beeld als patroononderbreker, native-gevoel (content wint van een gladde advertentie), het aanbod en de call to action. Een hook moet in de eerste woorden duidelijk maken voor wie dit is en er moet iets op het spel staan; een vlakke constatering is geen hook. Geef acties als concrete ingrepen, nooit "overweeg om".',
      '- Verkeer (unieke CTR goed maar CPC te hoog): denk aan veiling, doelgroepbreedte, plaatsingen en of de creative het juiste publiek aantrekt in plaats van goedkope maar koude klikken.',
      '- Landingspagina (klik naar LP goed maar LP naar lead laag): keur de pagina met de CRO-bril. Toets message match met de advertentie (zelfde belofte, woorden en beeld), de waardepropositie boven de vouw, helderheid, frictie in het formulier (velden schrappen), twijfel wegnemen met bewijs op het beslismoment, en afleiding verminderen. Noem de belangrijkste tekst- of knopfix concreet.',
      '- Landingspagina (klik naar LP < 60%): dit is technisch, kijk naar laadsnelheid, mobiel, de link en tracking, niet naar de copy.',
      'Noem de merknaam of de skillherkomst niet in de output; gebruik de lenzen alleen als denkwijze. Verzin nooit beeld of copy die je niet kent; blijf bij wat de cijfers aangeven.',
      '',
      'Antwoord UITSLUITEND met een geldig JSON-object, zonder tekst eromheen, met exact deze velden:',
      '{',
      '  "eindoordeel": "1 korte zin over hoe de campagne er commercieel voor staat (CPL + leadvolume + betrouwbaarheid)",',
      '  "status": "een van: sterk, goed, aandacht, zwak",',
      '  "bottleneck": "een van: Bereik, Advertentie, Verkeer, Landingspagina, Leadopvolging, Geen",',
      '  "analyse": ["2 tot 4 observaties, elk 1 korte zin, per relevante KPI wat opvalt en waarom"],',
      '  "acties": ["2 tot 4 concrete verbeteracties, meest impactvolle eerst; sla frequentie over tenzij die echt problematisch is"]',
      '}',
    ].join('\n');

    const userText = 'Klant: ' + (client.name || 'onbekend') + '\n'
      + 'Periode: ' + period + '\n'
      + 'Campagnecijfers (som over de gekoppelde campagnes van deze klant):\n'
      + JSON.stringify(ads, null, 2);

    const raw = await callClaude(system, userText, 1200);
    let j;
    try { j = extractJson(raw); } catch (_) { j = null; }
    if (!j) return res.json({ success: true, analysis: { eindoordeel: raw.slice(0, 600), status: '', bottleneck: '', analyse: [], acties: [] } });

    const allowStatus = ['sterk', 'goed', 'aandacht', 'zwak'];
    const allowBottleneck = ['Bereik', 'Advertentie', 'Verkeer', 'Landingspagina', 'Leadopvolging', 'Geen'];
    const cleanList = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4) : []);
    res.json({
      success: true,
      analysis: {
        eindoordeel: String(j.eindoordeel || '').slice(0, 400),
        status: allowStatus.includes(j.status) ? j.status : '',
        bottleneck: allowBottleneck.includes(j.bottleneck) ? j.bottleneck : '',
        analyse: cleanList(j.analyse),
        acties: cleanList(j.acties),
      },
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// AD MACHINE - creatie- en keuringsskills (Claude) in de workspace
// =======================================================================

// Strip HTML naar leesbare tekst (voor de conversielek-keuring van een URL).
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Haalt best-effort de tekst van een publieke landingspagina op. Blokkeert interne hosts.
async function fetchPageText(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch (_) { throw new Error('Ongeldige URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Alleen http of https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || /\.local$/.test(host)
      || /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new Error('Interne host geblokkeerd');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DHC-Workspace/1.0)' },
    });
    if (!r.ok) throw new Error('Pagina gaf status ' + r.status);
    const html = await r.text();
    const text = htmlToText(html);
    if (!text) throw new Error('Geen leesbare tekst gevonden');
    return text.slice(0, 12000);
  } finally { clearTimeout(timer); }
}

const ADM_COMMON = [
  '',
  'Uitvoerregels (altijd):',
  '- Schrijf in natuurlijk Nederlands, zoals iemand praat, niet zoals een merk schrijft.',
  '- Gebruik NOOIT em-dashes of koppeltekens (-) in lopende of creatieve tekst.',
  '- Vermijd AI-woorden: krachtig, optimaal, effectief, naadloos, moeiteloos, transformeer, ontdek, gamechanger, ultiem. En geen openers die eerlijkheid aankondigen zoals "eerlijk" of "even onder ons".',
  '- Lever het resultaat in Markdown: koppen met ##, nadruk met **vet**, lijsten met - of met 1. Gebruik GEEN tabellen en GEEN HTML. Zet labels zoals Shot of Script op een eigen regel met **vet**.',
  '- Verzin nooit cijfers, resultaten, beeld of tekst die je niet hebt gekregen. Weet je iets niet, zeg dat kort en vraag door.',
  '- Noem geen tool-, skill- of merkherkomst in de output.',
];

// key -> publieke config (voor het formulier) + system (prompt voor Claude)
const ADSKILLS = {
  'concurrentie-analyse': {
    title: 'Concurrentie-analyse',
    desc: 'Zie welke invalshoeken in de markt al bezet zijn en waar het gat zit, op basis van wat jij in de Meta Ad Library ziet.',
    note: 'Open de Meta Ad Library, zoek de concurrent of markt en plak hieronder wat je ziet: welke advertenties lopen er, hoe lang al, welke invalshoeken en teksten. De analyse werkt op wat jij aanlevert.',
    maxTokens: 2200,
    fields: [
      { name: 'concurrent', label: 'Concurrent of markt', type: 'text', required: true, ph: 'bv. fysiotherapie Zeeland, of een concurrentnaam' },
      { name: 'observaties', label: 'Wat je in de Ad Library ziet', type: 'textarea', ph: 'Welke advertenties lopen er, hoe lang al, welke invalshoeken, welke teksten op beeld, welke formats...' },
    ],
    system: [
      'Je bent een ervaren Nederlandse ads-strateeg die concurrentie in kaart brengt.',
      'Het kernidee: een advertentie die al weken of maanden draait kost elke dag geld, dus looptijd is het beste publieke signaal voor wat werkt.',
      'Je krijgt geen live Ad Library; je werkt met wat de gebruiker aanlevert. Vraag om meer observaties als het te dun is, maar lever met wat er ligt een zo scherp mogelijke analyse.',
      'Structuur van je antwoord:',
      '1. Wie er adverteert en wat opvalt.',
      '2. Welke creatives het langst lijken te lopen en waarom dat een signaal is.',
      '3. Welke invalshoeken (pijn, verlangen, vijand, bewijs, mechanisme, herkenning, status) al bezet zijn.',
      '4. Welke invalshoek vrij ligt (de witte plek) en waarom die kans biedt.',
      '5. Een concreet advies welke hoek de gebruiker zou pakken om zich te onderscheiden.',
    ].concat(ADM_COMMON).join('\n'),
  },
  'advertentieconcept': {
    title: 'Advertentieconcept',
    desc: 'Complete creatieve concepten: het verhaal onder de campagne, de rode draad en drie uitwerkingen per concept, plus een rauwe ugly-variant.',
    note: 'Een concept is het verhaal waar een hele campagne aan hangt, niet een losse ad. Geef minimaal het aanbod en de doelgroep.',
    maxTokens: 2600,
    fields: [
      { name: 'aanbod', label: 'Wat verkoop je? (aanbod en prijs)', type: 'text', required: true, ph: 'bv. 4-weken leefstijltraject, 149 euro' },
      { name: 'doelgroep', label: 'Aan wie precies?', type: 'text', required: true, ph: 'de groep die zichzelf herkent, niet "iedereen"' },
      { name: 'pijn', label: 'Grootste pijn en diepste verlangen', type: 'text', ph: '' },
      { name: 'mechanisme', label: 'Wat maakt het anders (uniek mechanisme)?', type: 'text', ph: '' },
      { name: 'platform', label: 'Waar draait de ad?', type: 'select', options: ['Meerdere', 'Reels', 'Feed', 'Stories', 'TikTok'] },
      { name: 'beeld', label: 'Heb je al beeld of een winnende stijl?', type: 'text', ph: '' },
    ],
    system: [
      'Je bent een ervaren creative strategist en creative director. Je bedenkt advertentieconcepten die opvallen, blijven plakken en verkopen.',
      'Je gelooft dat een rauwe, echte advertentie het vaak wint van een gladde. Een concept is een hoek op het product die de juiste persoon raakt op het juiste gevoel, in een vorm die native aanvoelt op de feed.',
      'Kies per concept eerst de invalshoek (pijn, verlangen, vijand, bewijs, mechanisme, herkenning, status), nooit vijf keer dezelfde. Bouw dan het verhaal, zoek het herkenbare element (de rode draad), en werk het pas daarna uit in formats.',
      'Formats om uit te kiezen: static, carrousel, meme-ad, UGC-foto, voor-na, screenshot-ad, tekstpost, demo.',
      'Lever 3 concepten. Gebruik per concept deze opbouw met vette labels op aparte regels:',
      'Het verhaal, De omslag (wat de kijker nu gelooft naar wat hij gelooft na drie ads), Invalshoek, Voor wie precies, Waarom nu, Rode draad, Uitwerkingen (3 stuks: format, wat je in beeld ziet, en de tekst op beeld tussen aanhalingstekens), Ugly-variant, Rek (hoe je het uitbouwt als het werkt).',
      'Sluit af met "Mijn top 3": de concepten op volgorde, per stuk een zin waarom hij wint en welke uitwerking je eerst test.',
      'Zit het aanbod in gezondheid, afvallen of uiterlijk: geen voor-na van een lichaam, geen resultaatbelofte als claim, en spreek de lezer niet aan op een aandoening. Kies dan bij voorkeur bewijs, mechanisme, herkenning of identiteit als hoek en noem onder de top 3 kort welke uitwerking kans op afkeuring heeft en wat je verandert.',
    ].concat(ADM_COMMON).join('\n'),
  },
  'hook-generator': {
    title: 'Hooks',
    desc: 'Nederlandse hooks en scroll stoppers voor ads en short-form video, per categorie, met een top 3.',
    note: 'Een hook is geen intro maar een patroononderbreker. In de eerste vijf woorden moet duidelijk zijn voor wie het is, en er moet iets op het spel staan.',
    maxTokens: 2200,
    fields: [
      { name: 'product', label: 'Product of aanbod', type: 'text', required: true, ph: '' },
      { name: 'doelgroep', label: 'Doelgroep', type: 'text', required: true, ph: '' },
      { name: 'pijn', label: 'Grootste pijnpunt', type: 'text', ph: '' },
      { name: 'verlangen', label: 'Wat willen ze het liefst bereiken?', type: 'text', ph: '' },
      { name: 'tone', label: 'Tone of voice', type: 'text', ph: 'speels, premium, confronterend, founder, UGC, bold' },
      { name: 'platform', label: 'Platform', type: 'select', options: ['Meta', 'Reels', 'TikTok', 'YouTube Shorts'] },
      { name: 'winhook', label: 'Bestaande winnende hook (optioneel)', type: 'textarea', ph: 'Lever een hook aan en ik maak varianten. Double down on your winners.' },
    ],
    system: [
      'Je bent een ervaren ads-specialist en hook-expert. Je bedenkt Nederlandse hooks die in de eerste 2 tot 3 seconden de aandacht pakken.',
      'Een goede hook is een patroononderbreker. De kijker moet binnen 2 seconden denken: dit gaat over mij. In de eerste vijf woorden staat het onderwerp, de klacht of de groep, zodat de juiste persoon zich aangesproken voelt en de rest doorscrollt.',
      'Er moet iets op het spel staan: benoem wat het nu kost, confronteer met iets wat de kijker over zichzelf weet, laat zien wat verdwijnt, of maak het specifiek met een concreet getal of moment. Een vlakke constatering is geen hook.',
      'Lever minimaal vier categorieen, elk minimaal vijf hooks, met gemengde invalshoeken (controversieel, FOMO, probleemgericht, verlangen, curiosity, myth-busting, status, directe command):',
      'Founder of expert hooks (als er geen uitgesproken founder is, kies expert- of klanthooks en zeg welke en waarom), UGC hooks, Branded hooks, POV hooks.',
      'Krijg je een bestaande winnende hook, lever dan minimaal vijf varianten daarop onder het kopje Winning iteraties.',
      'Sluit af met "Mijn top 3", elk met een zin waarom hij wint.',
      'Nooit trage openers zoals "In deze video", "Vandaag wil ik het hebben over", "Misschien herken je dit". Kort genoeg om in een adem te zeggen. In gevoelige markten spreek je de lezer niet aan op een aandoening; draai het naar de eerste persoon of een algemene observatie.',
    ].concat(ADM_COMMON).join('\n'),
  },
  'ad-scripts': {
    title: 'Video-scripts',
    desc: 'Scripts voor video ads volgens Hook, Rehook, Pijnpunt, Body, CTA, met shot per onderdeel. Eerst een voorbeeld, daarna vier varianten.',
    note: 'Eerst krijg je een script ter goedkeuring. Pas daarna de vier extra varianten. De spreker is altijd zelf gebruiker van het product, nooit verkoper.',
    maxTokens: 2600,
    fields: [
      { name: 'merk', label: 'Merk of product', type: 'text', required: true, ph: '' },
      { name: 'pagina', label: 'Landingspagina (plak de tekst of een URL)', type: 'textarea', required: true, ph: 'Wat wordt verkocht, voor wie, wat is de belofte en de pijn' },
      { name: 'doelgroep', label: 'Doelgroep', type: 'text', ph: '' },
      { name: 'pijn', label: 'Specifieke pijn of invalshoek', type: 'text', ph: '' },
    ],
    phased: true,
    system: [
      'Je bent een ervaren creative strategist die scripts schrijft voor video ads. Je schrijft scripts die voelen als content, niet als reclame. De spreker is altijd zelf gebruiker van het product, nooit verkoper.',
      'Elk script volgt deze opbouw, met per onderdeel een regel Shot (hoe het shot wordt opgenomen) en een regel Script:',
      'Hook (0 tot 3 sec, 1 tot 2 zinnen): direct erin, mid-sentence, geen intro. Pijn-variant of realisatie-variant.',
      'Rehook (3 tot 9 sec): het probleem groter en concreter maken.',
      'Pijnpunt (9 tot 15 sec): de emotionele laag, alledaagse taal.',
      'Body (15 tot 24 sec): de kentering, 1 tot 2 concrete features of waarom de standaardroute niet werkt.',
      'CTA (24 tot 30 sec): productnaam, kort wat het is, wat het oplevert. Nooit een command zoals "klik nu", altijd een uitnodiging.',
      'Totale gesproken lengte 20 tot 30 seconden, ongeveer 55 tot 75 gesproken woorden. Zinnen mogen lang zijn en in elkaar overlopen; het moet klinken als praten, niet als een opsomming. Tijdsmarkers komen NIET in de output.',
      'Geen emoji, geen vakjargon, geen marketingtaal.',
    ].concat(ADM_COMMON).join('\n'),
    systemFirst: 'Lever nu EERST een enkel script ter goedkeuring, niet meer dan een. Dit is het voorbeeld waar de gebruiker feedback op geeft.',
    systemVariants: 'De gebruiker heeft het eerste script gezien. Lever nu VIER extra varianten. Elke hook echt anders (andere invalshoek, andere openingszin, ander openingsshot). Body mag feiten delen. Geef Facebook vier nieuwe ingangen, geen versies van hetzelfde.',
  },
  'advertentieteksten': {
    title: 'Advertentieteksten',
    desc: 'Complete set: 5 primaire teksten (2 lang en verhalend), 5 headlines en 1 beschrijving, in de juiste lengtes per platform.',
    note: 'Connect first, sell second. De eerste zin bepaalt alles. De aantallen liggen vast: altijd 5 primaire teksten, 5 headlines en 1 beschrijving.',
    maxTokens: 3000,
    fields: [
      { name: 'aanbod', label: 'Wat verkoop je? (aanbod en prijs)', type: 'text', required: true, ph: '' },
      { name: 'doelgroep', label: 'Aan wie precies?', type: 'text', required: true, ph: '' },
      { name: 'pijn', label: 'Grootste pijn of verlangen', type: 'text', ph: '' },
      { name: 'belofte', label: 'Belofte of resultaat', type: 'text', ph: '' },
      { name: 'mechanisme', label: 'Uniek mechanisme of invalshoek', type: 'text', ph: '' },
      { name: 'actie', label: 'Gewenste actie', type: 'text', ph: 'bv. gratis kennismaking aanvragen' },
      { name: 'tone', label: 'Tone of voice', type: 'text', ph: '' },
      { name: 'platform', label: 'Platform', type: 'select', options: ['Meta', 'TikTok', 'Pinterest', 'LinkedIn'] },
    ],
    system: [
      'Je bent een ervaren creative performance strategist. Je maakt advertenties die voelen als content, niet als promotie. Connect first, sell second. Je schrijft alsof je een persoon recht aankijkt.',
      'Lever altijd een complete set: 5 primaire teksten, 5 headlines en 1 beschrijving. Die aantallen liggen vast, ook als de brief dun is. Lever nooit in delen.',
      'De 5 primaire teksten: 2 korte (5 tot 6 zinnen), 1 middellange (100 tot 150 woorden), 2 lange verhalende (echt 250 tot 400 woorden, met een scene, niet een samenvatting).',
      'Lange teksten: begin in een scene, blijf lang in het probleem, laat iemand iets zeggen, een klein kantelpunt, het aanbod pas in de laatste alinea als uitnodiging, eindig laag en concreet. Geen opsommingen of tussenkopjes in de lange teksten.',
      'Elke tekst pakt een andere invalshoek. De eerste zin is een scroll stopper en het onderwerp of de doelgroep staat in de eerste regel. Bij Meta werken de eerste twee regels los van elkaar (voor het afkappunt rond 125 tekens).',
      'Headlines: 5 stuks, maximaal 5 woorden, prikkelend, een tweede haakje, geen samenvatting. Beschrijving: 1, maximaal 5 woorden, licht conversiegericht.',
      'Houd je aan de platformlengtes (Meta, TikTok, Pinterest of LinkedIn). Sluit af met een top 3 van de sterkste primaire teksten, elk met een zin waarom en welke invalshoek.',
      'In gevoelige markten: spreek de lezer niet aan op een aandoening, beloof geen resultaat, geen voor-na van een lichaam, en beloof niet harder dan de pagina waarmaakt.',
    ].concat(ADM_COMMON).join('\n'),
  },
  'ad-analyse': {
    title: 'Ad-analyse (static)',
    desc: 'Diagnose van een bestaande statische advertentie: waarom hij niet stopt, niet klikt of niet schaalt, met cijfer per onderdeel en een eindoordeel.',
    note: 'Beeld uploaden kan hier nog niet. Beschrijf de static zo precies mogelijk (alles wat in beeld staat en alle tekst letterlijk), dan is de diagnose scherp. Alleen voor statics, niet voor video.',
    maxTokens: 2400,
    fields: [
      { name: 'omschrijving', label: 'Beschrijf de static (beeld en alle tekst letterlijk)', type: 'textarea', required: true, ph: 'Wat staat er in beeld, wie, welke uitsnede, en alle tekst, badges en knoppen letterlijk' },
      { name: 'product', label: 'Product', type: 'text', ph: '' },
      { name: 'doelgroep', label: 'Doelgroep', type: 'text', ph: '' },
      { name: 'link', label: 'Waar linkt de ad heen', type: 'text', ph: '' },
      { name: 'cijfers', label: 'Bekende cijfers (CTR, kosten, conversie)', type: 'text', ph: '' },
      { name: 'primair', label: 'Primaire tekst en headline (optioneel)', type: 'textarea', ph: '' },
    ],
    system: [
      'Je diagnosticeert een bestaande statische advertentie zoals iemand die duizenden statics heeft zien draaien. Geen beschouwing maar een diagnose: waar lekt deze ad aandacht of conversie en wat doe je eraan. Wees beslissend en eerlijk, niet aardig om het aardig zijn.',
      'Dit werkt alleen voor statics. Gaat het om video of een Reel, zeg dat dit niet de juiste analyse is.',
      'Begin met het kopje "Wat er in de ad staat": neem letterlijk over wat de gebruiker beschrijft (tekst, beeld, opmaak). Keur alleen wat je echt hebt gekregen; verzin geen element dat er niet staat.',
      'Keur dan deze zes onderdelen, elk met een cijfer 1 tot 10, een oordeel (FOUT, ZWAK of GOED met een zin waarom) en een concrete fix (bij tekst een kant-en-klare herschrijving tussen aanhalingstekens, nooit "overweeg om"):',
      'Beeld en scroll-stop, De invalshoek, Tekst op beeld, Native of advertentie, Aanbod en claim, Call to action.',
      'Krijg je ook de primaire tekst en headline, keur die als twee extra onderdelen (eerste regel voor het afkappunt, headline als tweede haakje).',
      'Wees streng; de meeste statics scoren 4 tot 6. Geef bovenaan een verdict: KILLEN (hoek klopt niet of beeld stopt structureel niet, zeg wat er mis was aan de hoek), ITEREREN (hoek staat, uitvoering lekt) of SCHALEN (alles staat). Sluit af met "Test als eerste": drie concrete varianten met wat je ermee checkt.',
    ].concat(ADM_COMMON).join('\n'),
  },
  'conversielek-keuring': {
    title: 'Conversielek-keuring',
    desc: 'Keurt een landingspagina als een CRO-specialist: elk tekstelement met cijfer, wat er fout is en een kant-en-klaar voorstel.',
    note: 'Geef de URL (ik probeer de pagina op te halen) of plak de pagina-tekst. Plakken is het betrouwbaarst.',
    maxTokens: 3000,
    fields: [
      { name: 'url', label: 'URL van de landingspagina', type: 'text', ph: 'https://...' },
      { name: 'paginatekst', label: 'Of plak de pagina-tekst hier', type: 'textarea', ph: 'Kopieer de teksten van de pagina van boven naar beneden' },
      { name: 'doel', label: 'Doel van de pagina', type: 'select', options: ['Onbekend', 'Verkoop', 'Lead', 'Aanmelding'] },
      { name: 'bron', label: 'Welke ad of mail stuurt hierheen', type: 'text', ph: 'voor de message match' },
    ],
    system: [
      'Je keurt een landingspagina zoals een ervaren conversiespecialist (CRO): niet als beschouwing, maar als keuringsrapport. Je loopt de pagina van boven naar beneden langs en keurt elk tekst- en structuurelement. Wees beslissend en eerlijk; een 5 is gemiddeld, inflateer niet.',
      'Keur alleen wat je echt in de aangeleverde pagina-inhoud ziet. Is er geen inhoud opgehaald of geplakt, zeg dan eerlijk dat je de pagina-tekst nodig hebt en keur niet op aannames.',
      'Je denkraam is het LIFT-model (waardepropositie, relevantie, helderheid, urgentie, angst en twijfel, afleiding) en de fundamenten above the fold, CTA en frictie. Toets ook de message match met de advertentie of mail die het verkeer stuurt.',
      'Per element lever je: Huidig (letterlijk geciteerd), Cijfer (1 tot 10), Oordeel (FOUT, ZWAK of GOED met een zin waarom, gekoppeld aan een LIFT-factor of fundament), Voorstel (een kant-en-klare herschrijving tussen aanhalingstekens, dit is het belangrijkste) en Waarom (een zin waarom dat beter converteert). Een goed element keur je kort af en je gaat door.',
      'Opbouw: een korte samenvatting bovenaan met het gemiddelde cijfer en waar het lekt, dan de keuringskaarten van boven naar beneden, dan een top 3 fixes (hoogste impact eerst) en een lijstje quick wins. Prioriteer waardepropositie en relevantie eerst, dan frictie en afleiding, dan urgentie, twijfel en helderheid.',
    ].concat(ADM_COMMON).join('\n'),
  },
};

// Publieke config voor de formulieren (zonder de prompts).
router.get('/api/mkt/admachine/skills', requireMkt, (req, res) => {
  const out = Object.keys(ADSKILLS).map((key) => {
    const s = ADSKILLS[key];
    return {
      key,
      title: s.title,
      desc: s.desc,
      note: s.note || '',
      phased: !!s.phased,
      fields: (s.fields || []).map((f) => ({
        name: f.name, label: f.label, type: f.type || 'text',
        required: !!f.required, ph: f.ph || '', options: f.options || null,
      })),
    };
  });
  res.json({ success: true, skills: out });
});

// Draait een skill via Claude en geeft Markdown terug.
router.post('/api/mkt/clients/:clientId/ai/admachine', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is nog niet geconfigureerd. Zet ANTHROPIC_API_KEY in Render.' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const skillKey = String((req.body && req.body.skill) || '').trim();
    const skill = ADSKILLS[skillKey];
    if (!skill) return res.status(400).json({ error: 'Onbekende skill' });

    const brief = (req.body && typeof req.body.brief === 'object' && req.body.brief) ? req.body.brief : {};
    const fase = String((req.body && req.body.fase) || '').trim();
    const previous = String((req.body && req.body.previous) || '').slice(0, 8000);

    // Verplichte velden controleren.
    const missing = (skill.fields || [])
      .filter((f) => f.required && !String(brief[f.name] || '').trim())
      .map((f) => f.label);
    if (missing.length) return res.status(400).json({ error: 'Vul eerst in: ' + missing.join(', ') });

    const client = await withReadConnection(async (c) => (await c.query(
      'SELECT name FROM marketing.clients WHERE id=$1 AND workspace_id=$2', [okClient, wsId]
    )).rows[0]) || {};

    const briefLines = [];
    (skill.fields || []).forEach((f) => {
      if (f.name === 'paginatekst' || f.name === 'url') return; // apart afgehandeld
      const v = String(brief[f.name] || '').trim();
      if (v) briefLines.push(f.label + ': ' + v.slice(0, 2000));
    });

    // Conversielek-keuring: pagina-inhoud bepalen (geplakt heeft voorrang, anders ophalen).
    if (skillKey === 'conversielek-keuring') {
      const pasted = String(brief.paginatekst || '').trim();
      const url = String(brief.url || '').trim();
      if (!pasted && !url) return res.status(400).json({ error: 'Geef een URL of plak de pagina-tekst' });
      if (url) briefLines.push('URL: ' + url.slice(0, 500));
      let pageText = '';
      if (pasted) {
        pageText = pasted.slice(0, 12000);
      } else if (url) {
        try { pageText = await fetchPageText(url); } catch (_) { pageText = ''; }
      }
      if (pageText) briefLines.push('Pagina-inhoud (letterlijk, mogelijk ingekort):\n' + pageText);
      else briefLines.push('Pagina-inhoud: kon niet worden opgehaald. Vraag de gebruiker de pagina-tekst te plakken en keur niet op aannames.');
    }

    let system = skill.system;
    if (skill.phased) {
      if (fase === 'varianten') system += '\n\n' + (skill.systemVariants || '');
      else system += '\n\n' + (skill.systemFirst || '');
    }

    let userText = 'Klant: ' + (client.name || 'onbekend') + '\n\n' + briefLines.join('\n');
    if (skill.phased && fase === 'varianten' && previous) {
      userText += '\n\nHet eerste script dat de gebruiker heeft gezien:\n' + previous;
    }

    const raw = await callClaude(system, userText, skill.maxTokens || 2000);
    res.json({ success: true, output: raw, phased: !!skill.phased, fase: fase || (skill.phased ? 'eerste' : '') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// STAP 6 - RAPPORTAGE per klant (cijfers uit eigen data)
// =======================================================================
router.get('/api/mkt/clients/:clientId/stats', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const stats = await withReadConnection(async (c) => {
      const posts = (await c.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status='published')::int AS published,
           COUNT(*) FILTER (WHERE status='scheduled')::int AS scheduled,
           COUNT(*) FILTER (WHERE approval='pending')::int AS pending,
           COUNT(*) FILTER (WHERE approval='approved')::int AS approved,
           COUNT(*) FILTER (WHERE approval='changes')::int AS changes,
           COUNT(*) FILTER (WHERE scheduled_at >= now())::int AS upcoming
         FROM marketing.content_posts WHERE workspace_id=$1 AND client_id=$2`,
        [wsId, okClient]
      )).rows[0];
      const assets = (await c.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE resource_type='video')::int AS videos,
           COALESCE(SUM(size_bytes),0)::bigint AS bytes
         FROM marketing.assets WHERE workspace_id=$1 AND client_id=$2`,
        [wsId, okClient]
      )).rows[0];
      const next = (await c.query(
        `SELECT title, scheduled_at FROM marketing.content_posts
          WHERE workspace_id=$1 AND client_id=$2 AND scheduled_at >= now()
          ORDER BY scheduled_at ASC LIMIT 1`,
        [wsId, okClient]
      )).rows[0] || null;
      return { posts, assets, next };
    });
    res.json({ success: true, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 5 - GOEDKEURINGSPORTAAL
// Marketeer zet posts 'ter goedkeuring' en deelt een token-link per klant.
// De klant keurt goed of vraagt wijzigingen, zonder account.
// =======================================================================
const APPROVAL = ['none', 'pending', 'approved', 'changes'];

// Genereer (of vernieuw) de deel-token voor de goedkeuringslink van een klant.
router.post('/api/mkt/clients/:clientId/portal-token', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = crypto.randomBytes(24).toString('hex');
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.clients SET approval_token=$1 WHERE id=$2 AND workspace_id=$3 RETURNING approval_token`,
      [token, okClient, wsId]
    )).rows[0]);
    res.json({ success: true, approval_token: row.approval_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publiek: haal de te beoordelen content op via het token (geen login).
router.get('/api/mkt/portal/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 20) return res.status(404).json({ error: 'Ongeldige link' });
    const client = await withReadConnection(async (c) => (await c.query(
      `SELECT id, name, brand_color FROM marketing.clients WHERE approval_token=$1`, [token]
    )).rows[0]);
    if (!client) return res.status(404).json({ error: 'Link niet gevonden of ingetrokken' });
    const posts = await withReadConnection(async (c) => (await c.query(
      `SELECT p.id, p.title, p.body, p.channel, p.scheduled_at, p.approval, p.approval_note, p.approval_at,
              a.url AS asset_url, a.resource_type AS asset_type
         FROM marketing.content_posts p
         LEFT JOIN marketing.assets a ON a.id = p.asset_id
        WHERE p.client_id=$1 AND p.approval <> 'none'
        ORDER BY p.scheduled_at ASC NULLS LAST, p.created_at DESC`, [client.id]
    )).rows);
    res.json({ success: true, client: { name: client.name, brand_color: client.brand_color }, posts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publiek: klant keurt een post goed of vraagt wijzigingen.
router.post('/api/mkt/portal/:token/decision', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 20) return res.status(404).json({ error: 'Ongeldige link' });
    const { postId, decision, note } = req.body || {};
    if (decision !== 'approved' && decision !== 'changes') return res.status(400).json({ error: 'Ongeldige keuze' });
    const client = await withReadConnection(async (c) => (await c.query(
      `SELECT id FROM marketing.clients WHERE approval_token=$1`, [token]
    )).rows[0]);
    if (!client) return res.status(404).json({ error: 'Link niet gevonden' });
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_posts
          SET approval=$1, approval_note=$2, approval_at=now(), updated_at=now()
        WHERE id=$3 AND client_id=$4 AND approval <> 'none'
       RETURNING id, approval, approval_note, approval_at`,
      [decision, (note && String(note).trim().slice(0, 1000)) || null, postId, client.id]
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 10 - BESTAANDE META-CAMPAGNES ophalen (read-only)
// Toont wat er al draait op het ad account, zodra de koppeling is ingevuld.
// =======================================================================
router.get('/api/mkt/clients/:clientId/meta-campaigns', requireMkt, async (req, res) => {
  try {
    // Klant-account mag de eigen campagnes alleen-lezen inzien; andere klanten geblokkeerd.
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    const adAccount = creds.adAccount;
    if (!token || !adAccount) return res.json({ success: true, configured: false });

    const out = { configured: true, campaigns: [], error: null };
    try {
      const list = await graphGet(`${adAccount}/campaigns`, {
        fields: 'name,objective,status,effective_status,daily_budget,lifetime_budget,start_time',
        limit: '50', access_token: token,
      });
      // Cijfers per campagne (laatste 30 dagen), gebundeld opgehaald.
      const stats = {};
      try {
        const ins = await graphGet(`${adAccount}/insights`, {
          level: 'campaign', fields: 'campaign_id,spend,impressions,reach,clicks,ctr',
          ...adsDateSel(req), limit: '200', access_token: token,
        });
        (ins.data || []).forEach((r) => { stats[r.campaign_id] = r; });
      } catch (_) { /* cijfers optioneel */ }

      out.campaigns = (list.data || []).map((c) => {
        const s = stats[c.id] || {};
        const budget = c.daily_budget ? (Number(c.daily_budget) / 100) : (c.lifetime_budget ? (Number(c.lifetime_budget) / 100) : null);
        return {
          id: c.id, name: c.name, objective: c.objective,
          status: c.effective_status || c.status,
          budget, budget_type: c.daily_budget ? 'dag' : (c.lifetime_budget ? 'totaal' : null),
          start_time: c.start_time || null,
          spend: s.spend ?? null, impressions: s.impressions ?? null, reach: s.reach ?? null,
          clicks: s.clicks ?? null, ctr: s.ctr ?? null,
        };
      });
    } catch (e) { out.error = e.message; }

    // Klant-account ziet alleen de aan de eigen klant gekoppelde campagnes,
    // nooit de hele ad-account (team houdt de volledige lijst om te koppelen).
    if (mktClientLocked(req)) {
      try {
        const linked = new Set((await withReadConnection(async (c) => (await c.query(
          'SELECT meta_campaign_id FROM marketing.campaign_links WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id IS NOT NULL', [wsId, okClient]
        )).rows)).map((r) => String(r.meta_campaign_id)));
        out.campaigns = (out.campaigns || []).filter((c) => linked.has(String(c.id)));
      } catch (_) { out.campaigns = []; }
    }

    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agency-overzicht: "eigen account"-cijfers, ALLEEN op aanvraag (zwaar: veel
// Meta-calls). 'part=post' = best presterende post van het werkplek-IG.
// 'part=campaigns' = actieve campagnes over de hele workspace (werkplek-ad-account
// plus eventuele eigen ad-accounts van klanten). Zo blijft het overzicht snel en
// betaal je alleen Meta-calls als je de cijfers echt opvraagt.
router.get('/api/mkt/overview/own-account', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const part = String(req.query.part || 'all');
    const wi = await withReadConnection(async (c) => (await c.query(
      'SELECT * FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
    )).rows[0]) || {};
    const wsToken = decryptSecret(wi.meta_access_token) || null;
    const out = { success: true };

    // ---- Best presterende post (werkplek-Instagram) ----
    if (part === 'post' || part === 'all') {
      out.bestPost = null; out.postConfigured = false;
      const igUser = wi.meta_ig_user_id || null;
      if (wsToken && igUser) {
        out.postConfigured = true;
        try {
          const m = await graphGet(`${igUser}/media`, {
            fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url',
            limit: '12', access_token: wsToken,
          });
          let posts = (m.data || []).map((p) => ({
            id: p.id, caption: (p.caption || '').slice(0, 140), media_type: p.media_type,
            timestamp: p.timestamp, permalink: p.permalink,
            likes: p.like_count ?? 0, comments: p.comments_count ?? 0,
            thumb: p.thumbnail_url || p.media_url || null,
          }));
          const enrich = async (p) => {
            const trySet = async (metric) => {
              const pin = await graphGet(`${p.id}/insights`, { metric, access_token: wsToken });
              (pin.data || []).forEach((row) => {
                const val = (row.total_value && row.total_value.value != null) ? Number(row.total_value.value)
                  : (Array.isArray(row.values) && row.values.length ? Number(row.values[0].value) : null);
                if (val != null) p[row.name] = val;
              });
            };
            try { await trySet('reach,views,saved,shares,total_interactions'); }
            catch (_) { try { await trySet('reach,saved,total_interactions'); } catch (__) { /* basiscijfers blijven */ } }
            if (p.reach != null && p.reach > 0) {
              const inter = (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
              p.engagement = Math.round((inter / p.reach) * 10000) / 100;
            }
          };
          try { await Promise.all(posts.map(enrich)); } catch (_) { /* rapport blijft heel */ }
          const interCount = (p) => (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
          posts.sort((x, y) => {
            const ex = x.engagement != null ? x.engagement : -1;
            const ey = y.engagement != null ? y.engagement : -1;
            if (ey !== ex) return ey - ex;
            return interCount(y) - interCount(x);
          });
          out.bestPost = posts[0] || null;
        } catch (e) { out.postError = e.message; }
      }
    }

    // ---- Actieve campagnes (hele workspace) ----
    if (part === 'campaigns' || part === 'all') {
      out.campaigns = []; out.campaignsConfigured = false;
      // Unieke (token, ad-account)-paren: werkplek-account + eventuele eigen
      // klant-accounts. Zo vragen we een gedeeld account niet dubbel op.
      const pairs = new Map();
      const wsAd = normalizeAdAccount(wi.meta_ad_account_id);
      if (wsToken && wsAd) pairs.set(wsToken + '|' + wsAd, { token: wsToken, adAccount: wsAd, clientName: null });
      const clients = await withReadConnection(async (c) => (await c.query(
        `SELECT cl.id, cl.name, ci.meta_ad_account_id, ci.meta_access_token
           FROM marketing.clients cl
           LEFT JOIN marketing.client_integrations ci ON ci.client_id=cl.id AND ci.workspace_id=cl.workspace_id
          WHERE cl.workspace_id=$1 AND cl.archived=false`, [wsId]
      )).rows);
      for (const cl of clients) {
        const tok = decryptSecret(cl.meta_access_token) || wsToken;
        const ad = normalizeAdAccount(cl.meta_ad_account_id);
        if (tok && ad) { const k = tok + '|' + ad; if (!pairs.has(k)) pairs.set(k, { token: tok, adAccount: ad, clientName: cl.name }); }
      }
      if (pairs.size) out.campaignsConfigured = true;
      // WORKSPACE-ISOLATIE: alleen campagnes tonen die DEZE workspace echt kent
      // (zelf aangemaakt of gekoppeld). Ad-accounts kunnen tussen workspaces
      // gedeeld zijn; zonder deze filter zou je andermans campagnes zien.
      const knownMap = new Map();
      try {
        const knownRows = await withReadConnection(async (c) => (await c.query(
          `SELECT k.meta_campaign_id AS id, cl.name AS client_name
             FROM marketing.campaigns k JOIN marketing.clients cl ON cl.id=k.client_id
            WHERE k.workspace_id=$1 AND k.meta_campaign_id IS NOT NULL
           UNION
           SELECT l.meta_campaign_id AS id, cl.name AS client_name
             FROM marketing.campaign_links l JOIN marketing.clients cl ON cl.id=l.client_id
            WHERE l.workspace_id=$1 AND l.meta_campaign_id IS NOT NULL`,
          [wsId]
        )).rows);
        knownRows.forEach((r) => { if (r.id) knownMap.set(String(r.id), r.client_name || null); });
      } catch (_) { /* zonder bekende campagnes tonen we niets */ }
      if (!knownMap.size) { out.campaigns = []; }
      else {
        const seen = new Set();
        for (const { token, adAccount } of pairs.values()) {
          try {
            const list = await graphGet(`${adAccount}/campaigns`, {
              fields: 'name,objective,status,effective_status,daily_budget,lifetime_budget', limit: '50', access_token: token,
            });
            const active = (list.data || []).filter((c) => String(c.effective_status || c.status).toUpperCase() === 'ACTIVE' && knownMap.has(String(c.id)));
            if (!active.length) continue;
            const stats = {};
            try {
              const ins = await graphGet(`${adAccount}/insights`, {
                level: 'campaign', fields: 'campaign_id,spend,impressions,actions', date_preset: 'last_30d', limit: '200', access_token: token,
              });
              (ins.data || []).forEach((r) => { stats[r.campaign_id] = r; });
            } catch (_) { /* cijfers optioneel */ }
            for (const c of active) {
              if (seen.has(c.id)) continue; seen.add(c.id);
              const s = stats[c.id] || {};
              const budget = c.daily_budget ? (Number(c.daily_budget) / 100) : (c.lifetime_budget ? (Number(c.lifetime_budget) / 100) : null);
              const leads = pickLeadCount(s.actions);
              const spend = s.spend != null ? Number(s.spend) : null;
              out.campaigns.push({
                id: c.id, name: c.name, clientName: knownMap.get(String(c.id)) || null,
                budget, budget_type: c.daily_budget ? 'dag' : (c.lifetime_budget ? 'totaal' : null),
                spend, leads: (leads != null ? leads : null),
                cpl: (leads && spend != null && leads > 0) ? Math.round((spend / leads) * 100) / 100 : null,
              });
            }
          } catch (_) { /* dit account overslaan, rapport blijft heel */ }
        }
      }
    }

    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 9 - META INSIGHTS in de rapportage (organic + ads)
// Defensief: elk onderdeel apart afgeschermd. Faalt een deel, dan blijft
// de rest werken en toont dat onderdeel gewoon geen data.
// =======================================================================
router.get('/api/mkt/clients/:clientId/meta-insights', requireMkt, async (req, res) => {
  try {
    // Klant-account mag de eigen rapportage alleen-lezen inzien; andere klanten geblokkeerd.
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    if (!token) {
      return res.json({ success: true, configured: false });
    }

    const out = { configured: true, account: null, topPosts: null, ads: null, errors: {} };

    // --- Instagram account: volgers + aantal media ---
    if (creds.igUserId) {
      // Meetvenster (Unix) uit de gekozen periode; de frontend stuurt altijd van/tot mee.
      const _okd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const winU = _okd(req.query.until) ? Math.floor(new Date(req.query.until + 'T23:59:59Z').getTime() / 1000) : Math.floor(Date.now() / 1000);
      const winS = _okd(req.query.since) ? Math.floor(new Date(req.query.since + 'T00:00:00Z').getTime() / 1000) : (winU - 30 * 24 * 3600);
      try {
        const a = await graphGet(`${creds.igUserId}`, {
          fields: 'username,followers_count,follows_count,media_count', access_token: token,
        });
        out.account = { username: a.username || null, followers: a.followers_count ?? null, following: a.follows_count ?? null, media: a.media_count ?? null };
      } catch (e) { out.errors.account = e.message; }

      // --- Recente posts. We halen een set recente posts op, verrijken ZE ALLEMAAL
      // met per-post cijfers (weergaven, bereik, opgeslagen, gedeeld) en ranken pas
      // daarna op weergaven. Zo staat de best BEKEKEN post ook echt bovenaan (niet
      // die met toevallig de meeste likes). ---
      let allPosts = [];
      try {
        const m = await graphGet(`${creds.igUserId}/media`, {
          fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count,media_url,thumbnail_url',
          limit: '18', access_token: token,
        });
        allPosts = (m.data || []).map((p) => ({
          id: p.id,
          caption: (p.caption || '').slice(0, 140),
          media_type: p.media_type,
          timestamp: p.timestamp,
          permalink: p.permalink,
          likes: p.like_count ?? 0,
          comments: p.comments_count ?? 0,
          thumb: p.thumbnail_url || p.media_url || null,
        }));
        // Alleen posts binnen de gekozen periode meenemen (ranking + verdeling per periode).
        allPosts = allPosts.filter((p) => { if (!p.timestamp) return true; const ts = Math.floor(new Date(p.timestamp).getTime() / 1000); return ts >= winS && ts <= winU; });
        // Verdeling per contenttype (aantal + interacties), uit alle opgehaalde posts.
        const byType = {};
        for (const p of allPosts) {
          const t = p.media_type || 'ONBEKEND';
          if (!byType[t]) byType[t] = { type: t, count: 0, interactions: 0 };
          byType[t].count += 1;
          byType[t].interactions += (p.likes || 0) + (p.comments || 0);
        }
        out.contentTypes = Object.values(byType).sort((a, b) => b.count - a.count);
      } catch (e) { out.errors.topPosts = e.message; }

      // Per-post cijfers ophalen (Instagram-insights, niet onder de strenge
      // advertentielimiet). Mislukt een post, dan houden we de basiscijfers.
      if (allPosts.length) {
        const enrichPost = async (p) => {
          const trySet = async (metric) => {
            const pin = await graphGet(`${p.id}/insights`, { metric, access_token: token });
            (pin.data || []).forEach((row) => {
              const val = (row.total_value && row.total_value.value != null) ? Number(row.total_value.value)
                : (Array.isArray(row.values) && row.values.length ? Number(row.values[0].value) : null);
              if (val != null) p[row.name] = val;
            });
          };
          try { await trySet('reach,views,saved,shares,total_interactions'); }
          catch (_) { try { await trySet('reach,saved,total_interactions'); } catch (__) { /* basiscijfers blijven */ } }
          try { await trySet('follows'); } catch (_) { /* follows niet beschikbaar */ }
          // Engagement rate volgens de DHC-formule:
          // (likes + reacties + opgeslagen + gedeeld) / bereik * 100.
          if (p.reach != null && p.reach > 0) {
            const inter = (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
            p.engagement = Math.round((inter / p.reach) * 10000) / 100;
          }
        };
        try { await Promise.all(allPosts.map(enrichPost)); } catch (_) { /* rapport blijft heel */ }
        // Ranken op engagement rate (DHC-formule). Posts zonder bereik/engagement
        // komen onderaan; bij gelijke engagement rangschikken we op aantal interacties.
        const interCount = (p) => (p.likes || 0) + (p.comments || 0) + (p.saved || 0) + (p.shares || 0);
        allPosts.sort((x, y) => {
          const ex = x.engagement != null ? x.engagement : -1;
          const ey = y.engagement != null ? y.engagement : -1;
          if (ey !== ex) return ey - ex;
          return interCount(y) - interCount(x);
        });
        out.topPosts = allPosts.slice(0, 10);
      } else {
        out.topPosts = [];
      }

      // --- Accountstatistieken (laatste 28 dagen). Vereist de permissie
      // instagram_manage_insights. Elke metric apart en volledig afgeschermd:
      // mislukt er een, dan slaan we alleen die over (rapport blijft heel).
      out.insights = {};
      const oneMetric = async (key, params) => {
        try {
          const r = await graphGet(`${creds.igUserId}/insights`, { ...params, access_token: token });
          const row = (r.data && r.data[0]) || null;
          if (!row) return;
          if (row.total_value && row.total_value.value != null) {
            out.insights[key] = Number(row.total_value.value);
          } else if (Array.isArray(row.values) && row.values.length) {
            out.insights[key] = row.values.reduce((s, v) => s + (Number(v.value) || 0), 0);
          }
        } catch (e) { if (!out.errors.insights) out.errors.insights = e.message; }
      };
      // Instagram-venster: gekozen periode of de laatste 30 dagen. De total_value
      // metrics MOETEN een venster (since/until) meekrijgen, anders geeft Meta maar
      // 1 dag terug (dat was de bug: 750 i.p.v. ~10.471 weergaven).
      const igU = winU;
      const igS = winS;
      const igWin = { since: String(igS), until: String(igU) };
      out.insights_period = { since: igS, until: igU };
      // Robuust: probeer eerst met tijdvenster (30 dagen / gekozen periode); geeft
      // Meta daar niets op terug, dan vallen we terug op de aanroep zonder venster,
      // zodat de cijfers NOOIT wegvallen. period:'day' moet altijd meegestuurd worden.
      const igMetric = async (key, metric) => {
        await oneMetric(key, { metric, period: 'day', metric_type: 'total_value', ...igWin });
        if (out.insights[key] == null) await oneMetric(key, { metric, period: 'day', metric_type: 'total_value' });
      };
      await oneMetric('reach', { metric: 'reach', period: 'days_28' });
      await igMetric('views', 'views');
      await igMetric('profile_views', 'profile_views');
      await igMetric('accounts_engaged', 'accounts_engaged');
      await igMetric('total_interactions', 'total_interactions');
      // website_clicks (klikken op de link in bio) is een DAGELIJKSE metric die je
      // optelt; niet total_value. Eerst dagelijks over het venster, dan terugval.
      await oneMetric('website_clicks', { metric: 'website_clicks', period: 'day', ...igWin });
      if (out.insights.website_clicks == null) await oneMetric('website_clicks', { metric: 'website_clicks', period: 'day', metric_type: 'total_value', ...igWin });
      const _now = Math.floor(Date.now() / 1000);
      await oneMetric('follower_delta', { metric: 'follower_count', period: 'day', ...igWin });
      if (out.insights.follower_delta == null) await oneMetric('follower_delta', { metric: 'follower_count', period: 'day', since: String(_now - 28 * 24 * 3600), until: String(_now) });

      // NETTO nieuwe volgers via dagelijkse snapshots (eind - begin van de periode).
      // Meta geeft geen ontvolgingen/historisch totaal; daarom slaan we het totaal
      // dagelijks zelf op en berekenen we het netto verschil zodra er historie is.
      try {
        if (out.account && out.account.followers != null && await followerSnapshotsAvailable()) {
          const todayStr = new Date().toISOString().slice(0, 10);
          await withWriteConnection(async (c) => c.query(
            `INSERT INTO marketing.follower_snapshots (workspace_id, client_id, day, followers)
             VALUES ($1,$2,$3,$4) ON CONFLICT (client_id, day) DO UPDATE SET followers=EXCLUDED.followers`,
            [wsId, okClient, todayStr, out.account.followers]
          ));
          const sinceStr = new Date(igS * 1000).toISOString().slice(0, 10);
          const startRow = await withReadConnection(async (c) => (await c.query(
            'SELECT followers FROM marketing.follower_snapshots WHERE client_id=$1 AND day <= $2 ORDER BY day DESC LIMIT 1',
            [okClient, sinceStr]
          )).rows[0]);
          if (startRow && startRow.followers != null) {
            out.insights.follower_net = out.account.followers - startRow.followers;
            out.insights.follower_net_since = sinceStr;
          }
        }
      } catch (_) { /* geen netto beschikbaar */ }

      // Vorige, even lange periode voor de procentuele verandering (best-effort).
      // Alleen voor de venster-metrics, zodat de vergelijking eerlijk is.
      out.insights_prev = {};
      const prevLen = igU - igS;
      const prevWin = { since: String(igS - prevLen), until: String(igS) };
      const igPrev = async (key, metric, isDelta) => {
        try {
          const params = isDelta ? { metric, period: 'day', ...prevWin, access_token: token } : { metric, period: 'day', metric_type: 'total_value', ...prevWin, access_token: token };
          const r = await graphGet(`${creds.igUserId}/insights`, params);
          const row = (r.data && r.data[0]) || null; if (!row) return;
          if (row.total_value && row.total_value.value != null) out.insights_prev[key] = Number(row.total_value.value);
          else if (Array.isArray(row.values) && row.values.length) out.insights_prev[key] = row.values.reduce((s, v) => s + (Number(v.value) || 0), 0);
        } catch (e) { /* vorige periode overslaan */ }
      };
      await igPrev('views', 'views');
      await igPrev('profile_views', 'profile_views');
      await igPrev('accounts_engaged', 'accounts_engaged');
      await igPrev('total_interactions', 'total_interactions');
      await igPrev('website_clicks', 'website_clicks', true);
      await igPrev('follower_delta', 'follower_count', true);

      // Weergaven-splitsingen (best-effort; breakdown-parameters kunnen per
      // Meta-versie verschillen, daarom volledig afgeschermd).
      out.views_split = null;    // volgers vs niet-volgers
      out.views_by_type = null;  // per contenttype (incl. verhalen)
      try {
        const r = await graphGet(`${creds.igUserId}/insights`, { metric: 'views', metric_type: 'total_value', breakdown: 'follow_type', period: 'day', ...igWin, access_token: token });
        const bd = ((((r.data || [])[0] || {}).total_value || {}).breakdowns || [])[0];
        if (bd && Array.isArray(bd.results)) {
          let f = 0; let n = 0;
          bd.results.forEach((x) => { const dv = (x.dimension_values || [])[0]; const v = Number(x.value) || 0; if (dv === 'FOLLOWER') f += v; else if (dv === 'NON_FOLLOWER') n += v; });
          if (f + n > 0) out.views_split = { follower: f, non_follower: n };
        }
      } catch (e) { /* breakdown niet beschikbaar */ }
      try {
        const r = await graphGet(`${creds.igUserId}/insights`, { metric: 'views', metric_type: 'total_value', breakdown: 'media_product_type', period: 'day', ...igWin, access_token: token });
        const bd = ((((r.data || [])[0] || {}).total_value || {}).breakdowns || [])[0];
        if (bd && Array.isArray(bd.results)) {
          const arr = bd.results.map((x) => ({ type: (x.dimension_values || [])[0] || '?', value: Number(x.value) || 0 })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
          if (arr.length) out.views_by_type = arr;
        }
      } catch (e) { /* breakdown niet beschikbaar */ }

      // Dagelijkse reeks over de periode voor de grafiek (weergaven en nieuwe
      // volgers per dag). Afgeschermd; ontbreekt hij, dan gewoon geen grafiek.
      out.series = null;
      try {
        const s = {};
        const daily = async (key, metric) => {
          try {
            const r = await graphGet(`${creds.igUserId}/insights`, { metric, period: 'day', ...igWin, access_token: token });
            const row = (r.data && r.data[0]) || null;
            if (row && Array.isArray(row.values) && row.values.length) s[key] = row.values.map((v) => ({ t: v.end_time || null, v: Number(v.value) || 0 }));
          } catch (e) { /* deze reeks overslaan */ }
        };
        await daily('views', 'views');
        await daily('follower_count', 'follower_count');
        if (Object.keys(s).length) out.series = s;
      } catch (e) { /* geen grafiekdata */ }

      if (!Object.keys(out.insights).length) out.insights = null;

      // Demografie van de volgers (leeftijd, geslacht, stad, land). Meta heeft de
      // oude audience_* metrics uitgefaseerd; we gebruiken nu follower_demographics
      // met breakdowns. Lifetime, vereist instagram_manage_insights en 100+ volgers.
      out.demographics = null;
      try {
        const dg = {};
        const fd = async (breakdown, key, topN) => {
          try {
            const r = await graphGet(`${creds.igUserId}/insights`, {
              metric: 'follower_demographics', period: 'lifetime', timeframe: 'last_30_days',
              breakdown, metric_type: 'total_value', access_token: token,
            });
            const bd = ((((r.data || [])[0] || {}).total_value || {}).breakdowns || [])[0];
            if (bd && Array.isArray(bd.results)) {
              let arr = bd.results.map((x) => ({ label: (x.dimension_values || [])[0] || '?', value: Number(x.value) || 0 })).filter((x) => x.value > 0);
              if (key === 'age') arr.sort((a, b) => String(a.label).localeCompare(String(b.label)));
              else arr.sort((a, b) => b.value - a.value);
              if (arr.length) dg[key] = topN ? arr.slice(0, topN) : arr;
            }
          } catch (e) { /* deze breakdown overslaan */ }
        };
        await fd('age', 'age', 0);
        await fd('gender', 'gender', 0);
        await fd('city', 'city', 6);
        await fd('country', 'country', 6);
        // Terugval op de oude (uitgefaseerde) metrics als follower_demographics niets geeft.
        if (!Object.keys(dg).length) {
          const parseTop = async (metric, key, topN) => {
            try {
              const r = await graphGet(`${creds.igUserId}/insights`, { metric, period: 'lifetime', access_token: token });
              const row = (r.data && r.data[0]) || null;
              const val = row && row.values && row.values[0] && row.values[0].value;
              if (val && typeof val === 'object') {
                const arr = Object.keys(val).map((k) => ({ label: k, value: Number(val[k]) || 0 })).sort((a, b) => b.value - a.value);
                dg[key] = topN ? arr.slice(0, topN) : arr;
              }
            } catch (e) { /* deze breakdown overslaan */ }
          };
          await parseTop('audience_gender_age', 'gender_age', 0);
          await parseTop('audience_country', 'country', 10);
          await parseTop('audience_city', 'city', 10);
        }
        if (Object.keys(dg).length) out.demographics = dg;
      } catch (_) { /* geen demografie beschikbaar */ }

      // Actieve tijden van de volgers (per uur). online_followers geeft per dag een
      // object uur->aantal; we middelen per uur over de periode. Afgeschermd.
      out.activeTimes = null;
      try {
        const r = await graphGet(`${creds.igUserId}/insights`, { metric: 'online_followers', period: 'lifetime', ...igWin, access_token: token });
        const vals = ((r.data || [])[0] || {}).values || [];
        if (vals.length) {
          const sum = {}; const cnt = {};
          vals.forEach((v) => {
            const o = v.value || {};
            Object.keys(o).forEach((h) => { sum[h] = (sum[h] || 0) + (Number(o[h]) || 0); cnt[h] = (cnt[h] || 0) + 1; });
          });
          const hours = Object.keys(sum).map((h) => ({ hour: Number(h), value: Math.round(sum[h] / (cnt[h] || 1)) }));
          if (hours.length) { hours.sort((a, b) => a.hour - b.hour); out.activeTimes = hours; }
        }
      } catch (_) { /* actieve tijden niet beschikbaar */ }
    } else {
      out.errors.account = 'Geen Instagram user ID ingesteld';
    }

    // --- Advertentiecijfers (laatste 30 dagen), alleen campagnes van DEZE klant ---
    if (creds.adAccount) {
      let campIds = [];
      try {
        campIds = await withReadConnection(async (c) => (await c.query(
          `SELECT meta_campaign_id FROM marketing.campaign_links
             WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id IS NOT NULL
           UNION
           SELECT meta_campaign_id FROM marketing.campaigns
             WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id IS NOT NULL`,
          [wsId, okClient]
        )).rows.map((r) => r.meta_campaign_id).filter(Boolean));
      } catch (_) { campIds = []; }

      if (campIds.length) {
        try {
          const ins = await graphGet(`${creds.adAccount}/insights`, {
            level: 'campaign',
            fields: 'spend,impressions,reach,clicks,ctr,unique_ctr,cpc,cpm,frequency,inline_link_clicks,unique_inline_link_clicks,actions',
            ...adsDateSel(req),
            filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
            access_token: token,
          });
          const rows = ins.data || [];
          if (rows.length) {
            let spend = 0; let impressions = 0; let reach = 0; let clicks = 0;
            let linkClicks = 0; let uLinkClicks = 0; let landingViews = 0; let leads = 0;
            let uCtrWeighted = 0; // Terugval: Meta's unieke-CTR (alle klikken), gewogen op vertoningen.
            for (const r of rows) {
              const rowImpr = parseInt(r.impressions || 0, 10) || 0;
              spend += parseFloat(r.spend || 0) || 0;
              impressions += rowImpr;
              reach += parseInt(r.reach || 0, 10) || 0;
              clicks += parseInt(r.clicks || 0, 10) || 0;
              linkClicks += parseInt(r.inline_link_clicks || 0, 10) || 0;
              uLinkClicks += parseInt(r.unique_inline_link_clicks || 0, 10) || 0;
              uCtrWeighted += (parseFloat(r.unique_ctr) || 0) * rowImpr;
              if (Array.isArray(r.actions)) {
                for (const a of r.actions) {
                  if (a && a.action_type === 'landing_page_view') landingViews += Number(a.value) || 0;
                }
              }
              leads += pickLeadCount(r.actions) || 0;
            }
            out.ads = {
              spend: spend.toFixed(2), impressions, reach, clicks,
              link_clicks: linkClicks, landing_page_views: landingViews, leads,
              ctr: impressions ? (clicks / impressions * 100).toFixed(2) : '0.00',
              link_ctr: impressions ? (linkClicks / impressions * 100).toFixed(2) : '0.00',
              // Unieke CTR = unieke LINKklikken / bereik, net als Meta's kolom "Unieke CTR (koppeling)".
              // Niet Meta's unique_ctr (alle klikken), want dat telt ook reacties, profielklikken en uitklappen mee en staat te hoog.
              unique_ctr: reach ? (uLinkClicks / reach * 100).toFixed(2) : (impressions ? (uCtrWeighted / impressions).toFixed(2) : null),
              cpc: linkClicks ? (spend / linkClicks).toFixed(2) : (clicks ? (spend / clicks).toFixed(2) : null),
              cpm: impressions ? (spend / impressions * 1000).toFixed(2) : '0.00',
              frequency: reach ? (impressions / reach).toFixed(2) : null,
              click_to_lp: linkClicks ? (landingViews / linkClicks * 100).toFixed(0) : null,
              lp_to_lead: landingViews ? (leads / landingViews * 100).toFixed(2) : null,
              cost_per_lead: leads > 0 ? (spend / leads).toFixed(2) : null,
            };
          } else {
            out.ads = { empty: true };
          }
        } catch (e) { out.errors.ads = e.message; }

        // Verdieping: campagnes -> ad sets -> advertenties, met resultaten (leads)
        // en kosten per lead. Insights-reads vallen niet onder de strenge
        // advertentielimiet; per niveau afgeschermd zodat een fout het rapport heel laat.
        try {
          const leadFromActions = pickLeadCount;
          const metricsOf = (r) => {
            const spend = parseFloat(r.spend || 0) || 0;
            const impressions = parseInt(r.impressions || 0, 10) || 0;
            const clicks = parseInt(r.clicks || 0, 10) || 0;
            const results = leadFromActions(r.actions);
            return {
              spend: spend.toFixed(2), impressions, reach: parseInt(r.reach || 0, 10) || 0, clicks,
              ctr: r.ctr != null ? Number(r.ctr).toFixed(2) : (impressions ? (clicks / impressions * 100).toFixed(2) : '0.00'),
              cpc: r.cpc != null ? Number(r.cpc).toFixed(2) : (clicks ? (spend / clicks).toFixed(2) : '0.00'),
              results,
              cost_per_result: (results && results > 0) ? (spend / results).toFixed(2) : null,
            };
          };
          const common = { ...adsDateSel(req), filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]), access_token: token };
          // Prestaties per niveau (alleen entiteiten met data in de periode).
          const adsetR = await graphGet(`${creds.adAccount}/insights`, { level: 'adset', fields: 'campaign_id,adset_id,spend,impressions,reach,clicks,ctr,cpc,actions', ...common });
          const adR = await graphGet(`${creds.adAccount}/insights`, { level: 'ad', fields: 'adset_id,ad_id,spend,impressions,reach,clicks,ctr,actions', ...common });
          // Entiteiten met live-status (ook zonder uitgaven), zodat zichtbaar is wat live staat.
          const adsetsList = await graphGet(`${creds.adAccount}/adsets`, { fields: 'id,name,effective_status,campaign_id,start_time', limit: '500', filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]), access_token: token });
          const adsList = await graphGet(`${creds.adAccount}/ads`, { fields: 'id,name,effective_status,adset_id', limit: '500', filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]), access_token: token });
          const adsetMx = {}; (adsetR.data || []).forEach((r) => { adsetMx[r.adset_id] = metricsOf(r); });
          const adMx = {}; (adR.data || []).forEach((r) => { adMx[r.ad_id] = metricsOf(r); });
          const camps = {};
          campIds.forEach((id) => { camps[id] = { id, adsets: {} }; });
          (adsetsList.data || []).forEach((s) => { const c = camps[s.campaign_id]; if (!c) return; c.adsets[s.id] = { id: s.id, name: s.name, status: s.effective_status || null, live: s.effective_status === 'ACTIVE', start_time: s.start_time || null, ...(adsetMx[s.id] || {}), ads: [] }; });
          (adsList.data || []).forEach((a) => { for (const cid in camps) { const s = camps[cid].adsets[a.adset_id]; if (s) { s.ads.push({ id: a.id, name: a.name, status: a.effective_status || null, live: a.effective_status === 'ACTIVE', ...(adMx[a.id] || {}) }); break; } } });
          // Campagne-totalen: som van de ad sets.
          const sumUp = (list) => {
            let spend = 0; let impressions = 0; let reach = 0; let clicks = 0; let results = 0; let anyRes = false;
            list.forEach((x) => { spend += parseFloat(x.spend || 0) || 0; impressions += x.impressions || 0; reach += x.reach || 0; clicks += x.clicks || 0; if (x.results != null) { results += x.results; anyRes = true; } });
            return { spend: spend.toFixed(2), impressions, reach, clicks, ctr: impressions ? (clicks / impressions * 100).toFixed(2) : '0.00', results: anyRes ? results : null, cost_per_result: (anyRes && results > 0) ? (spend / results).toFixed(2) : null };
          };
          const nowMs = Date.now();
          const tree = Object.values(camps).map((c) => {
            const adsets = Object.values(c.adsets);
            // Gepland = alle ad sets hebben een starttijd in de toekomst (nog niet begonnen).
            const futureStarts = adsets.map((s) => (s.start_time ? new Date(s.start_time).getTime() : null)).filter((t) => t != null);
            const scheduled = adsets.length > 0 && futureStarts.length === adsets.length && futureStarts.every((t) => t > nowMs);
            const scheduledStart = scheduled && futureStarts.length ? new Date(Math.min.apply(null, futureStarts)).toISOString() : null;
            return { id: c.id, ...sumUp(adsets), live_adsets: adsets.filter((s) => s.live).length, scheduled, scheduled_start: scheduledStart, adsets };
          });
          if (tree.length) {
            out.adTree = tree;
            // Totaal aantal leads over alle campagnes, voor de samenvatting.
            let totRes = 0; let anyRes = false;
            tree.forEach((c) => { if (c.results != null) { totRes += c.results; anyRes = true; } });
            if (anyRes && out.ads && !out.ads.empty) {
              out.ads.results = totRes;
              out.ads.cost_per_result = totRes > 0 ? (parseFloat(out.ads.spend) / totRes).toFixed(2) : null;
            }
          }
        } catch (e) { out.errors.adtree = e.message; }
      } else {
        out.ads = { empty: true };
      }
    }

    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detailstatistieken van één Instagram-post (op aanvraag, als je een post opent).
// Vereist instagram_manage_insights; ontbreekt die, dan geven we permissionMissing
// terug en toont de app alleen likes/reacties.
router.get('/api/mkt/clients/:clientId/media/:mediaId/insights', requireMkt, async (req, res) => {
  try {
    // Klant-account mag de eigen post-cijfers alleen-lezen inzien; andere klanten geblokkeerd.
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const creds = await resolveClientMeta(wsId, okClient);
    if (!creds.token) return res.status(400).json({ error: 'Geen Meta-koppeling' });
    const mediaId = String(req.params.mediaId || '').replace(/[^0-9_]/g, '');
    if (!mediaId) return res.status(400).json({ error: 'Ongeldige media-id' });

    const stats = {};
    let permissionMissing = false;
    const oneMetric = async (key, metric) => {
      try {
        const r = await graphGet(`${mediaId}/insights`, { metric, access_token: creds.token });
        const row = (r.data && r.data[0]) || null;
        if (!row) return;
        if (row.total_value && row.total_value.value != null) stats[key] = Number(row.total_value.value);
        else if (Array.isArray(row.values) && row.values.length) stats[key] = Number(row.values[0].value);
      } catch (e) { if (/permission|#?10\b/i.test(String(e.message))) permissionMissing = true; }
    };
    await oneMetric('reach', 'reach');
    await oneMetric('views', 'views');
    await oneMetric('total_interactions', 'total_interactions');
    await oneMetric('saved', 'saved');
    await oneMetric('shares', 'shares');
    res.json({ success: true, stats, permissionMissing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 11 - KLANT-LOGIN (klant ziet eigen content, keurt goed, laat notitie na)
// =======================================================================

// Marketeer maakt een klant-login aan voor een specifieke klant.
router.post('/api/mkt/clients/:clientId/login', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager kan een klant-login aanmaken' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const { email, password, full_name } = req.body || {};
    const em = String(email || '').toLowerCase().trim();
    if (!em || !em.includes('@')) return res.status(400).json({ error: 'Geldig e-mailadres verplicht' });

    // Bestaat dit e-mailadres al ergens?
    const existing = await withReadConnection(async (c) => (await c.query(
      'SELECT workspace_id, password_hash, full_name FROM marketing.accounts WHERE email=$1', [em]
    )).rows);
    if (existing.some((a) => String(a.workspace_id) === String(wsId))) {
      return res.status(409).json({ error: 'Er bestaat al een account met dit e-mailadres in deze workspace' });
    }

    let hash; let fname;
    if (existing.length) {
      // Bestaat al in een andere workspace: dezelfde login hergebruiken (gedeeld
      // wachtwoord). Er wordt dan geen nieuw wachtwoord gevraagd/gebruikt.
      hash = existing[0].password_hash;
      fname = (full_name && String(full_name).trim()) || existing[0].full_name || null;
    } else {
      // Nieuw e-mailadres: wachtwoord verplicht.
      if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Wachtwoord: min. 8 tekens, hoofd- en kleine letter en een cijfer' });
      }
      hash = await bcrypt.hash(password, SALT_ROUNDS);
      fname = (full_name && String(full_name).trim()) || null;
    }

    let row;
    try {
      row = await withWriteConnection(async (c) => (await c.query(
        `INSERT INTO marketing.accounts (workspace_id, email, password_hash, full_name, role, client_id, active)
         VALUES ($1,$2,$3,$4,'client',$5,true)
         RETURNING id, email, full_name, role`,
        [wsId, em, hash, fname, okClient]
      )).rows[0]);
    } catch (e) {
      // Bestaat de globale unieke e-mail-index nog (migratie 005 niet gedraaid)?
      if (/duplicate key|unique/i.test(String(e.message))) {
        return res.status(409).json({ error: 'Dit e-mailadres bestaat al in een andere workspace. Voer eerst migratie 005 uit om dezelfde login in meerdere workspaces toe te staan.' });
      }
      throw e;
    }
    res.json({ success: true, account: row, sharedLogin: existing.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Klant keurt een eigen post goed of vraagt wijzigingen (ingelogd).
router.post('/api/mkt/posts/:id/client-decision', requireMkt, async (req, res) => {
  try {
    if (!mktClientLocked(req)) return res.status(403).json({ error: 'Alleen een klant-account' });
    const { decision, note } = req.body || {};
    if (decision !== 'approved' && decision !== 'changes') return res.status(400).json({ error: 'Ongeldige keuze' });
    const wsId = req.session.mkt.workspaceId;
    const cid = mktLockedClientId(req);
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_posts
          SET approval=$1, approval_note=$2, approval_at=now(), updated_at=now()
        WHERE id=$3 AND workspace_id=$4 AND client_id=$5 AND approval <> 'none'
       RETURNING id, approval, approval_note`,
      [decision, (note && String(note).trim().slice(0, 1000)) || null, req.params.id, wsId, cid]
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Klant laat een vrije notitie achter bij een eigen post.
router.post('/api/mkt/posts/:id/client-note', requireMkt, async (req, res) => {
  try {
    if (!mktClientLocked(req)) return res.status(403).json({ error: 'Alleen een klant-account' });
    const wsId = req.session.mkt.workspaceId;
    const cid = mktLockedClientId(req);
    const note = (req.body && req.body.note != null) ? String(req.body.note).trim().slice(0, 1000) : '';
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_posts SET client_note=$1, updated_at=now()
        WHERE id=$2 AND workspace_id=$3 AND client_id=$4
       RETURNING id, client_note`,
      [note || null, req.params.id, wsId, cid]
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 12 - PLANNER: automatisch posten op het geplande tijdstip
// Draait in de server, elke minuut. Alleen posts met auto_publish=true en
// een verstreken scheduled_at worden gepubliceerd. Attempt-limiet + lock.
// =======================================================================
let schedulerBusy = false;
async function runScheduler() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const due = await withReadConnection(async (c) => (await c.query(
      `SELECT p.id, p.workspace_id, p.client_id, p.title, p.body, p.publish_channel,
              a.url AS asset_url, a.resource_type AS asset_type, a.provider AS asset_provider,
              i.meta_access_token, i.meta_ig_user_id, i.meta_page_id
         FROM marketing.content_posts p
         LEFT JOIN marketing.assets a ON a.id = p.asset_id
         LEFT JOIN marketing.client_integrations i ON i.client_id = p.client_id
        WHERE p.auto_publish = true AND p.published_at IS NULL
          AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= now()
          AND p.publish_attempts < 5
        ORDER BY p.scheduled_at ASC
        LIMIT 5`
    )).rows);

    for (const post of due) {
      // Direct de poging tellen zodat een mislukking niet oneindig herhaalt.
      await withWriteConnection(async (c) => c.query(
        'UPDATE marketing.content_posts SET publish_attempts = publish_attempts + 1 WHERE id=$1', [post.id]
      ));
      try {
        const channel = (post.publish_channel === 'facebook') ? 'facebook' : 'instagram';
        // Client-koppeling met terugval op de workspace-koppeling.
        const creds = await resolveClientMeta(post.workspace_id, post.client_id);
        const token = creds.token;
        if (!token) throw new Error('Geen Meta access token in de koppelingen');
        let mediaUrl = null, mediaType = 'image';
        if (post.asset_url && post.asset_provider === 'cloudinary') {
          mediaUrl = post.asset_url;
          mediaType = post.asset_type === 'video' ? 'video' : 'image';
        }
        const caption = post.body || post.title || '';
        await publishToMeta({ meta_ig_user_id: creds.igUserId, meta_page_id: creds.pageId }, token, channel, mediaUrl, mediaType, caption);
        await withWriteConnection(async (c) => c.query(
          `UPDATE marketing.content_posts SET published_at=now(), status='published', publish_error=NULL, updated_at=now() WHERE id=$1`, [post.id]
        ));
      } catch (e) {
        const ch = (post.publish_channel === 'facebook') ? 'facebook' : 'instagram';
        await withWriteConnection(async (c) => c.query(
          `UPDATE marketing.content_posts SET publish_error=$1, updated_at=now() WHERE id=$2`, [friendlyPublishError(e.message, ch).slice(0, 500), post.id]
        ));
      }
    }
    try { await runAssetRetentionIfDue(); } catch (_) { /* opruimen niet kritisch */ }
    try { await runFollowerSnapshotsIfDue(); } catch (_) { /* snapshots niet kritisch */ }
  } catch (_) { /* infrafout: volgende minuut opnieuw */ }
  finally { schedulerBusy = false; }
}

// Slaat hooguit eens per 24 uur het totale volgersaantal op voor elke klant met
// een Instagram-koppeling. Zo bouwen we automatisch dag-historie op voor NETTO
// nieuwe volgers, ook als niemand de rapportage opent. Eén lichte API-call per
// klant per dag (accountcijfers, ruime limiet, geen advertentielimiet).
async function runFollowerSnapshotsIfDue() {
  const now = Date.now();
  if (global.__mktLastFollowerSnap && (now - global.__mktLastFollowerSnap) < 24 * 60 * 60 * 1000) return;
  if (!(await followerSnapshotsAvailable())) return;
  global.__mktLastFollowerSnap = now;
  let clients = [];
  try {
    clients = await withReadConnection(async (c) => (await c.query(
      'SELECT id, workspace_id FROM marketing.clients ORDER BY id'
    )).rows);
  } catch (_) { return; }
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const cl of clients) {
    try {
      const creds = await resolveClientMeta(cl.workspace_id, cl.id);
      if (!creds.token || !creds.igUserId) continue;
      const a = await graphGet(`${creds.igUserId}`, { fields: 'followers_count', access_token: creds.token });
      if (a && a.followers_count != null) {
        await withWriteConnection(async (c) => c.query(
          `INSERT INTO marketing.follower_snapshots (workspace_id, client_id, day, followers)
           VALUES ($1,$2,$3,$4) ON CONFLICT (client_id, day) DO UPDATE SET followers=EXCLUDED.followers`,
          [cl.workspace_id, cl.id, todayStr, a.followers_count]
        ));
      }
      await sleepMs(300); // rustig aan, ruim binnen de limieten
    } catch (_) { /* deze klant overslaan */ }
  }
}

// Ruimt hooguit eens per 24 uur assets op die ouder zijn dan de bewaartermijn
// van hun werkplek (standaard 60 dagen) EN nergens meer aan gekoppeld zijn
// (geen post, geen campagne). Deploy-veilig: valt terug op 60 dagen als de
// kolom retention_days nog niet bestaat.
async function runAssetRetentionIfDue() {
  const now = Date.now();
  if (global.__mktLastRetention && (now - global.__mktLastRetention) < 24 * 60 * 60 * 1000) return;
  global.__mktLastRetention = now;
  const cond = `a.created_at < now() - (COALESCE(w.retention_days, 60) || ' days')::interval
     AND NOT EXISTS (SELECT 1 FROM marketing.content_posts p WHERE p.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM marketing.campaigns k WHERE k.asset_id = a.id)`;
  // Kandidaten ophalen (met join op retention_days; terugval op vaste 60 dagen als de kolom er nog niet is).
  let rows = [];
  try {
    rows = await withReadConnection(async (c) => (await c.query(
      `SELECT a.id, a.provider, a.public_id, a.resource_type
         FROM marketing.assets a JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE ${cond} LIMIT 200`
    )).rows);
  } catch (_) {
    try {
      rows = await withReadConnection(async (c) => (await c.query(
        `SELECT a.id, a.provider, a.public_id, a.resource_type
           FROM marketing.assets a
          WHERE a.created_at < now() - ($1 || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM marketing.content_posts p WHERE p.asset_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM marketing.campaigns k WHERE k.asset_id = a.id)
          LIMIT 200`, ['60']
      )).rows);
    } catch (_) { rows = []; }
  }
  if (!rows.length) return;
  // Eerst de echte bestanden bij Cloudinary opruimen, dan pas de databaserijen.
  for (const a of rows) {
    if (a.provider === 'cloudinary' && a.public_id) {
      try { await cloudinaryDestroy(a.public_id, a.resource_type); } catch (_) { /* best-effort */ }
    }
  }
  const ids = rows.map((r) => r.id);
  try {
    await withWriteConnection(async (c) => c.query('DELETE FROM marketing.assets WHERE id = ANY($1::bigint[])', [ids]));
  } catch (_) { /* volgende keer opnieuw */ }
}
// Start de planner (eenmalig per proces). Eerste run na 20s, daarna elke 60s.
if (!global.__mktScheduler) {
  global.__mktScheduler = setInterval(runScheduler, 60 * 1000);
  setTimeout(runScheduler, 20 * 1000);
}

// =======================================================================
// STAP 14 - CAMPAGNES BEHEREN op Meta (pauzeren/activeren + budget)
// Hergebruikt het opgeslagen token. Vereist ads_management in het token.
// =======================================================================
async function metaTokenForClient(wsId, clientId) {
  const creds = await resolveClientMeta(wsId, clientId);
  return creds.token;
}

// Campagne pauzeren of activeren.
router.post('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/status', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = (req.body && req.body.status === 'ACTIVE') ? 'ACTIVE' : (req.body && req.body.status === 'PAUSED') ? 'PAUSED' : null;
    if (!status) return res.status(400).json({ error: 'Kies pauzeren of activeren' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.campaignId}`, { status, access_token: token });
    res.json({ success: true, status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Dagbudget van een campagne aanpassen (op alle advertentiesets eronder).
router.post('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/budget', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const euros = Number(req.body && req.body.daily);
    if (!Number.isFinite(euros) || euros < 1) return res.status(400).json({ error: 'Vul een dagbudget in van minimaal 1 euro' });
    const cents = String(Math.round(euros * 100));
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const sets = await graphGet(`${req.params.campaignId}/adsets`, { fields: 'id', limit: '50', access_token: token });
    const ids = (sets.data || []).map((s) => s.id);
    if (!ids.length) return res.status(400).json({ error: 'Deze campagne heeft geen advertentiesets om het budget op te zetten' });
    let done = 0;
    for (const id of ids) { try { await graphPost(`${id}`, { daily_budget: cents, access_token: token }); done++; } catch (_) { /* ga door */ } }
    if (!done) return res.status(400).json({ error: 'Budget aanpassen is niet gelukt (mogelijk CBO of geen rechten)' });
    res.json({ success: true, updated: done });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Naam van een campagne aanpassen (bij Meta en in onze eigen database).
router.post('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/rename', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const name = String((req.body && req.body.name) || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Vul een campagnenaam in' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.campaignId}`, { name, access_token: token });
    // Eigen database bijwerken (best effort: alleen als deze campagne van ons is).
    try {
      await withWriteConnection(async (c) => c.query(
        'UPDATE marketing.campaigns SET name=$1 WHERE meta_campaign_id=$2 AND workspace_id=$3 AND client_id=$4',
        [name, req.params.campaignId, wsId, okClient]
      ));
    } catch (_) { /* database-update niet kritiek */ }
    res.json({ success: true, name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// STAP 17 - CAMPAGNE-DETAIL: advertentiesets + advertenties beheren
// =======================================================================
// Detail van een campagne: ad sets met hun advertenties.
router.get('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/detail', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const cid = req.params.campaignId;
    const setsRes = await graphGet(`${cid}/adsets`, {
      fields: 'name,effective_status,daily_budget,optimization_goal,billing_event', limit: '50', access_token: token,
    });
    const adsRes = await graphGet(`${cid}/ads`, {
      fields: 'name,effective_status,adset_id,created_time', limit: '100', access_token: token,
    });
    const adsBySet = {};
    const adById = {};
    (adsRes.data || []).forEach((a) => {
      const adObj = { id: a.id, name: a.name, status: a.effective_status, created_time: a.created_time || null, stats: null };
      adById[a.id] = adObj;
      (adsBySet[a.adset_id] = adsBySet[a.adset_id] || []).push(adObj);
    });
    // Resultaten per advertentieset (hele looptijd), defensief opgehaald.
    const statsBySet = {};
    try {
      const si = await graphGet(`${cid}/insights`, {
        level: 'adset', fields: 'adset_id,spend,impressions,reach,clicks,ctr,cpc',
        date_preset: 'maximum', limit: '100', access_token: token,
      });
      (si.data || []).forEach((r) => {
        statsBySet[r.adset_id] = {
          spend: r.spend ?? null, impressions: r.impressions ?? null, reach: r.reach ?? null,
          clicks: r.clicks ?? null, ctr: r.ctr ?? null, cpc: r.cpc ?? null,
        };
      });
    } catch (_) { /* geen cijfers beschikbaar */ }

    // Publieksverdeling (leeftijd/geslacht) per advertentieset, hele looptijd.
    const audienceBySet = {};
    try {
      const ai = await graphGet(`${cid}/insights`, {
        level: 'adset', fields: 'adset_id,impressions,clicks,spend', breakdowns: 'age,gender',
        date_preset: 'maximum', limit: '500', access_token: token,
      });
      (ai.data || []).forEach((r) => {
        if (!r.adset_id) return;
        (audienceBySet[r.adset_id] = audienceBySet[r.adset_id] || []).push({
          age: r.age, gender: r.gender, impressions: r.impressions ?? null, clicks: r.clicks ?? null, spend: r.spend ?? null,
        });
      });
    } catch (_) { /* geen verdeling beschikbaar */ }

    // Resultaten per advertentie (hele looptijd). Attributie 7 dagen klik + 1 dag
    // weergave, zodat leads overeenkomen met hoe wij de campagnes beoordelen.
    try {
      const adi = await graphGet(`${cid}/insights`, {
        level: 'ad',
        fields: 'ad_id,spend,impressions,reach,inline_link_clicks,unique_inline_link_clicks,actions',
        action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
        date_preset: 'maximum', limit: '200', access_token: token,
      });
      (adi.data || []).forEach((r) => {
        const adObj = adById[r.ad_id];
        if (!adObj) return;
        const spend = parseFloat(r.spend || 0) || 0;
        const reach = parseInt(r.reach || 0, 10) || 0;
        const linkClicks = parseInt(r.inline_link_clicks || 0, 10) || 0;
        const uLinkClicks = parseInt(r.unique_inline_link_clicks || 0, 10) || 0;
        let landingViews = 0;
        if (Array.isArray(r.actions)) {
          for (const a of r.actions) { if (a && a.action_type === 'landing_page_view') landingViews += Number(a.value) || 0; }
        }
        const leads = pickLeadCount(r.actions) || 0;
        adObj.stats = {
          spend: spend.toFixed(2),
          link_clicks: linkClicks,
          unique_ctr: reach ? (uLinkClicks / reach * 100).toFixed(2) : null,
          cpc: linkClicks ? (spend / linkClicks).toFixed(2) : null,
          landing_page_views: landingViews,
          leads,
          cost_per_lead: leads > 0 ? (spend / leads).toFixed(2) : null,
        };
      });
    } catch (_) { /* geen cijfers per advertentie beschikbaar */ }

    const adsets = (setsRes.data || []).map((s) => ({
      id: s.id, name: s.name, status: s.effective_status,
      budget: s.daily_budget ? (Number(s.daily_budget) / 100) : null,
      optimization_goal: s.optimization_goal || null,
      ads: adsBySet[s.id] || [],
      stats: statsBySet[s.id] || null,
      audience: audienceBySet[s.id] || null,
    }));

    // Campagnetotaal (hele looptijd), defensief.
    let totals = null;
    try {
      const ti = await graphGet(`${cid}/insights`, {
        fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm', date_preset: 'maximum', access_token: token,
      });
      const row = (ti.data && ti.data[0]) || null;
      totals = row ? {
        spend: row.spend ?? null, impressions: row.impressions ?? null, reach: row.reach ?? null,
        clicks: row.clicks ?? null, ctr: row.ctr ?? null, cpc: row.cpc ?? null, cpm: row.cpm ?? null,
      } : null;
    } catch (_) { totals = null; }

    res.json({ success: true, adsets, totals });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Advertentieset pauzeren/activeren.
router.post('/api/mkt/clients/:clientId/meta-adsets/:adsetId/status', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = (req.body && (req.body.status === 'ACTIVE' || req.body.status === 'PAUSED')) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Kies pauzeren of activeren' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.adsetId}`, { status, access_token: token });
    res.json({ success: true, status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Advertentieset-budget aanpassen.
router.post('/api/mkt/clients/:clientId/meta-adsets/:adsetId/budget', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const euros = Number(req.body && req.body.daily);
    if (!Number.isFinite(euros) || euros < 1) return res.status(400).json({ error: 'Vul een dagbudget in van minimaal 1 euro' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.adsetId}`, { daily_budget: String(Math.round(euros * 100)), access_token: token });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Advertentie pauzeren/activeren.
router.post('/api/mkt/clients/:clientId/meta-ads/:adId/status', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = (req.body && (req.body.status === 'ACTIVE' || req.body.status === 'PAUSED')) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Kies pauzeren of activeren' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.adId}`, { status, access_token: token });
    res.json({ success: true, status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Advertentie verwijderen.
router.delete('/api/mkt/clients/:clientId/meta-ads/:adId', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const body = new URLSearchParams({ access_token: token });
    const r = await fetch(`${GRAPH}/${req.params.adId}`, { method: 'DELETE', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error ? j.error.message : 'Verwijderen mislukt');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Naam van een advertentie aanpassen (bij Meta).
router.post('/api/mkt/clients/:clientId/meta-ads/:adId/rename', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const name = String((req.body && req.body.name) || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Vul een advertentienaam in' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    await graphPost(`${req.params.adId}`, { name, access_token: token });
    res.json({ success: true, name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Haalt de huidige inhoud (Kop, tekst, CTA, link, beeldtype) van een advertentie op.
function parseStorySpec(spec) {
  if (!spec) return null;
  if (spec.video_data) {
    const v = spec.video_data;
    return {
      mediaType: 'video',
      headline: v.title || '',
      caption: v.message || '',
      cta: (v.call_to_action && v.call_to_action.type) || 'LEARN_MORE',
      link: (v.call_to_action && v.call_to_action.value && v.call_to_action.value.link) || '',
      thumb: v.image_url || null,
    };
  }
  if (spec.link_data) {
    const l = spec.link_data;
    return {
      mediaType: 'image',
      headline: l.name || '',
      caption: l.message || '',
      cta: (l.call_to_action && l.call_to_action.type) || 'LEARN_MORE',
      link: l.link || (l.call_to_action && l.call_to_action.value && l.call_to_action.value.link) || '',
      thumb: l.picture || null,
    };
  }
  return null;
}

// Leest de inhoud van een flexibele creative (asset_feed_spec) uit, zodat de
// workspace ook voor advertenties met meerdere teksten de Kop/tekst/CTA/link toont.
// Bij een flexibele creative staat de inhoud niet in object_story_spec maar hierin.
function parseAssetFeed(afs) {
  if (!afs) return null;
  const bodies = Array.isArray(afs.bodies) ? afs.bodies.map((x) => (x && x.text) || '').filter(Boolean) : [];
  const titles = Array.isArray(afs.titles) ? afs.titles.map((x) => (x && x.text) || '').filter(Boolean) : [];
  const ctas = Array.isArray(afs.call_to_action_types) ? afs.call_to_action_types : [];
  const links = Array.isArray(afs.link_urls) ? afs.link_urls : [];
  const isVideo = Array.isArray(afs.videos) && afs.videos.length > 0;
  let thumb = null;
  if (isVideo) thumb = (afs.videos[0] && afs.videos[0].thumbnail_url) || null;
  else if (Array.isArray(afs.images) && afs.images[0]) thumb = afs.images[0].url || null;
  if (!bodies.length && !titles.length && !isVideo && !(Array.isArray(afs.images) && afs.images.length)) return null;
  return {
    mediaType: isVideo ? 'video' : 'image',
    headline: titles[0] || '',
    caption: bodies[0] || '',
    captions: bodies,
    cta: ctas[0] || 'LEARN_MORE',
    link: (links[0] && links[0].website_url) || '',
    thumb,
    flexible: true,
  };
}

router.get('/api/mkt/clients/:clientId/meta-ads/:adId/creative', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const ad = await graphGet(`${req.params.adId}`, { fields: 'name,creative{object_story_spec,asset_feed_spec}', access_token: token });
    const spec = ad.creative && ad.creative.object_story_spec;
    // Flexibele creatives (meerdere teksten) hebben hun inhoud in asset_feed_spec; die
    // heeft voorrang. Oudere flexibele ads hebben in object_story_spec nog een lege
    // link_data-anker, dus zonder deze voorrang zou de workspace die leeg tonen.
    const creative = parseAssetFeed(ad.creative && ad.creative.asset_feed_spec) || parseStorySpec(spec);
    if (!creative) return res.status(400).json({ error: 'Kan de inhoud van deze advertentie niet ophalen (mogelijk niet via de workspace gemaakt).' });
    res.json({ success: true, name: ad.name || '', creative });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Past de inhoud van een advertentie aan: bouwt een nieuwe creative met de
// nieuwe Kop/tekst/CTA/link maar hetzelfde beeld, en zet die op de advertentie.
router.post('/api/mkt/clients/:clientId/meta-ads/:adId/creative', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    const adAccount = creds.adAccount;
    if (!token) return res.status(400).json({ error: 'Meta access token ontbreekt' });
    if (!adAccount) return res.status(400).json({ error: 'Ad Account ID ontbreekt' });

    const ad = await graphGet(`${req.params.adId}`, { fields: 'name,creative{object_story_spec,asset_feed_spec}', access_token: token });
    const spec = ad.creative && ad.creative.object_story_spec;
    const afsOld = ad.creative && ad.creative.asset_feed_spec;
    const hasStory = spec && (spec.video_data || spec.link_data);
    const hasFlex = afsOld && (Array.isArray(afsOld.videos) || Array.isArray(afsOld.images) || Array.isArray(afsOld.bodies));
    if (!hasStory && !hasFlex) {
      return res.status(400).json({ error: 'Kan de inhoud van deze advertentie niet ophalen om aan te passen.' });
    }
    const b = req.body || {};
    const headline = (b.headline != null) ? String(b.headline).slice(0, 255) : undefined;
    const caption = (b.caption != null) ? String(b.caption).slice(0, 2000) : undefined;
    const cta = CTA_TYPES.includes(b.cta) ? b.cta : undefined;
    const link = (b.link && /^https?:\/\//i.test(String(b.link))) ? String(b.link).trim() : undefined;

    // Flexibele advertentie (meerdere teksten): de inhoud zit in asset_feed_spec. Die
    // heeft voorrang, ook als er nog een leeg link_data-anker in object_story_spec staat
    // (oudere ads). We bouwen de asset_feed_spec opnieuw op met de nieuwe Kop/tekst/CTA/
    // link en hetzelfde beeld. De eerste tekst wordt aangepast; extra teksten blijven.
    if (hasFlex) {
      const pageId = (spec && spec.page_id) || creds.pageId;
      const isVideo = Array.isArray(afsOld.videos) && afsOld.videos.length > 0;
      const head = (headline !== undefined ? (headline || DEFAULT_AD_HEADLINE)
        : ((Array.isArray(afsOld.titles) && afsOld.titles[0] && afsOld.titles[0].text) || DEFAULT_AD_HEADLINE));
      const newLink = (link !== undefined) ? link
        : ((Array.isArray(afsOld.link_urls) && afsOld.link_urls[0] && afsOld.link_urls[0].website_url) || '');
      const newCta = (cta !== undefined) ? cta
        : ((Array.isArray(afsOld.call_to_action_types) && afsOld.call_to_action_types[0]) || 'LEARN_MORE');
      let bodies = Array.isArray(afsOld.bodies) ? afsOld.bodies.map((x) => ({ text: (x && x.text) || '' })).filter((x) => x.text) : [];
      if (caption !== undefined) bodies = bodies.length ? [{ text: caption }, ...bodies.slice(1)] : [{ text: caption }];
      if (!bodies.length) bodies = [{ text: '' }];
      const newAfs = {
        optimization_type: afsOld.optimization_type || 'DEGREES_OF_FREEDOM',
        ad_formats: afsOld.ad_formats || [isVideo ? 'SINGLE_VIDEO' : 'AUTOMATIC_FORMAT'],
        bodies,
        titles: [{ text: head }],
        call_to_action_types: [newCta],
      };
      if (newLink) newAfs.link_urls = [{ website_url: newLink }];
      if (isVideo) newAfs.videos = afsOld.videos.filter((v) => v && v.video_id).map((v) => ({ video_id: v.video_id, thumbnail_url: v.thumbnail_url }));
      else if (Array.isArray(afsOld.images)) newAfs.images = afsOld.images.filter((im) => im && im.hash).map((im) => ({ hash: im.hash }));
      const firstVid = (newAfs.videos && newAfs.videos[0]) || null;
      const firstImg = (newAfs.images && newAfs.images[0]) || null;
      // Terugval op een enkele-tekst creative als Meta het flexibele formaat weigert.
      const fb = isVideo
        ? JSON.stringify({ page_id: pageId, video_data: { video_id: firstVid && firstVid.video_id, message: bodies[0].text, image_url: firstVid && firstVid.thumbnail_url, call_to_action: { type: newCta, value: { link: newLink } }, title: head } })
        : JSON.stringify({ page_id: pageId, link_data: { message: bodies[0].text, link: newLink, image_hash: firstImg && firstImg.hash, call_to_action: { type: newCta, value: { link: newLink } }, name: head } });
      const built = { primary: { object_story_spec: JSON.stringify({ page_id: pageId }), asset_feed_spec: JSON.stringify(newAfs) }, fallback: { object_story_spec: fb } };
      const creativeF = await createAdCreativeNoAI(adAccount, token, (ad.name || 'advertentie') + ' - creatief', built);
      await graphPost(`${req.params.adId}`, { creative: JSON.stringify({ creative_id: creativeF.id }), access_token: token });
      return res.json({ success: true });
    }

    const newSpec = { page_id: spec.page_id };
    if (spec.video_data) {
      const v = { ...spec.video_data };
      // Meta geeft soms zowel image_url als image_hash terug, maar accepteert er bij het
      // opnieuw aanmaken maar een. Houd de hash (Meta's eigen thumbnail) als beide er zijn.
      if (v.image_hash && v.image_url) delete v.image_url;
      if (headline !== undefined) v.title = headline || DEFAULT_AD_HEADLINE;
      if (!v.title) v.title = DEFAULT_AD_HEADLINE;
      if (caption !== undefined) v.message = caption;
      v.call_to_action = v.call_to_action || { type: 'LEARN_MORE', value: {} };
      if (cta !== undefined) v.call_to_action.type = cta;
      if (link !== undefined) v.call_to_action.value = { ...(v.call_to_action.value || {}), link };
      newSpec.video_data = v;
    } else {
      const l = { ...spec.link_data };
      // Zelfde regel voor afbeeldingen: maar een van picture/image_hash mag mee.
      if (l.image_hash && l.picture) delete l.picture;
      if (headline !== undefined) l.name = headline || DEFAULT_AD_HEADLINE;
      if (!l.name) l.name = DEFAULT_AD_HEADLINE;
      if (caption !== undefined) l.message = caption;
      if (link !== undefined) {
        l.link = link;
        l.call_to_action = l.call_to_action || { type: 'LEARN_MORE', value: {} };
        l.call_to_action.value = { ...(l.call_to_action.value || {}), link };
      }
      if (cta !== undefined) {
        l.call_to_action = l.call_to_action || { type: 'LEARN_MORE', value: { link: l.link } };
        l.call_to_action.type = cta;
      }
      newSpec.link_data = l;
    }

    const creative = await createAdCreativeNoAI(adAccount, token, (ad.name || 'advertentie') + ' - creatief', JSON.stringify(newSpec));
    await graphPost(`${req.params.adId}`, { creative: JSON.stringify({ creative_id: creative.id }), access_token: token });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Extra advertentie toevoegen aan een bestaande advertentieset. Wordt
// gepauzeerd aangemaakt, zodat er niets gaat uitgeven tot je het activeert.
router.post('/api/mkt/clients/:clientId/meta-adsets/:adsetId/ads', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Naam van de advertentie is verplicht' });
    const link = String(b.link || '').trim();
    if (!/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'Vul een geldige bestemmings-URL in (https://...)' });
    const cta = CTA_TYPES.includes(b.cta) ? b.cta : 'LEARN_MORE';
    const caption = String(b.caption || '').slice(0, 2000);
    const headline = String(b.headline || '').slice(0, 255);

    const creds = await resolveClientMeta(wsId, okClient);
    const token = creds.token;
    const adAccount = creds.adAccount;
    if (!token) return res.status(400).json({ error: 'Meta access token ontbreekt (klant en workspace)' });
    if (!adAccount) return res.status(400).json({ error: 'Ad Account ID ontbreekt (klant en workspace)' });
    if (!creds.pageId) return res.status(400).json({ error: 'Facebook Page ID ontbreekt in de koppelingen van deze klant' });

    if (!b.assetId) return res.status(400).json({ error: 'Kies een afbeelding of video voor de advertentie' });
    const asset = await withReadConnection(async (c) => (await c.query(
      'SELECT url, resource_type, provider FROM marketing.assets WHERE id=$1 AND client_id=$2 AND workspace_id=$3',
      [b.assetId, okClient, wsId]
    )).rows[0]);
    if (!asset || asset.provider !== 'cloudinary' || !asset.url) return res.status(400).json({ error: 'Gekozen bestand niet gevonden of niet publiek' });

    const captionsArr = (Array.isArray(b.captions) && b.captions.length) ? b.captions : [caption];
    const wantedMulti = captionsArr.map((x) => String(x || '').trim()).filter(Boolean).length >= 2;
    const creativeFields = await buildCreative(adAccount, token, creds.pageId, asset, captionsArr, link, cta, headline);
    const creative = await createAdCreativeNoAI(adAccount, token, name + ' - creatief', creativeFields);
    const makeAd = () => graphPost(`${adAccount}/ads`, {
      name, adset_id: req.params.adsetId, creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED', access_token: token,
    });
    let ad;
    let adsetHealed = false;
    try {
      ad = await makeAd();
    } catch (adErr) {
      // Zelf-herstel: bestaande ad sets die zijn aangemaakt voor de pixel was
      // ingesteld, missen een conversiebron. Meta weigert de advertentie dan
      // met 1487888 (trackingpixel vereist). Zet de pixel alsnog op deze ad set
      // en probeer de advertentie opnieuw, zodat de klant niets hoeft te doen.
      const em = String((adErr && adErr.message) || '');
      if (/1487888/.test(em) && creds.pixelId) {
        await graphPost(`${req.params.adsetId}`, {
          promoted_object: JSON.stringify({ pixel_id: String(creds.pixelId), custom_event_type: 'LEAD' }),
          optimization_goal: 'OFFSITE_CONVERSIONS',
          access_token: token,
        });
        adsetHealed = true;
        ad = await makeAd();
      } else {
        throw adErr;
      }
    }
    // multiTextApplied: null = geen meerdere teksten gevraagd; true/false = of Meta de afwisseling accepteerde.
    res.json({ success: true, ad_id: ad.id, adsetHealed, multiTextApplied: wantedMulti ? !creative._usedFallback : null, flexError: creative._usedFallback ? creative._flexError : null });
  } catch (e) {
    const m = String((e && e.message) || '');
    if (/1885553/.test(m) || /dynamisch advertentiemateriaal/i.test(m)) {
      return res.status(400).json({ error: 'Deze ad set is eerder dynamisch geworden en mag daardoor maar een advertentie bevatten. Maak een nieuwe ad set aan voor extra advertenties; nieuwe ad sets hebben deze beperking niet meer.' });
    }
    if (/1487888/.test(m)) {
      return res.status(400).json({ error: 'Deze campagne is een conversiecampagne, maar er is geen Meta-pixel gekoppeld aan deze klant. Vul het Meta Pixel ID in bij de koppelingen, bewaar, en probeer opnieuw.' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Advertentieset verwijderen.
router.delete('/api/mkt/clients/:clientId/meta-adsets/:adsetId', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const body = new URLSearchParams({ access_token: token });
    const r = await fetch(`${GRAPH}/${req.params.adsetId}`, { method: 'DELETE', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error ? j.error.message : 'Verwijderen mislukt');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Hele campagne in een keer live zetten of pauzeren (campagne + alle sets + alle ads).
router.post('/api/mkt/clients/:clientId/meta-campaigns/:campaignId/publish', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = (req.body && (req.body.status === 'ACTIVE' || req.body.status === 'PAUSED')) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Kies live zetten of pauzeren' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const cid = req.params.campaignId;
    const sets = await graphGet(`${cid}/adsets`, { fields: 'id', limit: '50', access_token: token });
    const ads = await graphGet(`${cid}/ads`, { fields: 'id', limit: '100', access_token: token });
    // Bij live zetten: eerst de campagne, dan sets, dan ads (ouder actief voor kind).
    // Bij pauzeren maakt de volgorde niet uit.
    await graphPost(`${cid}`, { status, access_token: token });
    for (const s of (sets.data || [])) { await graphPost(`${s.id}`, { status, access_token: token }); }
    for (const a of (ads.data || [])) { await graphPost(`${a.id}`, { status, access_token: token }); }
    res.json({ success: true, status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Hele campagne verwijderen (bij Meta en uit onze database + koppelingen).
router.delete('/api/mkt/clients/:clientId/meta-campaigns/:campaignId', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const token = await metaTokenForClient(wsId, okClient);
    if (!token) return res.status(400).json({ error: 'Geen Meta access token ingesteld' });
    const cid = req.params.campaignId;
    // Bij de #613-limiet (1 verzoek per 30 sec op sommige ad accounts) wacht de
    // actie zelf even en probeert opnieuw, zodat verwijderen in een klik lukt.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${GRAPH}/${cid}`, { method: 'DELETE', body: new URLSearchParams({ access_token: token }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !j.error) { lastErr = null; break; }
      lastErr = metaErrorMessage(j);
      if (isRateLimit613(j) && attempt < 2) { await sleepMs(31000); continue; }
      break;
    }
    if (lastErr) throw new Error(lastErr);
    // Ook onze eigen sporen opruimen (campagne-rij en eventuele koppeling).
    try {
      await withWriteConnection(async (c) => {
        await c.query('DELETE FROM marketing.campaigns WHERE meta_campaign_id=$1 AND workspace_id=$2', [cid, wsId]);
        await c.query('DELETE FROM marketing.campaign_links WHERE meta_campaign_id=$1 AND workspace_id=$2', [cid, wsId]);
      });
    } catch (_) { /* Meta is leidend; database-opruiming is niet kritisch */ }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// Opmerkingen/feedback van de klant op een campagne (inzage + reageren).
// Deploy-veilig: de tabel wordt bij eerste gebruik aangemaakt.
// =======================================================================
// De app-gebruiker mag geen tabellen aanmaken in schema marketing; de tabel
// wordt via migratie 006 in Neon aangemaakt. Deze helper doet daarom niets meer
// (blijft bestaan zodat de aanroepen ongewijzigd blijven).
async function ensureCampaignFeedbackTable(_c) { /* tabel komt uit migratie 006 */ }
// Mag deze gebruiker deze opmerking bewerken/verwijderen? Eigen bericht, of team.
function mktMayEditFeedback(m, row) {
  if (!m || !row) return false;
  if (m.platformAdmin || m.role === 'owner' || m.role === 'manager') return true;
  return row.author_account_id != null && String(row.author_account_id) === String(m.accountId);
}
router.get('/api/mkt/clients/:clientId/campaigns/:campaignId/feedback', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const rows = await withWriteConnection(async (c) => {
      await ensureCampaignFeedbackTable(c);
      return (await c.query(
        `SELECT id, author_account_id, author_role, author_name, body, created_at, updated_at
           FROM marketing.campaign_feedback
          WHERE workspace_id=$1 AND client_id=$2 AND meta_campaign_id=$3
          ORDER BY created_at ASC`,
        [wsId, okClient, String(req.params.campaignId)]
      )).rows;
    });
    res.json({ success: true, feedback: rows, me: req.session.mkt.accountId || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/clients/:clientId/campaigns/:campaignId/feedback', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Bericht is leeg' });
    if (body.length > 4000) return res.status(400).json({ error: 'Bericht te lang (max 4000 tekens)' });
    const m = req.session.mkt;
    const row = await withWriteConnection(async (c) => {
      await ensureCampaignFeedbackTable(c);
      return (await c.query(
        `INSERT INTO marketing.campaign_feedback (workspace_id, client_id, meta_campaign_id, author_account_id, author_role, author_name, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, author_account_id, author_role, author_name, body, created_at, updated_at`,
        [wsId, okClient, String(req.params.campaignId), m.accountId || null, m.role || null, m.email || null, body]
      )).rows[0];
    });
    res.json({ success: true, feedback: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Opmerking bewerken (eigen bericht, of team).
router.patch('/api/mkt/clients/:clientId/campaigns/:campaignId/feedback/:feedbackId', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Bericht is leeg' });
    if (body.length > 4000) return res.status(400).json({ error: 'Bericht te lang (max 4000 tekens)' });
    const m = req.session.mkt;
    const out = await withWriteConnection(async (c) => {
      await ensureCampaignFeedbackTable(c);
      const row = (await c.query('SELECT id, author_account_id FROM marketing.campaign_feedback WHERE id=$1 AND workspace_id=$2 AND client_id=$3', [req.params.feedbackId, wsId, okClient])).rows[0];
      if (!row) return { code: 404, error: 'Opmerking niet gevonden' };
      if (!mktMayEditFeedback(m, row)) return { code: 403, error: 'Geen rechten om deze opmerking te bewerken' };
      const upd = (await c.query('UPDATE marketing.campaign_feedback SET body=$1, updated_at=now() WHERE id=$2 RETURNING id, author_account_id, author_role, author_name, body, created_at, updated_at', [body, req.params.feedbackId])).rows[0];
      return { feedback: upd };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ success: true, feedback: out.feedback });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Opmerking verwijderen (eigen bericht, of team).
router.delete('/api/mkt/clients/:clientId/campaigns/:campaignId/feedback/:feedbackId', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const m = req.session.mkt;
    const out = await withWriteConnection(async (c) => {
      await ensureCampaignFeedbackTable(c);
      const row = (await c.query('SELECT id, author_account_id FROM marketing.campaign_feedback WHERE id=$1 AND workspace_id=$2 AND client_id=$3', [req.params.feedbackId, wsId, okClient])).rows[0];
      if (!row) return { code: 404, error: 'Opmerking niet gevonden' };
      if (!mktMayEditFeedback(m, row)) return { code: 403, error: 'Geen rechten om deze opmerking te verwijderen' };
      await c.query('DELETE FROM marketing.campaign_feedback WHERE id=$1', [req.params.feedbackId]);
      return { ok: true };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// Geplande (concept) Meta-campagnes: het team zet toekomstige campagnes klaar,
// de klant ziet ze in een overzicht en kan goedkeuren/wijzigingen vragen.
// Puur een plan in onze database; er gebeurt niets automatisch bij Meta.
// =======================================================================
const DRAFT_STATUS = ['concept', 'ter_goedkeuring', 'goedgekeurd', 'wijzigingen', 'live'];
// Tabel komt uit migratie 006 (app-gebruiker mag geen DDL in schema marketing).
async function ensureCampaignDraftTable(_c) { /* tabel komt uit migratie 006 */ }
router.get('/api/mkt/clients/:clientId/campaign-drafts', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const clientOnly = mktClientLocked(req);
    const rows = await withWriteConnection(async (c) => {
      await ensureCampaignDraftTable(c);
      return (await c.query(
        `SELECT id, name, objective, daily_budget_cents, audience, ad_text, planned_start, notes, status, created_at, updated_at
           FROM marketing.campaign_drafts
          WHERE workspace_id=$1 AND client_id=$2 ${clientOnly ? "AND status <> 'concept'" : ''}
          ORDER BY (status='live') ASC, planned_start ASC NULLS LAST, created_at DESC`,
        [wsId, okClient]
      )).rows;
    });
    res.json({ success: true, drafts: rows, canManage: mktCanManage(req) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mkt/clients/:clientId/campaign-drafts', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om campagnes klaar te zetten' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
    const budgetCents = (b.daily_budget != null && b.daily_budget !== '') ? Math.round(Number(b.daily_budget) * 100) : null;
    const st = DRAFT_STATUS.includes(b.status) ? b.status : 'concept';
    const row = await withWriteConnection(async (c) => {
      await ensureCampaignDraftTable(c);
      return (await c.query(
        `INSERT INTO marketing.campaign_drafts (workspace_id, client_id, name, objective, daily_budget_cents, audience, ad_text, planned_start, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, name, objective, daily_budget_cents, audience, ad_text, planned_start, notes, status, created_at, updated_at`,
        [wsId, okClient, name, b.objective || null, budgetCents, b.audience || null, b.ad_text || null, b.planned_start || null, b.notes || null, st, req.session.mkt.accountId || null]
      )).rows[0];
    });
    res.json({ success: true, draft: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/api/mkt/clients/:clientId/campaign-drafts/:draftId', requireMkt, async (req, res) => {
  try {
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const b = req.body || {};
    const isClient = mktClientLocked(req);
    const out = await withWriteConnection(async (c) => {
      await ensureCampaignDraftTable(c);
      const cur = (await c.query('SELECT id FROM marketing.campaign_drafts WHERE id=$1 AND workspace_id=$2 AND client_id=$3', [req.params.draftId, wsId, okClient])).rows[0];
      if (!cur) return { code: 404, error: 'Geplande campagne niet gevonden' };
      const sets = []; const vals = []; let i = 1;
      if (isClient) {
        // Een klant mag alleen goedkeuren of wijzigingen vragen.
        if (!['goedgekeurd', 'wijzigingen'].includes(b.status)) return { code: 403, error: 'Een klant kan alleen goedkeuren of wijzigingen vragen' };
        sets.push(`status=$${i++}`); vals.push(b.status);
      } else {
        if (!mktCanManage(req)) return { code: 403, error: 'Geen rechten' };
        const map = { name: 'name', objective: 'objective', audience: 'audience', ad_text: 'ad_text', planned_start: 'planned_start', notes: 'notes' };
        for (const k of Object.keys(map)) { if (b[k] !== undefined) { sets.push(`${map[k]}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); } }
        if (b.daily_budget !== undefined) { sets.push(`daily_budget_cents=$${i++}`); vals.push((b.daily_budget != null && b.daily_budget !== '') ? Math.round(Number(b.daily_budget) * 100) : null); }
        if (b.status !== undefined && DRAFT_STATUS.includes(b.status)) { sets.push(`status=$${i++}`); vals.push(b.status); }
      }
      if (!sets.length) return { code: 400, error: 'Niets om bij te werken' };
      sets.push('updated_at=now()');
      vals.push(req.params.draftId);
      const row = (await c.query(`UPDATE marketing.campaign_drafts SET ${sets.join(', ')} WHERE id=$${i} RETURNING id, name, objective, daily_budget_cents, audience, ad_text, planned_start, notes, status, created_at, updated_at`, vals)).rows[0];
      return { draft: row };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ success: true, draft: out.draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/api/mkt/clients/:clientId/campaign-drafts/:draftId', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    await withWriteConnection(async (c) => {
      await ensureCampaignDraftTable(c);
      await c.query('DELETE FROM marketing.campaign_drafts WHERE id=$1 AND workspace_id=$2 AND client_id=$3', [req.params.draftId, wsId, okClient]);
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 13 - LANGLEVEND META-TOKEN (kort token omruilen naar ~60 dagen)
// Nodig voor geplande posts: het opgeslagen token moet nog geldig zijn op
// het moment van publiceren. Vereist Meta App ID + App Secret in Koppelingen.
// =======================================================================
router.post('/api/mkt/clients/:clientId/meta/extend-token', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const creds = await resolveClientMeta(wsId, okClient);
    const appId = creds.appId || null;
    const appSecret = creds.appSecret || null;
    const shortTok = creds.token || null;
    if (!appId || !appSecret) return res.status(400).json({ error: 'Vul Meta App ID en App Secret in bij de Werkplek-koppeling (eenmalig voor je hele workspace), of per klant bij Koppelingen.' });
    if (!shortTok) return res.status(400).json({ error: 'Er is nog geen access token ingevuld om te verlengen' });

    const r = await graphGet('oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortTok,
    });
    if (!r.access_token) return res.status(400).json({ error: 'Meta gaf geen langlevend token terug' });
    const expSecs = r.expires_in ? Number(r.expires_in) : 60 * 24 * 3600;
    await withWriteConnection(async (c) => {
      await c.query('ALTER TABLE marketing.client_integrations ADD COLUMN IF NOT EXISTS meta_token_expires_at TIMESTAMPTZ').catch(() => {});
      try {
        await c.query(
          "UPDATE marketing.client_integrations SET meta_access_token=$1, meta_token_expires_at=now() + ($2 || ' seconds')::interval, updated_at=now() WHERE client_id=$3 AND workspace_id=$4",
          [encryptSecret(r.access_token), String(expSecs), okClient, wsId]
        );
      } catch (_) {
        await c.query('UPDATE marketing.client_integrations SET meta_access_token=$1, updated_at=now() WHERE client_id=$2 AND workspace_id=$3', [encryptSecret(r.access_token), okClient, wsId]);
      }
    });
    const days = r.expires_in ? Math.round(r.expires_in / 86400) : 60;
    res.json({ success: true, days });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =======================================================================
// STAP 15 - CAMPAGNES KOPPELEN aan een klant (bij een gedeeld ad account)
// =======================================================================
// Welke campagne-ID's zijn aan deze klant gekoppeld.
router.get('/api/mkt/clients/:clientId/campaign-links', requireMkt, async (req, res) => {
  try {
    // Klant-account mag de eigen campagne-koppelingen alleen-lezen inzien; andere klanten geblokkeerd.
    if (!mktClientAllowed(req, req.params.clientId)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const rows = await withReadConnection(async (c) => (await c.query(
      'SELECT meta_campaign_id FROM marketing.campaign_links WHERE workspace_id=$1 AND client_id=$2', [wsId, okClient]
    )).rows);
    res.json({ success: true, links: rows.map((r) => r.meta_campaign_id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stel de gekoppelde campagnes van deze klant in (vervangt de bestaande set).
// Een campagne die aan een andere klant hing, verhuist mee naar deze klant.
router.put('/api/mkt/clients/:clientId/campaign-links', requireMkt, async (req, res) => {
  try {
    if (!mktIsOwnerOrManager(req)) return res.status(403).json({ error: 'Alleen eigenaar of manager' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const items = Array.isArray(req.body && req.body.campaigns) ? req.body.campaigns : [];
    await withWriteConnection(async (c) => {
      await c.query('DELETE FROM marketing.campaign_links WHERE workspace_id=$1 AND client_id=$2', [wsId, okClient]);
      for (const it of items) {
        const cid = String((it && it.id) || '').trim();
        if (!cid) continue;
        const nm = (it && it.name != null) ? String(it.name).slice(0, 300) : null;
        await c.query(
          `INSERT INTO marketing.campaign_links (workspace_id, client_id, meta_campaign_id, campaign_name)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (workspace_id, meta_campaign_id)
           DO UPDATE SET client_id=EXCLUDED.client_id, campaign_name=EXCLUDED.campaign_name`,
          [wsId, okClient, cid, nm]
        );
      }
    });
    res.json({ success: true, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// WERKPLEK-BREDE OVERZICHTEN (alleen voor seats, nooit voor klant-accounts)
// =======================================================================

// Rapportage-overzicht van alle klanten in de werkplek (eigen data uit Neon).
router.get('/api/mkt/reporting/overview', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT
         cl.id, cl.name, cl.brand_color,
         (SELECT COUNT(*)::int FROM marketing.content_posts p WHERE p.client_id=cl.id AND p.workspace_id=$1) AS posts,
         (SELECT COUNT(*)::int FROM marketing.content_posts p WHERE p.client_id=cl.id AND p.workspace_id=$1 AND p.status='scheduled') AS scheduled,
         (SELECT COUNT(*)::int FROM marketing.content_posts p WHERE p.client_id=cl.id AND p.workspace_id=$1 AND p.published_at IS NOT NULL) AS published,
         (SELECT COUNT(*)::int FROM marketing.content_posts p WHERE p.client_id=cl.id AND p.workspace_id=$1 AND p.approval='approved') AS approved,
         (SELECT COUNT(*)::int FROM marketing.assets a WHERE a.client_id=cl.id AND a.workspace_id=$1) AS assets,
         (SELECT COALESCE(SUM(a.size_bytes),0)::bigint FROM marketing.assets a WHERE a.client_id=cl.id AND a.workspace_id=$1) AS asset_bytes,
         (SELECT COUNT(*)::int FROM marketing.campaigns k WHERE k.client_id=cl.id AND k.workspace_id=$1) AS campaigns
       FROM marketing.clients cl
       WHERE cl.workspace_id=$1 AND cl.archived=false
       ORDER BY cl.name ASC`,
      [wsId]
    )).rows);
    const totals = rows.reduce((t, r) => ({
      posts: t.posts + (r.posts || 0),
      scheduled: t.scheduled + (r.scheduled || 0),
      published: t.published + (r.published || 0),
      assets: t.assets + (r.assets || 0),
      asset_bytes: t.asset_bytes + Number(r.asset_bytes || 0),
      campaigns: t.campaigns + (r.campaigns || 0),
    }), { posts: 0, scheduled: 0, published: 0, assets: 0, asset_bytes: 0, campaigns: 0 });
    res.json({ success: true, clients: rows, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Koppelingen-overzicht: per klant welke Meta-kanalen live staan (gemaskeerd).
router.get('/api/mkt/koppelingen/overview', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const clients = await withReadConnection(async (c) => (await c.query(
      'SELECT id, name, brand_color FROM marketing.clients WHERE workspace_id=$1 AND archived=false ORDER BY name ASC',
      [wsId]
    )).rows);
    // Vervaldatum per klant + van het werkplek-token (voor de verleng-herinnering).
    // Best-effort: ontbreekt de kolom nog, dan blijft de vervaldatum leeg.
    let expByClient = {}; let wsExpiry = null;
    try {
      const rows = await withReadConnection(async (c) => (await c.query(
        'SELECT client_id, (meta_access_token IS NOT NULL) AS has_tok, meta_token_expires_at FROM marketing.client_integrations WHERE workspace_id=$1', [wsId]
      )).rows);
      rows.forEach((r) => { expByClient[r.client_id] = { hasTok: r.has_tok, exp: r.meta_token_expires_at }; });
    } catch (_) { expByClient = {}; }
    try {
      const w = await withReadConnection(async (c) => (await c.query(
        'SELECT meta_token_expires_at FROM marketing.workspace_integrations WHERE workspace_id=$1', [wsId]
      )).rows[0]);
      wsExpiry = w ? w.meta_token_expires_at : null;
    } catch (_) { wsExpiry = null; }
    const out = [];
    for (const cl of clients) {
      let creds = {};
      try { creds = await resolveClientMeta(wsId, cl.id); } catch (_) { creds = {}; }
      const ce = expByClient[cl.id];
      // Eigen token -> eigen vervaldatum; valt de klant terug op het werkplek-token -> werkplek-vervaldatum.
      const tokenExpiresAt = (ce && ce.hasTok) ? (ce.exp || null) : (creds.token ? (wsExpiry || null) : null);
      out.push({
        id: cl.id, name: cl.name, brand_color: cl.brand_color,
        token: !!creds.token,
        adAccount: creds.adAccount || null, pageId: creds.pageId || null,
        igUserId: creds.igUserId || null, pixelId: creds.pixelId || null,
        tokenExpiresAt,
      });
    }
    res.json({ success: true, clients: out, workspaceTokenExpiresAt: wsExpiry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live-check van de Meta-koppeling van een klant: echt pingen richting Meta,
// niet alleen kijken of er iets is ingevuld.
router.get('/api/mkt/clients/:clientId/meta-status', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const creds = await resolveClientMeta(wsId, okClient);
    const has = {
      token: !!creds.token, adAccount: !!creds.adAccount, pageId: !!creds.pageId,
      igUserId: !!creds.igUserId, pixelId: !!creds.pixelId,
    };
    if (!creds.token) return res.json({ success: true, connected: false, live: false, has, reason: 'Geen token ingesteld' });
    try {
      let detail = {};
      if (creds.adAccount) {
        const a = await graphGet(`${creds.adAccount}`, { fields: 'account_status,name,currency', access_token: creds.token });
        detail = { adAccountName: a.name || null, accountStatus: a.account_status ?? null, currency: a.currency || null };
      } else {
        const me = await graphGet('me', { fields: 'id,name', access_token: creds.token });
        detail = { tokenName: me.name || null };
      }
      return res.json({ success: true, connected: true, live: true, has, detail });
    } catch (e) {
      return res.json({ success: true, connected: false, live: false, has, error: e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live-check van het hoofdaccount van de werkplek (workspace-defaults).
router.get('/api/mkt/workspace/meta-status', requireMkt, async (req, res) => {
  try {
    if (mktClientLocked(req)) return res.status(403).json({ error: 'Geen toegang' });
    const wsId = req.session.mkt.workspaceId;
    const creds = await resolveClientMeta(wsId, null); // null -> alleen workspace-defaults
    const has = { token: !!creds.token, adAccount: !!creds.adAccount };
    if (!creds.token) return res.json({ success: true, connected: false, live: false, has, reason: 'Geen token ingesteld' });
    try {
      let detail = {};
      if (creds.adAccount) {
        const a = await graphGet(`${creds.adAccount}`, { fields: 'account_status,name,currency', access_token: creds.token });
        detail = { adAccountName: a.name || null, accountStatus: a.account_status ?? null, currency: a.currency || null };
      } else {
        const me = await graphGet('me', { fields: 'id,name', access_token: creds.token });
        detail = { tokenName: me.name || null };
      }
      return res.json({ success: true, connected: true, live: true, has, detail });
    } catch (e) {
      return res.json({ success: true, connected: false, live: false, has, error: e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

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
function requireMkt(req, res, next) {
  const m = req.session && req.session.mkt;
  if (m && (m.accountId || (m.platformAdmin && m.workspaceId))) return next();
  return res.status(401).json({ error: 'Niet ingelogd' });
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
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
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
        `SELECT id, email, full_name, role, active, banned, last_login_at, created_at
           FROM marketing.accounts WHERE workspace_id=$1 ORDER BY (role='owner') DESC, created_at ASC`, [req.params.id]
      )).rows;
      const clients = (await c.query('SELECT COUNT(*)::int AS n FROM marketing.clients WHERE workspace_id=$1', [req.params.id])).rows[0].n;
      return { ws, accounts, clients };
    });
    if (!data) return res.status(404).json({ error: 'Workspace niet gevonden' });
    res.json({ success: true, workspace: data.ws, accounts: data.accounts, client_count: data.clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account toevoegen aan een workspace.
router.post('/api/mkt/admin/workspaces/:id/accounts', requireDhcAdmin, async (req, res) => {
  try {
    const { email, full_name, role, password } = req.body || {};
    const VALID_ROLE = ['owner', 'manager', 'member', 'client'];
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord: min. 8 tekens, hoofd- en kleine letter en een cijfer' });
    const r = VALID_ROLE.includes(role) ? role : 'member';
    const em = String(email).toLowerCase().trim();
    const ws = await withReadConnection(async (c) => (await c.query('SELECT id FROM marketing.workspaces WHERE id=$1', [req.params.id])).rows[0]);
    if (!ws) return res.status(404).json({ error: 'Workspace niet gevonden' });
    const dup = await withReadConnection(async (c) => (await c.query('SELECT 1 FROM marketing.accounts WHERE email=$1', [em])).rows[0]);
    if (dup) return res.status(400).json({ error: 'Dit e-mailadres bestaat al binnen marketing' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.accounts (workspace_id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role, active, banned`,
      [req.params.id, em, hash, full_name || null, r]
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

    // 1) Marketing-account
    const acc = await withReadConnection(async (c) => (await c.query(
      `SELECT a.*, w.name AS workspace_name, w.slug AS workspace_slug, w.active AS ws_active,
              w.license_type, w.license_end, w.modules
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE a.email=$1 AND a.active=true AND (a.banned IS NULL OR a.banned=false)`, [em]
    )).rows[0]);
    if (acc && await bcrypt.compare(password, acc.password_hash)) {
      if (!acc.ws_active) return res.status(403).json({ error: 'Deze workspace is niet actief' });
      if (acc.license_end && new Date(acc.license_end) < new Date())
        return res.status(403).json({ error: 'De licentie van deze workspace is verlopen' });
      req.session.mkt = { accountId: acc.id, workspaceId: acc.workspace_id, role: acc.role, email: acc.email };
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
      `SELECT a.id, a.email, a.full_name, a.role,
              w.id AS workspace_id, w.name AS workspace_name, w.slug, w.modules,
              w.license_type, w.license_end, w.max_seats, w.max_clients
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id=a.workspace_id
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
// STAP 2 — CLIENT SPACES (klanten binnen een workspace)
// Alles strikt gescopet op req.session.mkt.workspaceId.
// =======================================================================
const CLIENT_STATUS = ['active', 'paused', 'archived'];
function mktCanManage(req) { const m = req.session?.mkt; return m && (m.platformAdmin || m.role !== 'client'); }
function mktIsOwnerOrManager(req) { const m = req.session?.mkt; return m && (m.platformAdmin || m.role === 'owner' || m.role === 'manager'); }

// Lijst klanten van de eigen workspace (standaard zonder gearchiveerde).
router.get('/api/mkt/clients', requireMkt, async (req, res) => {
  try {
    const includeArchived = String(req.query.archived || '') === '1';
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, name, contact_name, contact_email, website, brand_color, status, archived, created_at
         FROM marketing.clients
        WHERE workspace_id = $1 ${includeArchived ? '' : 'AND archived = false'}
        ORDER BY name ASC`,
      [req.session.mkt.workspaceId]
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
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });
    const status = String(req.query.status || '');
    const filterStatus = POST_STATUS.includes(status) ? status : null;
    const rows = await withReadConnection(async (c) => (await c.query(
      `SELECT id, client_id, title, body, channel, status, scheduled_at, created_at, updated_at
         FROM marketing.content_posts
        WHERE workspace_id=$1 AND client_id=$2
          ${filterStatus ? 'AND status=$3' : ''}
        ORDER BY scheduled_at ASC NULLS LAST, created_at DESC`,
      filterStatus ? [wsId, okClient, filterStatus] : [wsId, okClient]
    )).rows);
    res.json({ success: true, posts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nieuwe post aanmaken voor een klant.
router.post('/api/mkt/clients/:clientId/posts', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const { title, body, channel, status, scheduled_at } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Titel is verplicht' });
    const ch = POST_CHANNELS.includes(channel) ? channel : 'other';
    const st = POST_STATUS.includes(status) ? status : 'idea';
    let when = null;
    if (scheduled_at) {
      const d = new Date(scheduled_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Ongeldige planningsdatum' });
      when = d;
    }
    const row = await withWriteConnection(async (c) => (await c.query(
      `INSERT INTO marketing.content_posts (workspace_id, client_id, title, body, channel, status, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, client_id, title, body, channel, status, scheduled_at, created_at, updated_at`,
      [wsId, okClient, String(title).trim(), body || null, ch, st, when, req.session.mkt.accountId || null]
    )).rows[0]);
    res.json({ success: true, post: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post bijwerken (titel, tekst, kanaal, status, planning).
router.patch('/api/mkt/posts/:id', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om content te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const b = req.body || {};
    const sets = [], vals = []; let i = 1;
    if (b.title !== undefined) {
      if (!String(b.title).trim()) return res.status(400).json({ error: 'Titel mag niet leeg zijn' });
      sets.push(`title=$${i++}`); vals.push(String(b.title).trim());
    }
    if (b.body !== undefined) { sets.push(`body=$${i++}`); vals.push(b.body === '' ? null : b.body); }
    if (b.channel !== undefined && POST_CHANNELS.includes(b.channel)) { sets.push(`channel=$${i++}`); vals.push(b.channel); }
    if (b.status !== undefined && POST_STATUS.includes(b.status)) { sets.push(`status=$${i++}`); vals.push(b.status); }
    if (b.scheduled_at !== undefined) {
      if (b.scheduled_at === '' || b.scheduled_at === null) { sets.push(`scheduled_at=$${i++}`); vals.push(null); }
      else {
        const d = new Date(b.scheduled_at);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Ongeldige planningsdatum' });
        sets.push(`scheduled_at=$${i++}`); vals.push(d);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Niets om bij te werken' });
    sets.push(`updated_at=now()`);
    vals.push(req.params.id, wsId);
    const row = await withWriteConnection(async (c) => (await c.query(
      `UPDATE marketing.content_posts SET ${sets.join(', ')}
        WHERE id=$${i++} AND workspace_id=$${i}
       RETURNING id, client_id, title, body, channel, status, scheduled_at, created_at, updated_at`, vals
    )).rows[0]);
    if (!row) return res.status(404).json({ error: 'Post niet gevonden' });
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

// =======================================================================
// STAP 3 - ASSETS (beeldmateriaal per klant, opgeslagen als bytea in Neon)
// Upload via base64-JSON met een ruimere body-limiet, alleen op deze route.
// =======================================================================
const ASSET_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per bestand
const ASSET_MIME_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const assetUploadParser = express.json({ limit: '12mb' });

// Lijst assets van een klant (alleen metadata, niet de bytes).
router.get('/api/mkt/clients/:clientId/assets', requireMkt, async (req, res) => {
  try {
    const wsId = req.session.mkt.workspaceId;
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
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om assets te beheren' });
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

// Registreer een geuploade Cloudinary-asset in de database.
// Body: { public_id, url, resource_type, format, bytes, filename, mime }.
router.post('/api/mkt/clients/:clientId/assets/register', requireMkt, async (req, res) => {
  try {
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om assets te beheren' });
    const wsId = req.session.mkt.workspaceId;
    const okClient = await clientInWorkspace(req.params.clientId, wsId);
    if (!okClient) return res.status(404).json({ error: 'Klant niet gevonden' });

    const b = req.body || {};
    if (!b.public_id || !b.url) return res.status(400).json({ error: 'Onvolledige upload-gegevens' });
    const rtype = (b.resource_type === 'video' || b.resource_type === 'image') ? b.resource_type : 'image';
    const name = (b.filename && String(b.filename).trim().slice(0, 200)) || 'bestand';
    const size = Number.isFinite(Number(b.bytes)) ? Math.max(0, Math.floor(Number(b.bytes))) : 0;
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
    if (!mktCanManage(req)) return res.status(403).json({ error: 'Geen rechten om assets te beheren' });
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
    const row = await withReadConnection(async (c) => (await c.query(
      `SELECT filename, mime, data FROM marketing.assets WHERE id=$1 AND workspace_id=$2`,
      [req.params.id, req.session.mkt.workspaceId]
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
const INT_PLAIN = ['meta_page_id', 'meta_ig_user_id', 'meta_pixel_id', 'google_ads_customer_id', 'ga4_measurement_id', 'tiktok_pixel_id', 'notes'];
const INT_SECRET = ['meta_access_token', 'google_ads_developer_token', 'tiktok_access_token'];

function integrationsView(row) {
  const out = {};
  for (const f of INT_PLAIN) out[f] = row ? (row[f] || '') : '';
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

export default router;

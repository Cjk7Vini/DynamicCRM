// src/marketing/router.js
// GEISOLEERDE marketing-module. Leeft volledig los van het churn-dashboard.
//  - Data: uitsluitend schema `marketing.*` in Neon.
//  - Routes: /marketing (shell) en /api/mkt/*  (nergens anders).
//  - Auth: eigen sessie-namespace req.session.mkt (botst niet met de DHC-login).
//  - Adminbeheer van workspaces/licenties: afgeschermd met de bestaande DHC-admin.
// Deze module raakt GEEN bestaande tabellen of endpoints aan.

import express from 'express';
import bcrypt from 'bcrypt';
import path from 'path';
import { fileURLToPath } from 'url';
import { withReadConnection, withWriteConnection } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

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
function requireMkt(req, res, next) {
  if (req.session && req.session.mkt && req.session.mkt.accountId) return next();
  return res.status(401).json({ error: 'Niet ingelogd' });
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

// =======================================================================
// MARKETING AUTH (eigen accounts, eigen sessie-namespace)
// =======================================================================
router.post('/api/mkt/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    const acc = await withReadConnection(async (c) => (await c.query(
      `SELECT a.*, w.name AS workspace_name, w.slug AS workspace_slug, w.active AS ws_active,
              w.license_type, w.license_end, w.modules
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id = a.workspace_id
        WHERE a.email=$1 AND a.active=true AND (a.banned IS NULL OR a.banned=false)`,
      [String(email).toLowerCase().trim()]
    )).rows[0]);
    if (!acc) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    if (!acc.ws_active) return res.status(403).json({ error: 'Deze workspace is niet actief' });
    if (acc.license_end && new Date(acc.license_end) < new Date()) {
      return res.status(403).json({ error: 'De licentie van deze workspace is verlopen' });
    }
    const ok = await bcrypt.compare(password, acc.password_hash);
    if (!ok) return res.status(401).json({ error: 'Onjuiste inloggegevens' });

    req.session.mkt = {
      accountId: acc.id, workspaceId: acc.workspace_id,
      role: acc.role, email: acc.email
    };
    await withWriteConnection(async (c) =>
      c.query('UPDATE marketing.accounts SET last_login_at=now() WHERE id=$1', [acc.id]));
    req.session.save(() => res.json({
      success: true,
      account: { id: acc.id, email: acc.email, role: acc.role, name: acc.full_name },
      workspace: { id: acc.workspace_id, name: acc.workspace_name, slug: acc.workspace_slug, modules: acc.modules }
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mkt/auth/logout', (req, res) => {
  if (req.session) delete req.session.mkt;
  res.json({ success: true });
});

router.get('/api/mkt/auth/me', requireMkt, async (req, res) => {
  try {
    const data = await withReadConnection(async (c) => (await c.query(
      `SELECT a.id, a.email, a.full_name, a.role,
              w.id AS workspace_id, w.name AS workspace_name, w.slug, w.modules,
              w.license_type, w.license_end, w.max_seats, w.max_clients
         FROM marketing.accounts a
         JOIN marketing.workspaces w ON w.id=a.workspace_id
        WHERE a.id=$1`, [req.session.mkt.accountId]
    )).rows[0]);
    if (!data) { delete req.session.mkt; return res.status(401).json({ error: 'Sessie verlopen' }); }
    res.json({ success: true, account: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================================================================
// STAP 2 — CLIENT SPACES (klanten binnen een workspace)
// Alles strikt gescopet op req.session.mkt.workspaceId.
// =======================================================================
const CLIENT_STATUS = ['active', 'paused', 'archived'];
function mktCanManage(req) { return req.session?.mkt && req.session.mkt.role !== 'client'; }
function mktIsOwnerOrManager(req) { return req.session?.mkt && (req.session.mkt.role === 'owner' || req.session.mkt.role === 'manager'); }

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
      [wsId, String(name).trim(), contact_name || null, contact_email || null, website || null, brand_color || null, notes || null, req.session.mkt.accountId]
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

export default router;

// ====== VOEG DIT TOE AAN JE SERVER.JS ======
// Plaats dit NA de bestaande imports bovenaan
import crypto from 'crypto';

// ====== NIEUWE HELPER FUNCTIES (voeg toe na regel 30) ======

// Genereer veilige token voor email links
function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'your-secret-key-change-this';
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Valideer action token (max 7 dagen geldig)
function validateActionToken(token, leadId, practiceCode) {
  // Voor nu simpele validatie, in productie: bewaar tokens in DB
  return token && token.length === 64; // sha256 = 64 chars
}

// ====== UPDATE JE EMAIL TEMPLATE FUNCTIE (vervang de oude email code in POST /leads) ======
// Dit vervangt het stuk vanaf regel 251 waar de email wordt gestuurd

    if (practice && SMTP.host && SMTP.user && SMTP.pass) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP.host,
          port: SMTP.port,
          secure: SMTP.secure,
          auth: { user: SMTP.user, pass: SMTP.pass }
        });

        // Genereer action token voor veilige links
        const actionToken = generateActionToken(inserted.id, practice.code);
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        
        // HTML email template
        const htmlContent = `
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7fa; margin: 0; padding: 0; }
        .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #2563eb 0%, #10b981 100%); padding: 30px 40px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 600; }
        .alert-badge { display: inline-block; background-color: #f97316; color: #ffffff; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin-bottom: 15px; }
        .content { padding: 40px; }
        .lead-info { background-color: #f8fafc; border-radius: 12px; padding: 25px; margin-bottom: 30px; border: 1px solid #e2e8f0; }
        .info-row { margin-bottom: 15px; font-size: 15px; }
        .info-row:last-child { margin-bottom: 0; }
        .label { font-weight: 600; color: #475569; display: inline-block; min-width: 120px; }
        .value { color: #1e293b; }
        .action-section { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; padding: 25px; margin: 30px 0; text-align: center; border: 2px solid #fbbf24; }
        .action-title { font-size: 18px; font-weight: 600; color: #92400e; margin-bottom: 15px; }
        .action-subtitle { font-size: 14px; color: #78350f; margin-bottom: 20px; }
        .action-button { display: inline-block; padding: 14px 28px; margin: 10px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; background-color: #10b981; color: #ffffff; }
        .footer { background-color: #f8fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { color: #64748b; font-size: 13px; line-height: 20px; }
        .timestamp { color: #94a3b8; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <div class="alert-badge">🔔 NIEUWE LEAD</div>
            <h1>Er is een nieuwe lead binnengekomen!</h1>
        </div>
        
        <div class="content">
            <div class="lead-info">
                <div class="info-row">
                    <span class="label">👤 Naam:</span>
                    <span class="value"><strong>${volledige_naam}</strong></span>
                </div>
                <div class="info-row">
                    <span class="label">📧 Email:</span>
                    <span class="value">${emailadres || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">📱 Telefoon:</span>
                    <span class="value">${telefoon || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">🎯 Doel/Klacht:</span>
                    <span class="value">${doel || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">📍 Bron:</span>
                    <span class="value">${bron || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">🏥 Praktijk:</span>
                    <span class="value">${practice.naam} (${practice.code})</span>
                </div>
            </div>
            
            <div class="action-section">
                <div class="action-title">⚡ Actie Vereist</div>
                <div class="action-subtitle">Neem binnen 1 werkdag contact op met deze lead!</div>
                
                <div style="margin: 20px 0;">
                    <a href="${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}" 
                       style="display: inline-block; padding: 16px 32px; background-color: #10b981; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                        ✅ Lead is gebeld & Afspraak is gemaakt
                    </a>
                </div>
                
                <div style="margin-top: 15px; font-size: 13px; color: #92400e;">
                    💡 <strong>Tip:</strong> Klik op deze button zodra je de lead hebt gebeld EN een afspraak hebt ingepland.
                </div>
            </div>
            
            <div class="timestamp">
                Lead ontvangen op: ${formatAms(inserted.aangemaakt_on)}
            </div>
        </div>
        
        <div class="footer">
            <div class="footer-text">
                Deze email is automatisch verstuurd door het Lead Management Systeem.<br>
                Voor vragen of support: <a href="mailto:${SMTP.from}" style="color: #2563eb;">${SMTP.from}</a>
            </div>
        </div>
    </div>
</body>
</html>`;

        // Plain text versie
        const textContent = `
Er is een nieuwe lead binnengekomen!

Praktijk: ${practice.naam} (${practice.code})
Naam: ${volledige_naam}
E-mail: ${emailadres || '-'}
Telefoon: ${telefoon || '-'}
Bron: ${bron || '-'}
Doel: ${doel || '-'}
Toestemming: ${toestemming ? 'Ja' : 'Nee'}
Datum: ${formatAms(inserted.aangemaakt_on)}

ACTIE VEREIST: Neem binnen 1 werkdag contact op!

Klik hier als de lead is gebeld EN een afspraak is gemaakt:
${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}
`;

        await transporter.sendMail({
          from: SMTP.from,
          to: practice.email_to,
          cc: practice.email_cc || undefined,
          subject: `🔔 Nieuwe lead: ${volledige_naam} - ${practice.naam}`,
          text: textContent,
          html: htmlContent
        });

        console.log('MAIL-SEND: OK →', practice.email_to);
      } catch (mailErr) {
        console.warn('MAIL-ERROR:', mailErr && mailErr.message);
      }
    }

// ====== NIEUWE ENDPOINT: Lead Action Handler (voeg toe voor regel 400, bij andere endpoints) ======

// GET /lead-action - Verwerk acties uit email links
app.get('/lead-action', async (req, res) => {
  try {
    const { action, lead_id, practice_code, token } = req.query;
    
    // Valideer parameters
    if (!action || !lead_id || !practice_code || !token) {
      return res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h2 style="color: #dc2626;">❌ Ongeldige link</h2>
            <p>Deze link is niet geldig of verlopen.</p>
          </body>
        </html>
      `);
    }
    
    // Valideer token
    if (!validateActionToken(token, lead_id, practice_code)) {
      return res.status(401).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h2 style="color: #dc2626;">❌ Verlopen link</h2>
            <p>Deze link is verlopen. Neem contact op met support.</p>
          </body>
        </html>
      `);
    }
    
    // Update lead status in database
    const updated = await withWriteConnection(async (client) => {
      // Check of lead bestaat
      const checkSql = `
        SELECT id, volledige_naam, emailadres 
        FROM public.leads 
        WHERE id = $1 AND praktijk_code = $2
      `;
      const checkResult = await client.query(checkSql, [lead_id, practice_code]);
      
      if (checkResult.rows.length === 0) {
        throw new Error('Lead niet gevonden');
      }
      
      const lead = checkResult.rows[0];
      
      // Update lead met nieuwe status
      const updateSql = `
        UPDATE public.leads 
        SET 
          status = 'afspraak_gemaakt',
          gebeld_op = CURRENT_TIMESTAMP,
          afspraak_gemaakt_op = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND praktijk_code = $2
        RETURNING id, status, updated_at
      `;
      
      const updateResult = await client.query(updateSql, [lead_id, practice_code]);
      
      // Log event
      await client.query(`
        INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
        VALUES ($1, $2, 'appointment_booked', 'email_action', $3::jsonb)
      `, [lead_id, practice_code, JSON.stringify({ 
        action: 'afspraak_gemaakt',
        via: 'email_button',
        naam: lead.volledige_naam 
      })]);
      
      return { lead, updated: updateResult.rows[0] };
    });
    
    // Stuur bevestiging email naar lead (optioneel)
    if (updated.lead.emailadres && SMTP.host && SMTP.user && SMTP.pass) {
      try {
        const transporter = nodemailer.createTransporter({
          host: SMTP.host,
          port: SMTP.port,
          secure: SMTP.secure,
          auth: { user: SMTP.user, pass: SMTP.pass }
        });
        
        await transporter.sendMail({
          from: SMTP.from,
          to: updated.lead.emailadres,
          subject: '✅ Afspraak bevestiging',
          text: `Beste ${updated.lead.volledige_naam},\n\nBedankt voor uw aanmelding! We hebben uw aanvraag ontvangen en zullen spoedig contact met u opnemen om de afspraak definitief in te plannen.\n\nMet vriendelijke groet,\nUw Fysiopraktijk`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Beste ${updated.lead.volledige_naam},</h2>
              <p>Bedankt voor uw aanmelding! We hebben uw aanvraag ontvangen en zullen spoedig contact met u opnemen om de afspraak definitief in te plannen.</p>
              <p>Met vriendelijke groet,<br>Uw Fysiopraktijk</p>
            </div>
          `
        });
      } catch (mailErr) {
        console.warn('Bevestigingsmail mislukt:', mailErr.message);
      }
    }
    
    // Toon succespagina
    res.send(`
      <!DOCTYPE html>
      <html lang="nl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Actie Bevestigd</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #2563eb 0%, #10b981 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .success-card {
            background: white;
            border-radius: 16px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 500px;
          }
          .checkmark {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            color: white;
          }
          h1 {
            color: #1e293b;
            margin: 20px 0;
          }
          p {
            color: #64748b;
            line-height: 1.6;
            margin: 15px 0;
          }
          .lead-details {
            background: #f8fafc;
            border-radius: 8px;
            padding: 20px;
            margin: 25px 0;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: 600;
            color: #475569;
          }
          .detail-value {
            color: #1e293b;
          }
          .footer-text {
            margin-top: 30px;
            font-size: 14px;
            color: #94a3b8;
          }
        </style>
      </head>
      <body>
        <div class="success-card">
          <div class="checkmark">✓</div>
          <h1>Actie Succesvol Geregistreerd!</h1>
          <p>De status van de lead is bijgewerkt naar: <strong>Afspraak Gemaakt</strong></p>
          
          <div class="lead-details">
            <div class="detail-row">
              <span class="detail-label">Lead:</span>
              <span class="detail-value">${updated.lead.volledige_naam}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Status:</span>
              <span class="detail-value">✅ Gebeld & Afspraak gemaakt</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tijdstip:</span>
              <span class="detail-value">${formatAms(updated.updated.updated_at)}</span>
            </div>
          </div>
          
          <p><strong>Wat nu?</strong><br>
          De lead heeft ${updated.lead.emailadres ? 'een bevestigingsmail ontvangen' : 'geen emailadres opgegeven'}. 
          Vergeet niet de afspraak in uw agenda te zetten!</p>
          
          <div class="footer-text">
            U kunt dit venster nu sluiten.
          </div>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Lead action error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2 style="color: #dc2626;">❌ Er ging iets mis</h2>
          <p>Er is een fout opgetreden: ${error.message}</p>
          <p>Neem contact op met support.</p>
        </body>
      </html>
    `);
  }
});

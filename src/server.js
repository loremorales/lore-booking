require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Base de datos ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── Inicializar tablas ────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(200) NOT NULL,
      email VARCHAR(200) NOT NULL,
      telefono VARCHAR(50),
      paquete VARCHAR(100) NOT NULL,
      precio VARCHAR(50) NOT NULL,
      duracion INTEGER NOT NULL,
      fecha DATE NOT NULL,
      hora TIME NOT NULL,
      notas TEXT,
      estado VARCHAR(20) DEFAULT 'pendiente',
      creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dias_bloqueados (
      id SERIAL PRIMARY KEY,
      fecha DATE NOT NULL UNIQUE,
      motivo VARCHAR(200),
      creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS horas_bloqueadas (
      id SERIAL PRIMARY KEY,
      fecha DATE NOT NULL,
      hora TIME NOT NULL,
      motivo VARCHAR(200),
      UNIQUE(fecha, hora)
    );
  `);
  console.log('✓ Base de datos lista');
}

// ── Nodemailer ────────────────────────────────────────────────


// ── RUTAS API ─────────────────────────────────────────────────

// GET /api/disponibilidad?fecha=2026-03-21
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

  try {
    // Verificar si el día está bloqueado
    const diaBloqueado = await pool.query(
      'SELECT id FROM dias_bloqueados WHERE fecha = $1', [fecha]
    );
    if (diaBloqueado.rows.length > 0) {
      return res.json({ disponible: false, horasOcupadas: [] });
    }

    // Obtener horas ocupadas (reservas confirmadas + horas bloqueadas)
    const reservas = await pool.query(
      `SELECT hora::text FROM reservas WHERE fecha = $1 AND estado != 'cancelada'`, [fecha]
    );
    const horasBloqueadas = await pool.query(
      'SELECT hora::text FROM horas_bloqueadas WHERE fecha = $1', [fecha]
    );

    const ocupadas = [
      ...reservas.rows.map(r => r.hora.substring(0, 5)),
      ...horasBloqueadas.rows.map(r => r.hora.substring(0, 5))
    ];

    res.json({ disponible: true, horasOcupadas: ocupadas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar disponibilidad' });
  }
});

// POST /api/reservas — crear nueva reserva
app.post('/api/reservas', async (req, res) => {
  const { nombre, email, telefono, paquete, precio, duracion, fecha, hora, notas } = req.body;

  if (!nombre || !email || !paquete || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  try {
    // Verificar disponibilidad antes de guardar
    const conflicto = await pool.query(
      `SELECT id FROM reservas WHERE fecha = $1 AND hora = $2 AND estado != 'cancelada'`,
      [fecha, hora]
    );
    if (conflicto.rows.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya no está disponible' });
    }

    const diaBloqueado = await pool.query(
      'SELECT id FROM dias_bloqueados WHERE fecha = $1', [fecha]
    );
    if (diaBloqueado.rows.length > 0) {
      return res.status(409).json({ error: 'Ese día no está disponible' });
    }

    // Guardar reserva
    const result = await pool.query(
      `INSERT INTO reservas (nombre, email, telefono, paquete, precio, duracion, fecha, hora, notas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [nombre, email, telefono || '', paquete, precio, duracion, fecha, hora, notas || '']
    );

    const reservaId = result.rows[0].id;

    // Construir link de Google Calendar
    const [hh, mm] = hora.split(':');
    const startDate = new Date(`${fecha}T${hora}:00`);
    const endDate = new Date(startDate.getTime() + duracion * 60000);
    const pad = n => String(n).padStart(2, '0');
    const gcalDate = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE`
      + `&text=${encodeURIComponent('📸 ' + nombre + ' — ' + paquete)}`
      + `&dates=${gcalDate(startDate)}/${gcalDate(endDate)}`
      + `&details=${encodeURIComponent('Paquete: ' + paquete + ' ' + precio + '\nCliente: ' + nombre + '\nEmail: ' + email + '\nTeléfono: ' + (telefono||'N/A') + '\n\n⚠️ Anticipo pendiente: $900')}`
      + `&location=${encodeURIComponent('Navojoa, Sonora')}`;

    // Formatear fecha para el correo
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const fechaObj = new Date(fecha + 'T12:00:00');
    const fechaStr = `${dias[fechaObj.getDay()]} ${fechaObj.getDate()} de ${meses[fechaObj.getMonth()]} ${fechaObj.getFullYear()}`;

    // ── Notificar a Google Sheets ─────────────────────────────
    try {
      await fetch(process.env.SHEETS_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservaId, nombre, email, telefono, paquete, precio, fecha, hora, notas })
      });
      console.log(`✓ Google Sheets notificado para reserva #${reservaId}`);
    } catch(sheetsErr) {
      console.error('⚠️ Google Sheets error:', sheetsErr.message);
    }

    // ── Notificar por WhatsApp (Callmebot) ────────────────────
    try {
      const waMsg = encodeURIComponent(`📸 Nueva reserva #${reservaId}\n👤 ${nombre}\n📦 ${paquete} ${precio}\n📅 ${fechaStr} · ${hora}\n📧 ${email}\n📱 ${telefono||'N/A'}`);
      await fetch(`https://api.callmebot.com/whatsapp.php?phone=${process.env.WA_PHONE}&text=${waMsg}&apikey=${process.env.WA_APIKEY}`);
      console.log(`✓ WhatsApp notificado para reserva #${reservaId}`);
    } catch(waErr) {
      console.error('⚠️ WhatsApp error:', waErr.message);
    }

    // Intentar enviar correo (no bloquea la reserva si falla)
    try {
      await resend.emails.send({
        from: 'Lore Morales Booking <onboarding@resend.dev>',
        to: process.env.SMTP_USER,
        reply_to: email,
        subject: `Nueva reserva #${reservaId}: ${paquete} — ${nombre} — ${fechaStr}`,
        html: `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f3f0;font-family:Georgia,serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f0;padding:40px 20px;">
            <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden;">
              <tr><td style="background:#1a1a18;padding:32px 40px;text-align:center;">
                <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#888;margin-bottom:10px;font-family:Arial,sans-serif;">Nueva solicitud de reserva #${reservaId}</div>
                <div style="font-size:28px;color:#fff;letter-spacing:0.06em;">LORE MORALES</div>
              </td></tr>
              <tr><td style="background:#f9f7f4;padding:24px 40px;text-align:center;border-bottom:1px solid #ede9e3;">
                <div style="font-size:22px;color:#1a1a18;">${fechaStr}</div>
                <div style="font-size:15px;color:#555;margin-top:4px;font-family:Arial,sans-serif;">${hora} hrs · ${paquete} · ${precio}</div>
              </td></tr>
              <tr><td style="padding:20px 40px;">
                <div style="font-family:Arial,sans-serif;font-size:13px;line-height:2;color:#1a1a18;">
                  <b>Cliente:</b> ${nombre}<br>
                  <b>Email:</b> ${email}<br>
                  <b>Teléfono:</b> ${telefono||'No proporcionado'}<br>
                  ${notas ? `<b>Notas:</b> ${notas}` : ''}
                </div>
              </td></tr>
              <tr><td style="padding:0 40px 20px;">
                <a href="${gcalUrl}" style="display:inline-block;padding:10px 20px;border:1px solid #4285F4;border-radius:6px;text-decoration:none;color:#1a73e8;font-size:13px;font-family:Arial,sans-serif;">+ Agregar al calendario</a>
              </td></tr>
            </table>
            </td></tr>
          </table>
          </body></html>`
      });
      console.log(`✓ Correo enviado para reserva #${reservaId}`);
    } catch(emailErr) {
      console.error(`⚠️ Correo no enviado para reserva #${reservaId}:`, emailErr.message);
      // La reserva YA está guardada — solo falló el correo
    }

    res.json({ ok: true, reservaId, gcalUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la reserva' });
  }
});

// ── RUTAS ADMIN ───────────────────────────────────────────────

// Middleware de autenticación admin
function authAdmin(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// GET /api/admin/reservas
app.get('/api/admin/reservas', authAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM reservas ORDER BY fecha DESC, hora DESC'
  );
  res.json(result.rows);
});

// PATCH /api/admin/reservas/:id — cambiar estado
app.patch('/api/admin/reservas/:id', authAdmin, async (req, res) => {
  const { estado } = req.body;
  await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  res.json({ ok: true });
});

// GET /api/admin/bloqueados
app.get('/api/admin/bloqueados', authAdmin, async (req, res) => {
  const dias = await pool.query('SELECT * FROM dias_bloqueados ORDER BY fecha');
  const horas = await pool.query('SELECT * FROM horas_bloqueadas ORDER BY fecha, hora');
  res.json({ dias: dias.rows, horas: horas.rows });
});

// POST /api/admin/bloquear-dia
app.post('/api/admin/bloquear-dia', authAdmin, async (req, res) => {
  const { fecha, motivo } = req.body;
  await pool.query(
    'INSERT INTO dias_bloqueados (fecha, motivo) VALUES ($1, $2) ON CONFLICT (fecha) DO NOTHING',
    [fecha, motivo || '']
  );
  res.json({ ok: true });
});

// DELETE /api/admin/bloquear-dia/:fecha
app.delete('/api/admin/bloquear-dia/:fecha', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM dias_bloqueados WHERE fecha = $1', [req.params.fecha]);
  res.json({ ok: true });
});

// POST /api/admin/bloquear-hora
app.post('/api/admin/bloquear-hora', authAdmin, async (req, res) => {
  const { fecha, hora, motivo } = req.body;
  await pool.query(
    'INSERT INTO horas_bloqueadas (fecha, hora, motivo) VALUES ($1, $2, $3) ON CONFLICT (fecha, hora) DO NOTHING',
    [fecha, hora, motivo || '']
  );
  res.json({ ok: true });
});

// DELETE /api/admin/bloquear-hora
app.delete('/api/admin/bloquear-hora', authAdmin, async (req, res) => {
  const { fecha, hora } = req.body;
  await pool.query('DELETE FROM horas_bloqueadas WHERE fecha = $1 AND hora = $2', [fecha, hora]);
  res.json({ ok: true });
});

// Servir frontend para cualquier ruta no API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Iniciar servidor ──────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✓ Servidor corriendo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});

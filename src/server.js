require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
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
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

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

    // Enviar correo de notificación
    await transporter.sendMail({
      from: `"Lore Morales Booking" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      replyTo: email,
      subject: `Nueva reserva #${reservaId}: ${paquete} — ${nombre} — ${fechaStr}`,
      html: `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f3f0;font-family:Georgia,serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f0;padding:40px 20px;">
          <tr><td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden;">
            <tr><td style="background:#1a1a18;padding:32px 40px;text-align:center;">
              <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#888;margin-bottom:10px;font-family:Arial,sans-serif;">Nueva solicitud de reserva #${reservaId}</div>
              <div style="font-size:28px;color:#fff;letter-spacing:0.06em;">LORE MORALES</div>
              <div style="font-size:10px;letter-spacing:0.14em;color:#888;margin-top:4px;font-family:Arial,sans-serif;text-transform:uppercase;">Fotografía & Diseño</div>
            </td></tr>
            <tr><td style="background:#f9f7f4;padding:24px 40px;text-align:center;border-bottom:1px solid #ede9e3;">
              <div style="font-size:10px;color:#a89880;letter-spacing:0.12em;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:6px;">Fecha solicitada</div>
              <div style="font-size:22px;color:#1a1a18;">${fechaStr}</div>
              <div style="font-size:15px;color:#555;margin-top:4px;font-family:Arial,sans-serif;">${hora} hrs</div>
            </td></tr>
            <tr><td style="padding:24px 40px 0;">
              <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89880;font-family:Arial,sans-serif;margin-bottom:12px;">Paquete</div>
              <table width="100%" style="background:#f9f7f4;border-radius:6px;border:1px solid #ede9e3;">
                <tr>
                  <td style="padding:14px 18px;"><div style="font-size:17px;color:#1a1a18;">${paquete}</div><div style="font-size:12px;color:#888;font-family:Arial,sans-serif;margin-top:2px;">${duracion} min</div></td>
                  <td style="padding:14px 18px;text-align:right;"><div style="font-size:22px;color:#1a1a18;">${precio}</div></td>
                </tr>
              </table>
            </td></tr>
            <tr><td style="padding:20px 40px 0;">
              <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89880;font-family:Arial,sans-serif;margin-bottom:10px;">Cliente</div>
              <table width="100%">
                <tr><td style="padding:6px 0;border-bottom:1px solid #f0ece6;font-size:11px;color:#a89880;font-family:Arial,sans-serif;text-transform:uppercase;">Nombre</td><td style="padding:6px 0;border-bottom:1px solid #f0ece6;text-align:right;font-size:13px;font-family:Arial,sans-serif;">${nombre}</td></tr>
                <tr><td style="padding:6px 0;border-bottom:1px solid #f0ece6;font-size:11px;color:#a89880;font-family:Arial,sans-serif;text-transform:uppercase;">Email</td><td style="padding:6px 0;border-bottom:1px solid #f0ece6;text-align:right;font-size:13px;font-family:Arial,sans-serif;">${email}</td></tr>
                <tr><td style="padding:6px 0;border-bottom:1px solid #f0ece6;font-size:11px;color:#a89880;font-family:Arial,sans-serif;text-transform:uppercase;">Teléfono</td><td style="padding:6px 0;border-bottom:1px solid #f0ece6;text-align:right;font-size:13px;font-family:Arial,sans-serif;">${telefono||'No proporcionado'}</td></tr>
                ${notas ? `<tr><td style="padding:6px 0;font-size:11px;color:#a89880;font-family:Arial,sans-serif;text-transform:uppercase;">Notas</td><td style="padding:6px 0;text-align:right;font-size:13px;font-family:Arial,sans-serif;">${notas}</td></tr>` : ''}
              </table>
            </td></tr>
            <tr><td style="padding:20px 40px 0;">
              <table width="100%" style="background:#fdf8f0;border:1px solid #e8d9be;border-radius:6px;">
                <tr><td style="padding:14px 18px;">
                  <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#a08060;font-family:Arial,sans-serif;margin-bottom:4px;">Anticipo requerido</div>
                  <div style="font-size:20px;color:#4a3d28;">$900</div>
                  <div style="font-size:11px;color:#7a6040;font-family:Arial,sans-serif;margin-top:4px;line-height:1.7;">Santander · Lorena Morales Ramonet<br>CLABE: 014777260118637686<br>Tarjeta: 5579 0900 4168 1520</div>
                </td></tr>
              </table>
            </td></tr>
            <tr><td style="padding:20px 40px;">
              <a href="${gcalUrl}" style="display:inline-block;padding:10px 20px;border:1px solid #4285F4;border-radius:6px;text-decoration:none;color:#1a73e8;font-size:13px;font-family:Arial,sans-serif;">+ Agregar al calendario</a>
            </td></tr>
            <tr><td style="background:#f9f7f4;border-top:1px solid #ede9e3;padding:16px 40px;text-align:center;">
              <div style="font-size:11px;color:#b8b4ae;font-family:Arial,sans-serif;">loremoralesfoto@gmail.com · WhatsApp 64 44 30 89 57</div>
            </td></tr>
          </table>
          </td></tr>
        </table>
        </body></html>
      `
    });

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

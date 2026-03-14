# Lore Morales — Sistema de Reservas

## Estructura
```
lore-booking/
├── public/
│   └── index.html       ← Frontend (página de reservas)
├── src/
│   └── server.js        ← Backend (API + servidor)
├── .env.example         ← Variables de entorno de ejemplo
├── .gitignore
└── package.json
```

## Variables de entorno necesarias en Railway
```
DATABASE_URL        → Railway lo agrega automáticamente al crear la BD
SMTP_USER           → loremoralesfoto@gmail.com
SMTP_PASS           → Contraseña de aplicación de Gmail
ADMIN_PASSWORD      → Contraseña del panel admin
```

## Cómo obtener SMTP_PASS (contraseña de aplicación Gmail)
1. Ve a myaccount.google.com
2. Seguridad → Verificación en dos pasos (actívala si no está)
3. Seguridad → Contraseñas de aplicaciones
4. Selecciona "Correo" y "Otro" → escribe "Lore Booking"
5. Copia la contraseña de 16 caracteres generada

## API Endpoints
- GET  /api/disponibilidad?fecha=YYYY-MM-DD
- POST /api/reservas
- GET  /api/admin/reservas  (requiere header x-admin-password)
- POST /api/admin/bloquear-dia
- DELETE /api/admin/bloquear-dia/:fecha
- POST /api/admin/bloquear-hora
- DELETE /api/admin/bloquear-hora

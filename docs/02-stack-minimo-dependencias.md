# 02 — Stack con mínimo uso de dependencias

## 1. Principio rector

> **Cada dependencia debe ser insustituible o eliminar riesgo real.** Todo lo demás se resuelve con
> la librería estándar de Node (disponible desde Node 18/22): `crypto`, `fetch`, `node:test`,
> `node:fs`, `node:path`, `Intl`, `setInterval`. Esto se documenta en el README como decisión de
> arquitectura y reduce el tiempo de instalación, revisión y explicación.

## 2. Tabla de decisiones

| Necesidad | Decisión | Dependencias | Justificación / alternativa descartada |
|---|---|---|---|
| HTTP y rutas | **Express** | `express` | Único framework. `node:http` puro obligaría a reimplementar body parsing, cookies y manejo de errores (más riesgo y más código que mantener); Fastify no aporta lo suficiente aquí. |
| Base de datos | **`pg` + SQL crudo** | `pg` | Insustituible. Sin ORM (Prisma/Knex/TypeORM): la Parte 3 premia el SQL a mano y un ORM añade genera­ción, config y curva. |
| Validación (entradas **y salida de la IA**) | **zod** | `zod` | El examen exige validar la respuesta del modelo **contra un esquema**; el mismo esquema valida todos los endpoints. Alternativa: validadores a mano → riesgo de olvidos y código repetitivo. |
| Migraciones versionadas | Archivos `.sql` numerados + runner propio (~50 líneas con `fs` + `pg`) | 0 | Cumple "migraciones versionadas" sin ORM. Tabla `schema_migrations` con hash/nombre único. |
| Pruebas | **`node --test`** (runner integrado) | 0 | Sin Jest/Vitest/Mocha. TS: se compila con `tsc` y se testea el output, o se usa `tsx` como única dev-dependencia de ejecución. |
| Autenticación y sesiones | Cookie firmada **HMAC** + hash de contraseña **scrypt** con `node:crypto` | 0 | Sin Passport, sin jsonwebtoken, sin bcrypt. Dos usuarios sembrados no justifican esa superficie. |
| Procesos asíncronos / cola | **Outbox en PostgreSQL** + worker con `setInterval` y `SELECT … FOR UPDATE SKIP LOCKED` | 0 | Sin Redis/BullMQ/Agenda. Persiste entre reinicios, es observable en BD y demuestra el patrón real. |
| Envío de correos (captura local) | Interfaz `EmailSender` con implementación local que **persiste el correo en la BD** (visible en el admin) | 0 (sin nodemailer) | Intercambiable por SES/Resend/SMTP cambiando **un archivo** (open/closed). |
| Fechas, horas y zona horaria | API **`Intl`** + cálculo propio, timezone explícita `America/Bogota` | 0 | Sin dayjs/date-fns/moment. |
| Llamada a la IA | **`fetch` nativo** a la API de OpenCode Go (OpenAI-compatible) | 0 (sin SDK de IA) | Clave y endpoint en `.env`; verificado con llamada real (HTTP 200). Ver archivo 03, sección 6. |
| Frontend | **React + Vite + react-router-dom**, `fetch` nativo, CSS plano escrito a mano | 4 | Sin Redux/Zustand/TanStack Query/axios/Tailwind/MUI. Estado local + contexto de React alcanza. |
| Monorepo | **npm workspaces** (integrado en npm) | 0 | Sin Nx/Turbo/lerna. |
| Lint / formato | `tsc --noEmit` estricto como red de seguridad; ESLint/Prettier **solo** si sobra tiempo | 0 (opcional) | El examen no lo pide; el `tsconfig` estricto + tests cubren lo esencial. |

## 3. Inventario final de dependencias

**Runtime (production):**
```
express        # HTTP
pg             # driver PostgreSQL
zod            # validación de entradas y de la salida de la IA
react, react-dom, react-router-dom   # frontend
```
**Desarrollo (devDependencies):**
```
typescript
vite, @vitejs/plugin-react
tsx            # (opcional) ejecutar TS en dev/test sin compilación previa
@types/express, @types/pg, @types/node, @types/react, @types/react-dom
```

**Explícitamente fuera (y por qué — va en el README):**
Prisma/TypeORM/Knex (ORM/query builders), Jest/Vitest (usamos `node:test`), Passport/jsonwebtoken/bcrypt
(auth manual con `crypto`), BullMQ/Redis/Agenda (outbox en Postgres), nodemailer (captura local en BD),
dayjs/date-fns (`Intl`), axios (fetch), Redux/Zustand/TanStack (estado local de React), Tailwind/MUI/
Bootstrap (CSS plano), supertest (fetch contra servidor real en efímero), Swagger (README).

## 4. Estructura del repositorio

```
/
├── README.md                 # cómo correr, decisiones, alcance, Uso de IA, ambigüedades
├── INCIDENTE.md              # Parte 4 (máx. 2 páginas)
├── consultas.sql             # Parte 3 (5 consultas comentadas)
├── AGENTS.md                 # instrucciones del proyecto para la asistente de IA
├── package.json              # npm workspaces: server + web
├── .env.example              # DATABASE_URL, AI_BASE_URL, AI_API_KEY, AI_MODEL, SESSION_SECRET, TZ
├── db/
│   ├── migrations/0001_init.sql, 0002_....sql
│   └── seed.sql              # 2 usuarios (cliente/admin) + 3 salas
├── server/
│   ├── src/
│   │   ├── index.ts          # arranque
│   │   ├── app.ts            # composición: rutas + middleware + error handler
│   │   ├── config.ts         # lectura y validación de env con zod
│   │   ├── core/             # abstracciones compartidas: db, clock, errores HTTP, ids
│   │   ├── modules/
│   │   │   ├── quotes/       # quote.ts (lógica PURA), service.ts, routes.ts, quote.test.ts
│   │   │   ├── bookings/     # state.ts (máquina de estados), service.ts, routes.ts, tests
│   │   │   ├── auth/         # password.ts, session.ts, routes.ts
│   │   │   ├── admin/        # rutas de listado/filtros + bandeja de correos
│   │   │   ├── email/        # outboxRepo.ts, worker.ts, sender.ts (EmailSender), templates
│   │   │   └── chat/         # prompt.md, schema.ts (zod), dateResolver.ts, aiClient.ts, service.ts
│   │   └── db/               # pool.ts, migrate.ts (runner)
│   └── test/                 # tests de integración (fetch contra servidor real)
└── web/
    └── src/
        ├── main.tsx, App.tsx (layout + router)
        ├── styles/           # tokens.css + global.css
        ├── lib/api.ts        # cliente fetch tipado (único punto de red)
        ├── components/       # Button, Input, Card, Table, StatusBadge, Stepper…
        └── pages/            # Quote, BookingWizard, Chat, Admin, Login
```

**Regla de organización = S (responsabilidad única) por carpeta:** cada módulo tiene su dominio,
su repositorio (SQL), su servicio (reglas) y sus rutas (HTTP). Un módulo nunca importa el SQL de
otro módulo: pasa por su servicio.

## 5. Scripts npm

```jsonc
{
  "scripts": {
    "dev": "sh scripts/dev.sh",   // 2 procesos en background, sin dependencias de terceros
    "build": "npm run build -w server && npm run build -w web",
    "migrate": "node server/dist/db/migrate.js",
    "seed": "psql $DATABASE_URL -f db/seed.sql",
    "test": "npm run test -w server",
    "typecheck": "tsc --noEmit -p server && tsc --noEmit -p web"
  }
}
```

`scripts/dev.sh` (5 líneas, cero dependencias — la misma semántica que `concurrently`):

```sh
#!/bin/sh
# Arranca backend y frontend. Alternativa manual: dos terminales con
# `npm run dev -w server` y `npm run dev -w web`.
trap 'kill 0' EXIT INT TERM
npm run dev -w server &
npm run dev -w web &
wait
```

> Decisión: **no se usa `concurrently` ni `npm-run-all`** (dependencias que solo ahorran un `&`).
> Este script, o simplemente dos terminales, cubren el caso. El README usa este mismo comando.

## 6. Variables de entorno (`.env.example` versionado, valores reales nunca)

```
DATABASE_URL=postgresql://user:pass@localhost:5432/coworking
PORT=3000
SESSION_SECRET=<generar con: openssl rand -hex 32>
TZ=America/Bogota
# IA (OpenCode Go — verificado)
AI_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_API_KEY=oc_sk_...
AI_MODEL=glm-5.3-flash
```

## 7. Cómo se refleja SOLID en esta estructura

Principios aplicados (detalle y ejemplos concretos en `03-decisiones-tecnicas-criticas.md`, §7):
- **S** → carpetas por módulo con una sola razón de cambio (`quote.ts` calcula, `routes.ts` traduce HTTP, `worker.ts` envía).
- **O** → interfaces `EmailSender`, `AiClient`, `Clock` y registro de acciones del chat: se añade un proveedor/acción sin tocar el código que lo invoca.
- **L** → toda implementación de `EmailSender` cumple el mismo contrato (misma semántica de éxito/fallo) → intercambiables sin sorpresas.
- **I** → interfaces pequeñas: `ChatRepository` (guardar/recuperar) ≠ `AiClient` (llamar al modelo) ≠ `Clock` (tiempo).
- **D** → **inyección manual de dependencias** en los constructores/fábricas (`createWorker({ outboxRepo, sender, clock })`), sin framework DI: los tests pasan dobles en memoria.

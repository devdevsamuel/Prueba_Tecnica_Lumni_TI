# Prueba Técnica Lumni TI — Reserva de salas de coworking

App fullstack (TypeScript, React, Node, PostgreSQL) para cotizar y reservar salas de un
coworking, con panel de administración, correos en segundo plano, asistente con IA y
consultas SQL.

> **Estado:** Fase 0 implementada (esqueleto ejecutable: workspaces, migraciones, tokens y
> componentes base). Fases 1–8 pendientes.

## Documentación de análisis

Todo el análisis previo de la prueba vive en [`docs/`](docs/00-indice.md):

| Documento | Contenido |
|---|---|
| [Índice](docs/00-indice.md) | Mapa general del análisis y decisiones confirmadas |
| [01 — Evaluación y requisitos](docs/01-evaluacion-y-requisitos.md) | Qué evalúa la prueba + requisitos, reglas de negocio, casos límite, contratos API, modelo de datos y ambigüedades |
| [02 — Stack y dependencias](docs/02-stack-minimo-dependencias.md) | Stack con mínimo uso de dependencias, estructura del repositorio y variables de entorno |
| [03 — Decisiones técnicas](docs/03-decisiones-tecnicas-criticas.md) | Concurrencia, idempotencia, outbox de correos, capa de IA, SOLID y análisis del incidente |
| [04 — Plan por fases](docs/04-plan-por-fases.md) | Plan de implementación por fases, maquetación de la interfaz y criterios de corte |
| [05 — Accesibilidad](docs/05-accesibilidad.md) | Accesibilidad WCAG 2.1 AA por fase: semántica, teclado, formularios, regiones vivas, contraste y verificación |
| [06 — UI y UX limpia](docs/06-ui-ux-limpia.md) | UI minimal neutral tipo SaaS: principios, design tokens, contrato de estados, patrones UX por flujo, catálogo de componentes y verificación |

## Cómo se ejecuta (Fase 0)

```bash
cp .env.example .env        # y completar SESSION_SECRET (openssl rand -hex 32)
npm install
npm run migrate             # compila el server y aplica db/migrations/*.sql versionados
npm run seed                # 2 usuarios (cliente/admin) + 3 salas
npm run dev                 # backend y frontend a la vez (scripts/dev.sh, sin dependencias)
```

> Contraseña de desarrollo de los usuarios sembrados: `coworking2026` (hash scrypt precalculado en `db/seed.sql`; la verificación llega en la Fase 3).
> `npm run dev` usa un shell script propio de 5 líneas (ver `docs/02` §5). Alternativa manual:
> dos terminales con `npm run dev -w server` y `npm run dev -w web`.
> No usamos `concurrently` ni ningún otro empaquetador de procesos.

## Secciones pendientes

- [ ] Decisiones tomadas y ambigüedades resueltas
- [ ] Qué quedó fuera y por qué
- [ ] Uso de IA (herramienta, ejemplo corregido, qué verifiqué)
- [ ] Cómo se garantizan la concurrencia y la idempotencia
- [ ] Preparación de la sustentación (45 min): guion de demo y dudas frecuentes

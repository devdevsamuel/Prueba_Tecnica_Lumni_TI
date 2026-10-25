# Prueba Técnica Lumni TI — Reserva de salas de coworking

App fullstack (TypeScript, React, Node, PostgreSQL) para cotizar y reservar salas de un
coworking, con panel de administración, correos en segundo plano, asistente con IA y
consultas SQL.

> **Estado:** en construcción — Fase 0 del plan.

## Documentación de análisis

Todo el análisis previo de la prueba vive en [`docs/`](docs/00-indice.md):

| Documento | Contenido |
|---|---|
| [Índice](docs/00-indice.md) | Mapa general del análisis y decisiones confirmadas |
| [01 — Evaluación y requisitos](docs/01-evaluacion-y-requisitos.md) | Qué evalúa la prueba + requisitos, reglas de negocio, casos límite, contratos API, modelo de datos y ambigüedades |
| [02 — Stack y dependencias](docs/02-stack-minimo-dependencias.md) | Stack con mínimo uso de dependencias, estructura del repositorio y variables de entorno |
| [03 — Decisiones técnicas](docs/03-decisiones-tecnicas-criticas.md) | Concurrencia, idempotencia, outbox de correos, capa de IA, SOLID y análisis del incidente |
| [04 — Plan por fases](docs/04-plan-por-fases-48h.md) | Plan de implementación por fases, maquetación de la interfaz y criterios de corte |

## Cómo se ejecutará (pendiente de la Fase 0)

```bash
npm install
npm run migrate
npm run seed
npm run dev
```

## Secciones pendientes

- [ ] Decisiones tomadas y ambigüedades resueltas
- [ ] Qué quedó fuera y por qué
- [ ] Uso de IA (herramienta, ejemplo corregido, qué verifiqué)
- [ ] Cómo se garantizan la concurrencia y la idempotencia

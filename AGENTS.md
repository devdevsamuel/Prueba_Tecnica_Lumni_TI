# AGENTS.md — instrucciones del proyecto

Reserva de salas de coworking: TypeScript estricto, React + Vite, Express, PostgreSQL.
**Estado: ~90 % — fases 0, 1, 2, 3, 7, 6, 4, 5 y 5b implementadas** (Parte 1 completa, incidente,
consultas SQL, correo en segundo plano, chat con IA y control de uso/trazabilidad de tokens).
Pendiente: 8 — cierre. Este archivo
solo contiene reglas de trabajo; los requisitos, la arquitectura y los pasos ya están documentados
abajo, no se repiten aquí.

## De dónde sale cada requisito

| Tema | Documento |
|---|---|
| Requisitos, reglas de negocio, casos límite, contratos de API, ambigüedades decididas (§14) | [`docs/01-evaluacion-y-requisitos.md`](docs/01-evaluacion-y-requisitos.md) |
| Decisiones técnicas: concurrencia, idempotencia, outbox, capa de IA, SOLID, incidente | [`docs/03-decisiones-tecnicas-criticas.md`](docs/03-decisiones-tecnicas-criticas.md) |
| Stack, dependencias permitidas, estructura de carpetas y scripts | [`docs/02-stack-minimo-dependencias.md`](docs/02-stack-minimo-dependencias.md) |
| Qué hacer ahora: fases, orden de ejecución y criterios de "hecho" | [`docs/04-plan-por-fases.md`](docs/04-plan-por-fases.md) |
| Accesibilidad WCAG 2.1 AA | [`docs/05-accesibilidad.md`](docs/05-accesibilidad.md) |
| UI/UX: tokens, componentes, contrato de estados | [`docs/06-ui-ux-limpia.md`](docs/06-ui-ux-limpia.md) |
| Mapa del análisis, checklist de auditoría y veredictos | [`docs/00-indice.md`](docs/00-indice.md) |
| Pendientes abiertos y recomendaciones | [`docs/AUDITORIA-adversarial.md`](docs/AUDITORIA-adversarial.md) |

Fuente de verdad de los requisitos: el PDF `Prueba_tecnica_Lumni_TI_F.pdf` (leído completo;
resumido en `docs/01`).

## Reglas de trabajo

1. **No inventar requisitos.** Si algo no está en `docs/01` ni en el PDF, se pregunta antes de
   implementarlo. Las ambigüedades ya resueltas están en `01` §14.
2. **Explicar brevemente las decisiones técnicas importantes** (2–4 líneas): qué se decide, por qué
   y qué alternativa se descarta.
3. **Validar antes de dar una tarea por hecha:** `npm run typecheck` · `npm run test` ·
   `npm run migrate` desde cero (y `npm run dev` cuando toque verificar UI).
4. **Mínimo de dependencias** (`02` §1–3): no se añade ninguna sin justificarla en `02`.
5. **Seguir el plan por fases:** respetar el orden `0→1→2→3→7→6→4→5→8` y el criterio de "hecho"
   de cada fase en `04`; no adelantar funcionalidad de fases posteriores.
6. **TypeScript estricto** (`strict`, `noUncheckedIndexedAccess`), sin `any` evitables.
7. **Commits pequeños y descriptivos**, solo cuando el usuario lo pida. Si un cambio afecta a
   varios documentos, avisar para mantener consonancia `README` ↔ `docs/`.

## Entorno local

- Node 22+ y npm (workspaces nativos). Sin Docker.
- **PostgreSQL local con Homebrew** (decisión: servidor local, sin contenedores):

  ```sh
  brew install postgresql@16
  brew services start postgresql@16
  ```

  El instalador aporta también `psql`, que necesita `npm run seed` (`02` §5).
- Copia `.env.example` a `.env` y completa `DATABASE_URL`, `PORT`, `SESSION_SECRET`
  (`openssl rand -hex 32`), `TZ=America/Bogota` y las claves de IA (`02` §6). El `.env` nunca se
  versiona.

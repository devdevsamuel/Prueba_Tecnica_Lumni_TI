# Índice del análisis — Prueba Técnica Lumni TI (Desarrollador Full Stack)

> Documento de trabajo para preparar la implementación. Origen: PDF
> `Prueba_tecnica_Lumni_TI_F.pdf` (4 páginas, leído completo y contrastado).
> Estado: **análisis + auditoría cerrados → Fases 0–3 implementadas (Parte 1, 40 %, cerrada)**;
> fases 4–8 pendientes. El detalle de cada fase vive en [`04-plan-por-fases.md`](04-plan-por-fases.md).

| Archivo | Contenido |
|---|---|
| [01-evaluacion-y-requisitos.md](01-evaluacion-y-requisitos.md) | Qué evalúa la prueba (ponderaciones, plazo, entregables) + **todos los requisitos extraídos y organizados**: funcionales, reglas de negocio y casos límite, contratos de API, modelo de datos, seguridad, procesos asíncronos, IA, pruebas, SQL, incidente, documentación, bonus y ambigüedades. |
| [02-stack-minimo-dependencias.md](02-stack-minimo-dependencias.md) | Stack elegido con **mínimo uso de dependencias**: tabla de dependencias justificada, qué NO usar, estructura del repositorio, scripts npm y variables de entorno. |
| [03-decisiones-tecnicas-criticas.md](03-decisiones-tecnicas-criticas.md) | Decisiones técnicas clave: concurrencia, idempotencia, outbox de correos, arquitectura del chat con IA, capa de IA verificada con OpenCode Go (prueba real HTTP 200), auth sin dependencias, análisis del incidente y **aplicación práctica de los principios SOLID**. |
| [04-plan-por-fases.md](04-plan-por-fases.md) | **Plan de implementación por fases** ordenado por prioridad (peso y esfuerzo relativo), con tareas, pruebas, criterios de "hecho" y criterios de corte. **El progreso se mide con la tabla de pesos; el tiempo no es variable de planificación.** |
| [05-accesibilidad.md](05-accesibilidad.md) | Consideraciones de **accesibilidad (WCAG 2.1 AA)** por fase: HTML semántico, teclado, formularios, regiones vivas, contraste, `<time>` y verificación sin dependencias nuevas. |
| [06-ui-ux-limpia.md](06-ui-ux-limpia.md) | **UI y UX limpia** (minimal neutral tipo SaaS): principios, design tokens, contrato de estados (carga/vacío/error/éxito), patrones UX por flujo, catálogo de componentes con sus estados y verificación sin dependencias nuevas, por fase. |
| [AUDITORIA-adversarial.md](AUDITORIA-adversarial.md) | Informe vivo de la auditoría tras la depuración: fuentes, estado actual de la planificación, **pendientes abiertos** y recomendaciones de implementación (los 13 hallazgos iniciales ya fueron cerrados y aplicados en `docs/` — veredictos en la tabla más abajo). |

---

## Aspectos críticos de la prueba — checklist de auditoría

> Cada fila es un requisito **obligatorio** del enunciado. Si una falla, la auditoría del proyecto
> debe rechazarla **antes** de mirar estética. Úsalo como hoja de ruta de verificación.

| # | Aspecto crítico | Origen | Dónde se cumple | Cómo se verifica |
|---|---|---|---|---|
| 1 | **TypeScript estricto** en front y back | Reglas | `tsconfig` (`strict`, `noUncheckedIndexedAccess`) | `npm run typecheck` verde |
| 2 | **Migraciones versionadas** | Parte 1 · mínimos | Fase 0: runner propio + `schema_migrations` | `npm run migrate` desde cero y con datos |
| 3 | **Validación de TODAS las entradas en el servidor** | Parte 1 · mínimos | `zod` en cada endpoint | tests `400` por campo inválido |
| 4 | **Pruebas unitarias del cotizador y de transiciones** | Parte 1 · mínimos | Fases 1 y 2 (`node:test`) | `npm test` verde + matriz de `04` Fase 1 |
| 5 | **Cotizador completo**: tarifas 40k/70k/120k, bloques 30 min, Lun–Sáb 7:00–21:00, domingo cerrado, descuento escalonado 10/20 %, recargo 25 % sobre valor descontado, desglose, `canBook` + motivo + **siguiente horario sugerido ese día** | Parte 1.1 | Fase 1 (`quote.ts` puro) | matriz de casos límite |
| 6 | **Concurrencia: solo uno confirma** — constraint `EXCLUDE` con `status='confirmed'` (literal del PDF: *"otra reserva **confirmada**"*) | Parte 1.2 | DDL en `0001_init.sql` (Fase 0) + test Fase 2 | 2 confirmaciones paralelas → 1×`201` + 1×`409` |
| 7 | **Idempotencia: no duplica ni recalcula** el precio pactado | Parte 1.2 | `UPDATE … WHERE status='draft'` + `total` congelado | doble confirmación → mismas `booking_lines` y 1 correo |
| 8 | **Transiciones validadas en el backend** (`draft→confirmed→completed\|cancelled`) | Parte 1.2 | `state.ts` + tests | transición ilegal → `409` |
| 9 | **Retomable:** cerrar el navegador y continuar el borrador | Parte 1.2 | id en cookie/URL + `GET /api/bookings/:id` | cerrar/reabrir en el paso 2 conserva datos |
| 10 | **Admin**: paginación, filtros por estado/sala, detalle, cancelar con **motivo obligatorio**, 2 usuarios sembrados | Parte 1.3 | Fase 3 | `401` sin sesión · `403` cliente · `400` filtros inválidos |
| 11 | **Correo en segundo plano**: outbox transaccional, confirmar **no espera**, ≤5 reintentos con espera creciente, `failed` visible en admin, **un solo correo** por reserva | Parte 2.1 | Fase 4 | tests: 2 workers → 1 correo; backoff; agotamiento |
| 12 | **Chat IA**: 4 reglas · prompt en **archivo propio** · salida validada con **zod** · fechas relativas resueltas **en código** · conversación **retomable al recargar** · creación en `draft` y confirmación solo desde la app · **regla 4 explicada en el README** | Parte 2.2 | Fase 5 | tests de inyección que deben seguir fallando |
| 13 | **`consultas.sql`**: 5 consultas — morosos >30 días, solape estricto por pares, 12 meses × salas en hora de Colombia **con ceros**, inconsistencias, índices en **≤5 líneas** | Parte 3 | Fase 6 | `EXPLAIN (ANALYZE, BUFFERS)` contra datos generados |
| 14 | **`INCIDENTE.md` ≤2 páginas** con método visible: hipótesis → evidencia → remediación → prevención → mensaje no técnico | Parte 4 | Fase 7 (`03` §9) | revisión de estructura y extensión |
| 15 | **README**: cómo correrlo · decisiones · ambigüedades · fuera de alcance · concurrencia · idempotencia · regla 4 · **Uso de IA con ejemplo corregido** | Reglas | Fase 8 | checklist de secciones |
| 16 | **Historial de commits real y pequeño** | Reglas | todas las fases | `git log --oneline` incremental |
| 17 | **Claves solo en `.env`** (nunca en el repo) | Reglas | todas las fases | `git grep -iE "oc_sk_|api_key"` sin resultados |
| 18 | **Ambigüedades decididas y documentadas** en el README | Reglas | Fase 8 | cruzar con `01` §14 |
| 19 | **Sustentación de 45 min preparada**: guion de demo en vivo, dudas frecuentes y decisiones defendibles | Reglas (PDF: *"Luego hay una sustentación de 45 minutos con el equipo"*) | Fase 8 | recorrido ensayado + respuestas de `01` §14 y `03` |
| 20 | **Accesibilidad WCAG 2.1 AA en los flujos core** (no evaluada por el PDF; asumida por calidad) | Calidad profesional → `05-accesibilidad.md` | Fases 0–5 y 8 | pase solo-teclado + Lighthouse ≥ 95 + contraste de tokens |
| 21 | **UI y UX limpia y consistente** en las 5 pantallas: tokens, 4 estados de interfaz, catálogo de componentes (no evaluada por el PDF; asumida por calidad) | Calidad profesional → `06-ui-ux-limpia.md` | Fases 0–5 y 8 | checklist de `06` §7 + guion de 60 s |

---

## Estado de la auditoría adversarial (veredictos)

Contraste de `AUDITORIA-adversarial.md` contra el PDF (2026-10-25). El PDF
`Prueba_tecnica_Lumni_TI_F.pdf` se leyó completo (4 páginas); el contraste se hizo con las 4 páginas
extraídas (`pdf_extracted.txt`).

| Hallazgo | Veredicto | Acción aplicada |
|---|---|---|
| C1 · `completed` en el constraint de exclusión | **Resuelto: gana el código** — PDF: *"otra reserva **confirmada**"* | `01` §4 y §14 corregidos; DDL sin cambios |
| C2 · porcentajes incoherentes (4.1) | Parcial: el auditor confundió horas con peso (30/48); el error real era la celda `40 % (Parte 1 parcial)` | celda corregida + nota del reparto estimado 15/10 en `04` §0 |
| C3 · tests de Fase 3 incompletos (4.3) | **Aceptar** | criterio ampliado con `401`/`403`/`400` |
| C4 · test de concurrencia vago (4.5) | **Aceptar** | escenario determinista especificado en `04` Fase 2 |
| C5 · matriz del cotizador no reproducida (4.4) | **Aceptar** | matriz pegada en `04` Fase 1 |
| C6 · orden de ejecución implícito (4.7) | **Aceptar** | apartado "Orden de ejecución" en `04` §0 |
| C7 · script `dev` ficticio (4.8) | **Aceptar** | `scripts/dev.sh` real sin `concurrently` en `02` §5 + README unificado |
| C8 · tabla `reminders` (4.6) | **Rechazado** — PDF: *"No hay que programar"* | nota aclaratoria en `01` §6 |

## Decisiones confirmadas con el usuario

1. **Backend:** Express (único framework runtime).
2. **IA de la Parte 2.2:** suscripción **OpenCode Go** existente → verificada con llamada real
   (endpoint OpenAI-compatible, requiere cabecera `x-opencode-session`).
3. **Prioridad acordada:** Parte 1 (40 %) → Parte 4 (15 %) → Parte 3 (10 %) → Parte 2 (25 %),
   por peso y esfuerzo relativo. **El tiempo no es variable de planificación** (sin estimaciones
   de horas): la única métrica de avance es la tabla de pesos de `04` §0.
4. **Sustentación de 45 minutos:** reincorporada al alcance → preparación en la Fase 8
   (guion de demo, dudas frecuentes, repaso de decisiones).

## Entregables finales del examen (recordatorio)

1. Repositorio GitHub completo (app + integraciones + `consultas.sql`).
2. `README.md`: cómo correrlo, decisiones, qué quedó fuera y por qué + sección **Uso de IA**.
3. `INCIDENTE.md` (Parte 4, máx. 2 páginas).
4. Historial de commits real (varios pequeños).
5. **Sustentación de 45 minutos con el equipo** (guion y dudas preparados en la Fase 8).

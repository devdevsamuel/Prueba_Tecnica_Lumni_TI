# AUDITORÍA ADVERSARIAL — Plan de implementación de la Prueba Técnica Lumni TI

**Objetivo:** revisar críticamente los documentos de análisis y planificación de la prueba
`prueba_tecnica_lumni_TI` (`docs/`) aplicando criterios de ingeniería de software.

**Estado (2026-10-25): informe depurado.** Los 13 hallazgos de la auditoría (4.1–4.8 y N1–N5)
fueron cerrados y aplicados en `docs/` (commits `e7e37a1`, `b264a27`, `9101cb9`) y por eso ya **no
se reproducen aquí**. Tampoco se conserva ningún hallazgo de inconsistencias temporales: la línea
temporal fue eliminada del plan y el tiempo dejó de ser variable de planificación. Este documento
queda como registro vivo de lo que **todavía está abierto**: pendientes y recomendaciones de
implementación.

---

## 1. Fuentes

1. `README.md` (raíz) — descripción del proyecto, estado, cómo ejecutarlo y tabla de documentos.
2. `docs/00-indice.md` — mapa del análisis, checklist de auditoría, veredictos y decisiones
   confirmadas con el usuario.
3. `docs/01-evaluacion-y-requisitos.md` — núcleo de requisitos: ponderaciones, reglas del
   enunciado, casos límite, reserva, admin, contratos API, modelo de datos, seguridad, procesos
   asíncronos, reglas de la IA, SQL, incidente, bonus y ambigüedades.
4. `docs/02-stack-minimo-dependencias.md` — decisión de stack, dependencias justificadas,
   estructura de repositorio, scripts npm y variables de entorno.
5. `docs/03-decisiones-tecnicas-criticas.md` — concurrencia (EXCLUDE btree), idempotencia,
   outbox + worker, cotizador puro, máquina de estados, capa de IA verificada, SOLID, autenticación
   sin dependencias y análisis del incidente.
6. `docs/04-plan-por-fases.md` — estrategia, 9 fases (Fase 0 a Fase 8), criterios de "hecho" y
   criterios de corte.
7. `docs/05-accesibilidad.md` — consideraciones WCAG 2.1 AA por fase.
8. `docs/06-ui-ux-limpia.md` — UI y UX limpia: principios, design tokens, contrato de estados,
   patrones UX por flujo, catálogo de componentes y verificación por fase.
9. `Prueba_tecnica_Lumni_TI_F.pdf` — **leído completo (4 páginas)**; es la fuente de verdad de los
   requisitos.

Fecha de la revisión: 2026-10-25.

---

## 2. Estado actual de la planificación

- `docs/04-plan-por-fases.md` ordena el trabajo **por peso y esfuerzo relativo**, no por el orden
  del PDF: Fases 0–3 (Parte 1) → Fase 7 (Parte 4) → Fase 6 (Parte 3) → Fase 4 (Parte 2.1) →
  Fase 5 (Parte 2.2) → Fase 8 (cierre). Solo se entrega UI en las fases 0–5 (dashboard completo en
  Fase 2, admin en Fase 3, correos en Fase 4, chat en Fase 5); las fases 6–7 son solo archivos SQL y
  Markdown. El orden queda fijado explícitamente en el apartado "Orden de ejecución" (`04` §0).
- Los criterios de "hecho" de cada fase son verificables (tests + pantalla) e incluyen ya: la matriz
  de casos del cotizador (`04` §2), el escenario determinista de concurrencia (`04` §3), los tests
  `401`/`403`/`400` del contrato de admin (`04` §4) y el ejemplo literal del chat con
  `rooms.capacity` (`04` §6).
- `02`, `03` y `04` están alineados: la máquina de estados, el outbox, el constraint de exclusión
  (`WHERE status = 'confirmed'`, confirmado por el PDF) y la arquitectura del chat se describen en
  `03` y se ejecutan en fases concretas de `04`.
- La **UI y UX limpia** está especificada en `06` (design tokens, contrato de 4 estados de
  interfaz, patrones por flujo y catálogo de componentes con sus estados) y sus criterios ya están
  incorporados en los criterios de "hecho" de las fases 0–5 y 8 de `04`.

---

## 3. Pendientes abiertos

1. **Peso no especificado del 10 % de la ponderación.** El PDF suma 40 + 25 + 10 + 15 = 90 % y no
   define el resto. Hipótesis documentada en `01` §14 nº 7 (README + Uso de IA + preparación de la
   sustentación); **cierre en Fase 8**, al redactar el README.
2. **Esquema del chat en el README final.** `03` §6.2 es exhaustivo; en el README bastaría un
   esquema de 6 pasos para no saturar el documento principal (Fase 8).
3. **Consonancia entre documentos.** Mantener `README.md`, `docs/00`–`06` y este informe coherentes
   entre sí tras cada cambio (continuo; cierre en Fase 8).

---

## 4. Recomendaciones de implementación (sin tocar código)

1. **Fase 0/1:** verificar que la migración `0001_init.sql` conserve el constraint de exclusión con
   `WHERE (status = 'confirmed')` (es correcto según el PDF: *"otra reserva **confirmada**"*).
2. **Fase 2:** implementar el test de concurrencia determinista de `04` §3 (2 peticiones paralelas
   sobre la misma sala/horario → `1×201` + `1×409`, `total` y `booking_lines` idénticos, un solo
   correo).
3. **Fase 3:** mantener el criterio de "hecho" con los tests de `401` (sin sesión), `403` (cliente
   en `/api/admin/*`) y `400` (filtros `status`/`room` inválidos) — `04` §4.
4. **Fase 5:** usar como test de aceptación la conversación literal del enunciado (*"necesito una
   sala para 6 personas el sábado en la mañana, con proyector"*) y verificar que `rooms.capacity`
   filtra correctamente (`01` §14 nº 9; `04` §6).
5. **Fase 8:** incluir la sustentación de 45 minutos (guion de demo y dudas frecuentes) en el plan
   de referencias y en los "próximos pasos" del README; garantizar historial de commits
   incremental con mensajes descriptivos.
6. **Documentación:** conservar la consonancia entre `README.md`, `docs/00`–`06` y este informe.

---

*Informe basado en los documentos de `docs/` y en el PDF leído completo
(`Prueba_tecnica_Lumni_TI_F.pdf`, 4 páginas). Los puntos que dependen de interpretación se marcan
con su evidencia; nada de lo aquí recogido se eleva a requisito confirmado sin cita en el PDF.*

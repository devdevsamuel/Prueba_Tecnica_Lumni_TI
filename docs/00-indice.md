# Índice del análisis — Prueba Técnica Lumni TI (Desarrollador Full Stack)

> Documento de trabajo para preparar la implementación. Origen: PDF
> `Prueba_tecnica_Lumni_TI_F.pdf` (4 páginas, leído completo).
> Estado: **análisis terminado, pendiente de implementación** (Plan mode).

| Archivo | Contenido |
|---|---|
| [01-evaluacion-y-requisitos.md](01-evaluacion-y-requisitos.md) | Qué evalúa la prueba (ponderaciones, plazo, entregables) + **todos los requisitos extraídos y organizados**: funcionales, reglas de negocio y casos límite, contratos de API, modelo de datos, seguridad, procesos asíncronos, IA, pruebas, SQL, incidente, documentación, bonus y ambigüedades. |
| [02-stack-minimo-dependencias.md](02-stack-minimo-dependencias.md) | Stack elegido con **mínimo uso de dependencias**: tabla de dependencias justificada, qué NO usar, estructura del repositorio, scripts npm y variables de entorno. |
| [03-decisiones-tecnicas-criticas.md](03-decisiones-tecnicas-criticas.md) | Decisiones técnicas clave: concurrencia, idempotencia, outbox de correos, arquitectura del chat con IA, capa de IA verificada con OpenCode Go (prueba real HTTP 200), auth sin dependencias, análisis del incidente y **aplicación práctica de los principios SOLID**. |
| [04-plan-por-fases-48h.md](04-plan-por-fases-48h.md) | **Plan de implementación por fases** ajustado a 48 h, ordenado por valor/hora, con tareas, pruebas, criterios de "hecho" y criterios de corte. |

## Decisiones confirmadas con el usuario

1. **Backend:** Express (único framework runtime).
2. **IA de la Parte 2.2:** suscripción **OpenCode Go** existente → verificada con llamada real
   (endpoint OpenAI-compatible, requiere cabecera `x-opencode-session`).
3. **Presupuesto de tiempo:** **48 horas** → plan priorizado: Parte 1 (40 %) → Parte 4 (15 %) →
   Parte 3 (10 %) → Parte 2 (25 %).

## Entregables finales del examen (recordatorio)

1. Repositorio GitHub completo (app + integraciones + `consultas.sql`).
2. `README.md`: cómo correrlo, decisiones, qué quedó fuera y por qué + sección **Uso de IA**.
3. `INCIDENTE.md` (Parte 4, máx. 2 páginas).
4. Historial de commits real (varios pequeños).

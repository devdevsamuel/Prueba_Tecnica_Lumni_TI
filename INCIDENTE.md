# INCIDENTE — Recordatorios de reserva que casi la mitad de clientes nunca recibe

> **Síntoma:** *"casi la mitad de los clientes nunca recibe el recordatorio"* · **Dato clave:** el
> **92 % de los `expired` fueron creados después de las 17:00** · **Reglas:** job cada **30 min**,
> solo se escribe de **8:00 a 18:00** y un `pending` con **> 2 h** pasa a `expired` sin reintento.
> **Alcance:** sistema descrito en el enunciado (nuestra app no implementa recordatorios).

## 1. Hipótesis

**H1 (principal) — el TTL envejece con reloj de pared mientras la ventana de envío está cerrada.**
El job caduca a los 2 h *de calendario*, no a las 2 h en las que realmente puede enviar. Un
recordatorio creado a las 17:05 cumple 2 h a las 19:05, dentro de la ventana cerrada (18:00–08:00),
así que **caduca sin haberse intentado nunca**. El umbral de peligro es por tanto el **16:00** (2 h
antes de cerrar), y el 92 % de `expired` creados *después de las 17:00* cae dentro de esa franja:
**es la predicción del modelo comparada con la evidencia, no una explicación a posteriori**. Sospecha
asociada: el job podría marcar `expired` **antes** de intentar enviar en el mismo ciclo.

**H2 (alternativa, a descartar) — desfase de zona horaria:** si `created_at` se guarda en UTC y el
"17:00" se lee en local (o al revés), la franja real sería otra. Se discrimina comparando TZ.

## 2. Evidencia a recoger (SQL listo para pegar)

```sql
-- 1) ¿Dónde se concentran los caducados? H1 predice masa a partir de las 16:00.
SELECT date_trunc('hour', created_at AT TIME ZONE 'America/Bogota') AS hora_local,
       count(*)                                                     AS caducados
  FROM reminders
 WHERE status = 'expired'
 GROUP BY 1
 ORDER BY 1;

-- 2) Destino de los creados en la franja 16:00–18:00 (H1: deberían estar en 'expired').
SELECT status, count(*) AS total
  FROM reminders
 WHERE extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 16 AND 17
 GROUP BY status
 ORDER BY status;

-- 3) Contramuestra: creados a primera hora (8:00–10:00) → deberían enviarse bien.
SELECT status, count(*) AS total
  FROM reminders
 WHERE extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 8 AND 9
 GROUP BY status
 ORDER BY status;

-- 4) H2: desfase de zona horaria.
SHOW timezone;
SELECT now() AS en_servidor, now() AT TIME ZONE 'America/Bogota' AS en_bogota;
```

**Logs del job (mismo periodo):** trazas por registro con `created_at`, cada transición de estado,
el motivo del *skip* ("ventana cerrada") y si hubo **intento real** de envío; y si el ciclo marca
`expired` **antes** de iterar los envíos.

## 3. Validación

| Se confirma H1 si… | Se refuta H1 si… |
|---|---|
| La masa de `expired` cae a partir de las **16:00** y se explica por "ventana cerrada". | Hay `expired` concentrados de madrugada (8:00–12:00). |
| Los creados **8:00–10:00** están mayoritariamente en `sent` (contramuestra sana). | La contramuestra también caduca masivamente. |
| Los logs muestran **0 intentos** de envío para los caducados de la tarde. | Hubo intentos reales que fallaron (→ causa de entrega, no de caducidad). |

| Se confirma H2 si… | Se descarta H2 si… |
|---|---|
| `SHOW timezone` ≠ `America/Bogota` y el "17:00" del dato se lee en otra zona. | Ambos TZ coinciden y la franja se reproduce igual. |

**Si los datos no encajan**, se abre **H3** (falla real de entrega) con la misma secuencia. **No se
corrige nada antes de confirmar.**

## 4. Remediación de los registros afectados

**Objetivo:** recuperar lo que caducó por este bug **sin escribirle dos veces a nadie** y sin enviar
nunca fuera de la ventana.

**1. Selección** — solo lo realmente pendiente:

```sql
SELECT r.* FROM reminders r
  JOIN bookings b ON b.id = r.booking_id
 WHERE r.status IN ('pending', 'expired')        -- incluye los caducados por el bug
   AND r.sent_at IS NULL                         -- nunca reenviar lo ya enviado
   AND b.status = 'draft'                        -- a quien ya confirmó NO se le escribe
   AND (now() AT TIME ZONE 'America/Bogota')::time BETWEEN '08:00' AND '18:00';
```

**2. Doble barrera anti-duplicado:** clave única `UNIQUE (reminder_id, channel)` y marca `sent_at`
**en la misma transacción** del envío → un reintento del job jamás reenvía. Los `expired` por este
bug se reactivan **solo** si el cliente sigue en `draft` y sigue dentro de la ventana.

**3. Nunca a las 3 a. m.:** el *backfill* corre con la misma restricción de ventana que el job.

**4. Prueba antes de producción:** ① *seed* de escenarios en staging (creados 17:00, ya enviados, ya
confirmados, ventana cerrada); ② modo **dry-run** que imprime el conjunto resultante sin enviar;
③ recuento *"serían X envíos, de los cuales Y ya se enviaron antes"* y validar **Y = 0**.

**5. Aprobaciones:** responsable del canal/comercial (impacto en clientes) **y** tech lead (dato y
script). Se registra **quién aprobó y cuándo** (trazabilidad) antes de ejecutar.

## 5. Prevención: cambio de fondo y detección temprana

- **Separar "envejecer" de "caducar":** el TTL solo avanza **dentro de la ventana hábil**. Nuevo
  ciclo `pending → scheduled(próxima ventana) → sent | failed | expired`, con `next_attempt_at` =
  próxima apertura y expiración medida en **tiempo efectivo de envío**, no en tiempo de reloj.
- **Orden en el job:** primero intentar enviar lo que corresponde, **después** caducar.
- **Detección antes de que vuelva a pasar:** métrica **`tasa de expired por hora de creación`** con
  alerta por franja, **% de recordatorios enviados con éxito** y **antigüedad máxima de `pending`**.
  Esa curva habría saltado el **primer día** (16:00–18:00 > umbral).

## 6. Comunicación al equipo comercial (no técnico)

> Ya identificamos por qué muchos clientes no recibían su recordatorio: se generaban a última hora
> y el sistema los daba por caducados antes de poder enviarlos. Vamos a cambiar la regla para que
> solo cuenten las horas en las que podemos escribir y a recuperar los casos pendientes dentro del
> horario permitido. Les avisamos cuando esté liberado; no se ha enviado nada repetido a nadie.

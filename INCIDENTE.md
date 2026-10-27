# INCIDENTE — Recordatorios de reserva que casi la mitad de clientes nunca recibe

> **Síntoma:** *"casi la mitad de los clientes nunca recibe el recordatorio"* · **Dato clave:** el
> **92 % de los `expired` fueron creados después de las 17:00** · **Reglas:** job cada **30 min**,
> solo se escribe de **8:00 a 18:00** y un `pending` con **> 2 h** pasa a `expired` sin reintento.

| Hechos (enunciado) | Incógnitas (a confirmar con datos) |
|---|---|
| Job cada 30 min · escritura solo 8:00–18:00 · TTL de 2 h en `pending` → `expired` sin reintento · 92 % de los `expired` creados tras las 17:00 | Nombre de la tabla y columnas · zona horaria de las marcas de tiempo · si el job marca `expired` **antes** de intentar enviar · si un `pending` puede nacer ya vencido |

**Alcance:** se analiza el sistema del enunciado. Nuestra app **no** implementa ese recordatorio de
WhatsApp: no hay tabla `reminders` (la migración `0008_reminders.sql` solo amplía los `CHECK` de
`email_outbox`) y nuestro recordatorio por correo vive en `email_outbox` (`kind='reminder_2d'`), **sin**
TTL de 2 h y **sin** ventana 8:00–18:00. Las consultas van en el anexo
([`docs/incidente-evidencia.sql`](docs/incidente-evidencia.sql)) porque son **sobre el esquema ajeno** y
fallarían contra el nuestro.

## 1. Hipótesis de causa

El bug no es el TTL: es que **se mezclan dos relojes**. El TTL mide **tiempo de calendario**; la
política mide **tiempo de ventana hábil**. Un `pending` puede envejecer 2 h *sin que haya pasado una
sola hora en la que el sistema podía enviarlo*.

| # | Hipótesis | Predicción observable | Discrimina |
|---|---|---|---|
| **H1** · TTL con reloj de pared (principal) | Creado 17:05 cumple 2 h a 19:05 → caduca **sin intento de envío** | Tasa de `expired` se dispara **desde las 16:00**; la contramuestra 08:00–10:00 está sana | Q1–Q3 |
| **H2** · Orden de operaciones | El ciclo marca `expired` **antes** de iterar los envíos | Logs con **0 intentos** en la franja 16:00–18:00 | Logs + Q1 |
| **H3** · `pending` nace ya vencido | Off-by-one en `age > 2h` o en la granularidad de 30 min | Hay `expired` **de madrugada** (00:00–08:00) | Q1 |
| **H4** · Desfase de zona horaria | `created_at` en UTC y el "17:00" leído en local | La franja real no es 16:00–18:00 | `SHOW timezone` |

**Por qué H1 encaja con el dato:** el umbral del mecanismo es el **16:00** (2 h antes del cierre de las
18:00) y el dato observado —92 % de los `expired` creados tras las 17:00— cae dentro de ese tramo.
No es una explicación a posteriori: es la **predicción del modelo comparada con la evidencia**.

**Logs a revisar** (mismo periodo): traza por registro con `created_at`, cada transición, el **motivo
del *skip*** ("ventana cerrada") y si hubo **intento real** de envío; y si el ciclo marca `expired`
antes de iterar.

**Regla de decisión:** gana la hipótesis que **sobreviva a la evidencia**, no la que suene más
razonable. Si H1 no se confirma, se abre **H5 (falla real de entrega del canal)** con el mismo método.
**No se corrige nada antes de confirmar.**

## 2. Evidencia a recoger

SQL completo listo para pegar: [`docs/incidente-evidencia.sql`](docs/incidente-evidencia.sql). Las
3 consultas que deciden:

```sql
-- Q1 · ¿Dónde se concentran los caducados? H1 predice escalón desde las 16:00.
SELECT date_trunc('hour', created_at AT TIME ZONE 'America/Bogota') AS hora_local,
       count(*)                                                     AS caducados
  FROM reminders WHERE status = 'expired' GROUP BY 1 ORDER BY 1;

-- Q2 · La comparación que confirma o refuta H1 (control vs zona de riesgo).
SELECT CASE WHEN extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 8 AND 15
            THEN 'control' ELSE 'riesgo' END AS franja,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'expired') AS caducados,
       round(100.0 * count(*) FILTER (WHERE status = 'expired') / count(*), 1) AS pct_expired
  FROM reminders WHERE created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1;

-- Q3 · Contramuestra: lo creado a primera hora debería enviarse bien.
SELECT status, count(*) AS total
  FROM reminders
 WHERE extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 8 AND 9
 GROUP BY status;
```

| | Se **confirma** H1 | Se **refuta** H1 |
|---|---|---|
| Q2 | Control **≈ 0 %** vs riesgo **≈ 90 %** | Tasas parecidas en ambas franjas |
| Q1 | El salto arranca en **16:00–18:00** | Masa a las 08:00–12:00 o de madrugada (→ H3) |
| Q3 | Mayoritariamente `sent` | También caduca (→ otra causa) |
| Logs | **0 intentos** en los caducados de la tarde | Hubo intentos que fallaron (→ causa de entrega) |

## 3. Remediación de los registros ya afectados

**Objetivo:** recuperar lo caducado **sin escribirle dos veces a nadie**, sin escribir a quien ya
confirmó y **nunca a las 3 a. m.**

**1 · Qué es elegible.** Un `expired` cuyo TTL venció ya no debe salir por el mismo camino: para los
caducados por este bug se crea un **recordatorio nuevo** (fila e id nuevos, mismo `booking_id`), así la
deduplicación sigue intacta. Los `pending` vivos solo se encolan.

```sql
SELECT r.id, r.booking_id, r.created_at, r.status
  FROM reminders r JOIN bookings b ON b.id = r.booking_id
 WHERE r.status IN ('pending', 'expired')   -- 'expired' = caducados por este bug
   AND r.sent_at IS NULL                    -- nunca reenviar lo ya enviado
   AND b.status = 'draft'                   -- a quien ya confirmó NO se le escribe
   AND (now() AT TIME ZONE 'America/Bogota')::time BETWEEN '08:00' AND '18:00';
```

**2 · Doble barrera anti-duplicado.** (a) `UNIQUE (reminder_id, channel)` sobre la fila de envío;
(b) `sent_at` se marca **en la misma transacción** que el envío. Un reintento, un doble clic o un
backfill concurrente **no pueden** reenviar: chocan con la unicidad o ven `sent_at` ya escrito.

**3 · Nunca a las 3 a. m.** El backfill usa **la misma predicación de ventana** que el job normal
(8:00–18:00, hora de Bogotá), no una condición "más permisiva", y encola con `next_attempt_at` = la
próxima apertura.

**4 · Cómo lo probamos antes de producción.**

| Prueba | Resultado esperado |
|---|---|
| Seed en staging de 4 escenarios: creado 17:05, ya enviado, ya confirmado, ventana cerrada | Los 4 se clasifican bien según la query |
| `--dry-run` **por defecto**: imprime el conjunto sin enviar | "Serían X envíos, de los cuales Y ya se enviaron antes" |
| Invariante de duplicados: `GROUP BY booking_id HAVING count(*) > 1` | **0 filas** |
| Invariante de horario: `sent_at::time NOT BETWEEN '08:00' AND '18:00'` | **0 filas** |
| Reloj fuera de ventana | El script **no envía**; encola para la apertura |

**5 · Quién aprueba.** Dos, **antes** de ejecutar, con registro de *quién* y *cuándo*: el
**responsable de canal/comercial** (impacto a clientes: volumen y texto) y el **tech lead** (el script
toca datos de producción). Se adjunta al acta el `--dry-run` impreso; si el volumen supera un umbral
acordado, se escala a dirección antes de ejecutar.

**Criterio de "hecho":** 0 duplicados · 0 envíos fuera de 8:00–18:00 · ≥ 95 % de los elegibles
recuperados · 0 envíos a reservas ya confirmadas · aprobación firmada.

## 4. Cambio de fondo y detección temprana

**Principio general que sale del incidente:** *toda política que dependa del calendario (horario,
festivo, zona horaria) debe evaluarse contra un **reloj de negocio**, no contra `now()`*. Subir el TTL
de 2 h a 6 h taparía el síntoma; lo que falla es la mezcla de relojes.

| Antes | Después |
|---|---|
| `pending` con TTL de **2 h de calendario** → `expired` (terminal) | `pending` → `scheduled(próxima ventana)` → `sent \| failed \| expired` |
| El TTL avanza aunque la ventana esté cerrada | El TTL **solo avanza dentro de la ventana hábil**; `next_attempt_at` = próxima apertura |
| Un solo reloj (`now()`) | **Reloj de negocio**: tiempo transcurrido **habilitado** para enviar |

Además el job **envía primero y caduca después** en el mismo ciclo: hoy el orden puede matar lo que
iba a salir. El cambio entra detrás de un **feature flag** (`REMINDER_TTL_BUSINESS_HOURS`), con la
métrica instrumentada en modo observación antes de activar al 100 %: un job que empieza a escribir de
madrugada es exactamente el riesgo que este incidente viene a corregir.

**Detección antes de que vuelva a pasar:**

| Señal | Umbral | Quién |
|---|---|---|
| **Tasa de `expired` por hora de creación** (la curva del incidente) | > 5 % en cualquier franja de 1 h | on-call → `#alertas` |
| **Antigüedad máxima en `pending`**, en tiempo habilitable | > 2 h | on-call |
| **% de recordatorios enviados con éxito** | < 95 % en 24 h | responsable de canal |
| **Smoke test**: recordatorio artificial a las 17:30 → debe salir a las 08:00 | diario | CI / on-call |

La primera señal habría saltado **el primer día**: una curva plana hasta las 16:00 y un escalón después
es imposible que pase desapercibido si alguien mira la tasa por franja. Runbook: §3.

## 5. Comunicación al equipo comercial (no técnico)

> Hola equipo: ya encontramos por qué muchos clientes no recibían su recordatorio — se creaban al
> final del día y el sistema los cerraba antes de poder enviarlos. Ya está corregido: el tiempo solo
> cuenta en el horario en que podemos escribir (8:00–18:00). Recuperaremos los casos pendientes de
> los últimos días, solo a quienes siguen sin confirmar. Avisamos el día X; no se escribió dos veces.

## 6. Bonus Rails — la factura se reconstruye en cada guardado

```ruby
class Booking < ApplicationRecord
  has_one :invoice, dependent: :destroy
  before_save :regenerate_invoice, if: -> { status == 'confirmed' }
  def regenerate
    invoice&.destroy
    build_invoice(total: lines_total, tax: TaxCalculator.for(self))
  end
end
```

**El error no es `destroy`: es `before_save`.** La condición `status == 'confirmed'` se cumple en **cada
guardado**, no en la transición; por eso `destroy` se ejecuta una y otra vez sobre una factura que ya
existía. `destroy` es el **síntoma**; la causa raíz es un **callback de guardado** usado como disparador
de una **regeneración destructiva**.

**Qué rompe:** ① **rompe las FK de pagos** — `dependent: :destroy` borra o deja huérfanos los pagos:
pérdida silenciosa de dinero registrado, el peor daño posible. ② **pierde histórico y número de
factura**: otro `id`, otro número, documentos contradictorios para el cliente y correlativo inconsistente.
③ **recalcula precios ya pactados** (justo lo que la Parte 1 prohíbe). ④ **ciclo de callbacks
anidados**: `destroy` dentro de `before_save` corre su propia transacción anidada → facturas duplicadas
y borrados inesperados. ⑤ **no es idempotente ni está protegido contra concurrencia**: dos guardados
simultáneos pueden duplicar la factura (no hay `lock` ni unicidad).
**Corrección — emitir solo en la transición, versionar en vez de destruir:**

```ruby
class Booking < ApplicationRecord
  has_one :invoice, dependent: :nullify      # no borrar el histórico contable
  after_commit :issue_invoice, if: :became_confirmed?

  def became_confirmed?
    saved_change_to_status? && status == 'confirmed'
  end

  def issue_invoice
    with_lock do
      invoice_versions.create!(total: lines_total, tax: TaxCalculator.for(self))
    end
  end
end
```

Claves: **nunca destruir una factura emitida** (se versiona: revisión nueva con número correlativo, la
anterior queda `superseded` y auditable) · **una factura por transición a `confirmed`**, no por guardado ·
**`with_lock`** contra guardados concurrentes · **`after_commit`** para que un rollback de la reserva no
deje factura huérfana · **`UNIQUE (booking_id, version)`** como red de seguridad · `dependent: :nullify`
en lugar de `:destroy`, para que borrar la reserva no borre el histórico contable.

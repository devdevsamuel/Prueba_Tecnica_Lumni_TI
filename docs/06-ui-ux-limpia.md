# 06 — UI y UX limpia del proyecto

> **Alcance honesto:** el PDF no puntúa la estética por sí sola, pero premia *"una parte bien
> hecha"* y toda la interfaz se ve en la demo. Aquí se define qué significa **UI y UX limpia** en
> este proyecto, para que cada fase entregue una pantalla coherente con las anteriores.
> Dirección acordada: **minimal neutral tipo SaaS**. Restricción de `02` §2: **CSS plano con
> tokens**, sin Tailwind, UI kits ni librerías de animación. Complementa a
> [`05-accesibilidad.md`](05-accesibilidad.md) (WCAG 2.1 AA), que sigue mandando en teclado,
> semántica y contraste.

## 1. Principios de UI limpia

1. **Un solo accent.** Neutros para toda la interfaz; el color de marca solo resalta la acción
   principal y el estado activo. Los colores semánticos (éxito/aviso/error) se reservan para
   estados, nunca para decoración.
2. **Jerarquía por tipografía y espacio**, no por cajas: un título claro, cuerpo legible y aire
   entre bloques. Se elimina bordes antes que contenido.
3. **Alineación y una retícula simple:** contenido con `max-width` centrado y márgenes tomados de
   la escala de espaciado; nada posicionado "a ojo".
4. **Poco y consistente:** bordes de 1 px, una sola sombra tenue, un solo radio por componente.
   Sin gradientes ni efectos; solo transiciones de estado (150–200 ms).
5. **La pantalla explica sin párrafos:** etiquetas, microcopy y estados hacen el trabajo; si hace
   falta un bloque de instrucciones, el flujo está mal planteado.
6. **Cero sorpresas:** los mismos patrones en las 5 pantallas (mismo botón primario, mismo campo
   de formulario, mismo aviso de error).

## 2. Design tokens (`web/src/styles/tokens.css`, Fase 0)

| Grupo | Tokens | Regla |
|---|---|---|
| Neutros | `--gray-50 … --gray-900` | base de fondos, textos y bordes |
| Accent | `--accent`, `--accent-hover`, `--accent-soft` | acción principal y estado activo (**uno solo**) |
| Semánticos | `--success`, `--warning`, `--danger`, `--info` (+ variantes soft) | badges, errores y alertas; nunca decoración |
| Espaciado | `--space-1 … --space-6` (4, 8, 12, 16, 24, 32 px) | **solo esta escala**; sin valores sueltos en las páginas |
| Tipografía | `--fs-xs … --fs-2xl`, `--fw-*`, `--lh-*` | h1–h4, cuerpo 16 px, caption; sin tamaños a ojo |
| Radios | `--radius-sm/md/lg` | uno por componente |
| Sombras | `--shadow-sm/md` | una tenue para elevación (cards, menús) |
| Movimiento | `--dur-fast` (150 ms) | solo transiciones de estado; sin animación decorativa |
| Breakpoints | `--bp-sm/md/lg` (referencia) | mobile-first |

- **Contraste verificado al definirlos, no al final:** texto ≥ 4,5:1 y UI/texto grande ≥ 3:1
  (mismo criterio que `05` §5; ahí se comprueban también los tokens semánticos).
- `:focus-visible` definido sobre estos tokens desde la Fase 0 (`05` §2).

## 3. Contrato de estados de interfaz

Toda pantalla que habla con la API entrega **4 estados**, y se cierra **en la fase de esa
pantalla** (no en la Fase 8):

| Estado | Qué se muestra | Regla |
|---|---|---|
| **Carga** | Skeleton o spinner **en el área que cambia** (nunca pantalla en blanco) | el botón de envío muestra "…" y evita doble envío, **sin deshabilitarse sin aviso** (`05` §3) |
| **Vacío** | `EmptyState`: mensaje + acción sugerida | distinguir *"aún no hay datos"* de *"tu filtro no coincide"* (admin) |
| **Error** | `ErrorState` en texto plano + botón **Reintentar** | `role="alert"`; lo que el usuario escribió **nunca se pierde** |
| **Éxito** | el contenido | confirmación visible tras toda acción (confirmar, cancelar, enviar) |

## 4. Patrones UX por flujo

| Flujo | Patrón |
|---|---|
| **Cotizador** | Validación inline al salir del campo (además del envío); desglose **base / descuento / recargo / total** alineado y fácil de escanear; motivo de indisponibilidad en texto + **sugerencia clicable que rellena el formulario**; si `fetch` falla, se reintenta conservando lo escrito. |
| **Wizard** | Retroceder sin perder datos; cada paso validado al avanzar (error anunciado, `05` §4); **resumen explícito antes de confirmar**; pantalla final con la próxima acción (ver reserva / seguir cotizando); aviso *"borrador retomado"*. |
| **Admin** | **Filtros y página reflejados en la URL** (refrescable y compartible); distinguir vacío total vs vacío filtrado (con acción "limpiar filtros"); detalle accesible desde cualquier fila; cancelar en modal con motivo obligatorio. |
| **Chat** | Indicador *"escribiendo…"*; tarjeta de cotización con el mismo desglose del cotizador; reintento de un envío fallido **sin duplicar** mensaje; marca de tiempo por mensaje; **confirmar solo desde el botón normal** (regla 4). |

## 5. Catálogo de componentes (Fase 0) y estados

| Componente | Estados soportados |
|---|---|
| `Button` (primary / secondary / danger) | hover, `:focus-visible`, active, **loading** ("…"); sin deshabilitado silencioso |
| `Input`, `Select`, `Textarea` | normal, `:focus-visible`, **error** (`aria-invalid` + mensaje), validado |
| `Card` | normal (borde 1 px + sombra tenue) |
| `Table` | filas con hover; celda de estado con `StatusBadge` |
| `StatusBadge` | confirmed / draft / completed / cancelled / pending / failed — **siempre con texto**, nunca solo color |
| `Stepper` | completado / activo / pendiente (`aria-current="step"`) |
| `Modal` | trampa de foco, cierre con Esc y devolución del foco (`05` §2) |
| `AdminGate` | sesión **cargando** / **error** (con reintento) / **sin sesión** (muestra el login) / **sin rol** (403) / **autorizado** — y las pestañas del panel con el apartado activo |
| `EmptyState`, `LoadingState`, `ErrorState` | patrones únicos reutilizados por las 5 pantallas |

**Regla:** si un componente nuevo no entra en este catálogo, se añade primero aquí y después al
código (evita variantes paralelas del mismo control).

## 6. Tareas por fase (enlazado con `04-plan-por-fases.md`)

| Fase | UI/UX que se entrega |
|---|---|
| **0** | Tokens completos (§2) + componentes base **con sus estados** (§5), incluidos `EmptyState`/`LoadingState`/`ErrorState` |
| **1** | Validación inline, carga del botón, error con reintento, sugerencia clicable |
| **2** | Retroceso sin pérdida, resumen previo, confirmación con próxima acción |
| **3** | Filtros/página en la URL, vacío total vs filtrado, estados del listado |
| **4** | Estados de la bandeja de correos (vacío/carga/error) y detalle legible |
| **5** | Reintento de envío, marca de tiempo, indicador de escritura |
| **6–7** | Ninguna (son archivos SQL y Markdown) |
| **8** | Pase de verificación (§7) + pulido estético residual |

## 7. Verificación (sin dependencias nuevas)

1. **Checklist por pantalla** (2 min cada una): 4 estados cubiertos, catálogo §5 respetado,
   espaciado de la escala, un solo accent, sin textos genéricos (`error 500`, `undefined`).
2. **Guion de 60 s para la demo:** cotizar → no disponible → sugerencia → reserva en 3 pasos →
   admin → chat. Sin pasos muertos ni pantallas en blanco.
3. **Tamaño y zoom:** recorrido a 320 px y con texto al 200 % sin recortes (mismo criterio que
   `05` §7).
4. **Consistencia:** comparar cada pantalla nueva contra el catálogo §5 y las pantallas ya
   cerradas.

## 8. Fuera de alcance (y por qué lo digo en el README)

- **Modo oscuro** (duplica tokens y superficie de revisión sin aporte puntuable), animaciones
  decorativas y microinteracciones con librerías, y diseño "pixel-perfect" de marca: el foco se
  reserva para lo obligatorio (ver `04` §11). Es una decisión consciente de alcance, no un olvido.

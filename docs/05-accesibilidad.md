# 05 — Accesibilidad (a11y) del proyecto

> **Alcance honesto:** el PDF **no evalúa la accesibilidad**. No es un requisito puntuado, pero sí
> forma parte de una solución profesional y es previsible que salga en la demo. Objetivo:
> **WCAG 2.1 nivel AA en los 3 flujos core** (cotizar → reservar → admin) **sin añadir
> dependencias** (nada de librerías a11y ni `axe-core` en runtime: ver §Verificación).

## 1. HTML semántico (valor alto, coste cero)

- `<button>` real, **nunca** `<div onClick>`; `<form>` + `<label for>` en los 4 formularios
  (cotizador, wizard, login, cancelación).
- Listado del admin como `<table>` con `<th scope="col">`; `main`/`nav` en el layout;
  jerarquía de encabezados sin saltos (h1 → h2 → h3).
- Stepper de 3 pasos como `<ol>`; lista de mensajes del chat como `<ul>`.
- Iconos decorativos con `aria-hidden="true"`; los significativos llevan nombre accesible.

## 2. Teclado

- Todo operable con **Tab / Enter / Space / Esc**; nada solo de ratón.
- **`outline: none` sin sustituto = falta grave** → estilos `:focus-visible` definidos en
  `tokens.css` desde la Fase 0.
- **Modal de cancelación:** trampa de foco, **Esc** cierra y **devuelve el foco** al botón que lo
  abrió. Foco inicial en el primer campo (motivo).
- **Resultado del cotizador:** al pulsar "Cotizar" (disponible o no), el foco se mueve al
  resultado con `tabIndex={-1}` y la vista lo centra → nadie tiene que hacer scroll; el anillo
  de foco se pinta **siempre** (no solo con `:focus-visible`, porque lo mueve el código) y, con
  `prefers-reduced-motion`, el resaltado del margen se desactiva y el salto es instantáneo.
- Opcional barato: enlace "saltar al contenido" en el layout.

## 3. Formularios (el corazón de la app)

- Cada input con `<label>` visible (el placeholder **no** es label).
- Errores: `aria-invalid="true"` + `aria-describedby` apuntando al mensaje; **siempre texto**, el
  color rojo es complemento, nunca el único indicio.
- Grupos de duración/tipo de sala con `<fieldset>` + `<legend>`.
- `autocomplete="name"`, `autocomplete="email"` donde aplica.
- **Cuidado con `disabled`:** un botón deshabilitado no recibe foco ni anuncia nada → mejor
  mantenerlo habilitado y validar al enviar, anunciando el error.

## 4. Regiones vivas (`aria-live`)

| Elemento | Región |
|---|---|
| Resultado de la cotización (desglose o *"no disponible, sugerencia 11:00"*) | `aria-live="polite"` |
| Mensajes nuevos del chat + indicador "escribiendo" | `aria-live="polite"` |
| Errores de submit inesperados | `role="alert"` |
| Aviso "borrador retomado" | `aria-live="polite"` |

Sin esto, quien use lector de pantalla no se entera de que la cotización cambió.

## 5. Color y contraste

- Texto ≥ **4,5:1**; componentes de interfaz y texto grande ≥ 3:1 (WCAG AA).
- Verificar los tokens de `tokens.css` y los badges de estado al definirlos, no al final.
- **Nunca comunicar estado solo con color:** `confirmed` / `failed` / `cancelled` llevan texto
  (mantenerlo en la UI del admin); los errores de campo llevan mensaje.

## 6. Semántica de dominio (fecha y hora)

- `<time datetime="2026-10-25T10:00">sáb 25 oct · 10:00</time>` en horarios de reservas
  (sirve además para que nadie confunda 10:00 con 10 de la noche).
- `aria-current="step"` en el wizard; `aria-current="page"` en la paginación del admin.

## 7. Responsive y documento

- `<html lang="es">`; usable a **320 px** de ancho y con texto ampliado al 200 % sin recortes
  (evitar alturas fijas en contenedores con texto).
- **Movimiento:** solo transiciones de estado (150–200 ms, `docs/06` §1). Con
  `prefers-reduced-motion: reduce` se desactivan los fades, el colapso de altura y el shimmer;
  los spinners de carga se conservan (información funcional) a velocidad reducida.

## 8. Tareas por fase (enlazado con `04-plan-por-fases.md`)

| Fase | A11y que se entrega |
|---|---|
| **0** | `lang="es"`, layout semántico, `:focus-visible` en `tokens.css` |
| **1** | Labels, fieldsets, `aria-invalid`/`aria-describedby`, resultado en región viva |
| **2** | Stepper como `<ol>` + `aria-current="step"`, validación por paso anunciada |
| **3** | `<th scope>`, nombres accesibles en paginación, modal con trampa de foco y Esc |
| **5** | Chat en región viva, indicador de escritura anunciado |
| **8** | Pase completo de verificación (§9) |

> **Complemento:** el contrato de estados de [`06-ui-ux-limpia.md`](06-ui-ux-limpia.md) §3
> (carga/vacío/error/éxito) se implementa **sin romper estas regiones**: los errores de red
> → `role="alert"` y los resultados que cambian → `aria-live="polite"` (§4).

## 9. Verificación (sin dependencias nuevas)

1. **Recorrido solo-teclado** de los 3 flujos (5 min, obligatorio): nada se queda sin foco visible
   ni inalcanzable.
2. **Lighthouse → pestaña Accesibilidad** de Chrome (incorporado en el navegador, no toca el repo):
   objetivo ≥ 95 en las 3 pantallas principales.
3. **Inspector de accesibilidad** del navegador: revisar árbol, roles y nombres accesibles.
4. **Pase rápido con VoiceOver** (macOS): cotización anunciada, errores anunciados, modal leído.
5. **Movimiento reducido:** activar `prefers-reduced-motion` en DevTools y comprobar que la UI
   sigue siendo comprensible y que los cambios de contenido no dependen de una animación.

**Fuera de alcance (y por qué lo digo en el README):** tests automatizados de a11y con
`axe-core`/`jest-axe` (dependencias de test que el examen no pide), auditoría de lector de
pantalla completo con NVDA, y soporte de modo alto contraste. Es una decisión consciente de
alcance, no un olvido.

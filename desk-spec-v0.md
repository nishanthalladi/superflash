# Desk spec v0

A spatial notebook. Everything is a **Note**. Notes sit on Notes. Some Notes run.

## Words

- **Note** — one id, one body. Always a canvas: it can hold other Notes.
- **Pin** — one placement of a Note on a parent Note (`x`, `y`, `width`, `height`).
- **Type** — the behavior of a pin (what you see and what it does).
- **Desk** — the viewer: pan, zoom, click, focus.
- **Spine** — a simple event channel. Notes publish facts; Notes subscribe.
- **Machine** — an optional worker a Type may start. No window, no raw disk.
- **Grant** — a permission a Machine must have to touch anything except itself.

## Rules

1. A Note has exactly one body.
2. A Note may be pinned in many places. Edit once; every pin shows it.
3. Only one pin is focused.
4. Keyboard input goes to the focused pin only.
5. A Note cannot contain itself (no loops).
6. If a Note has exactly one pin, the Desk shows that Type full screen. If it has two or more, you see the canvas.
7. A Machine may read another Note only with a grant.
8. A Machine cannot touch the DOM.

## Type API

A Type implements:

- `mount(box, note)` — draw into this box
- `focus()` / `blur()`
- `save()` — write body
- `onSpine(fact)` — a fact arrived
- `startMachine(grants)` — optional

Facts: `{ from, name, data }`. Call `emit(name, data)` to publish.

Play, scroll, formulas, drawing tools stay inside the Type. The kernel does not know them. If a Type needs a new kernel verb, either the spec is wrong or that verb is a grant.

## Grants

Default grants: read/write self, emit.

All other access is denied until granted (e.g. `read:<noteId>`).

## Spine

In-process pub/sub by Note id. Small facts only. No DOM, no compute.

A Type that streams is still a Type. It is not the Spine.

## v0 to build

No spreadsheet. No pen. No terminal.

1. Create Notes and Pins
2. Pan/zoom a canvas
3. Click to focus
4. One Type called **Stub**: colored box, shows its body text, can emit `"ping"`, can listen
5. Pin the same Note on two parents; change body; both pins update
6. Without a grant, Stub B cannot read Note A; with a grant, it can

Done when those six work. Then write a real Type.

## Invariants (computable)

1. Every Note has exactly one body.
2. Every Pin points at a Note that exists.
3. At most one Pin is focused.
4. A keydown goes to the focused Pin only.
5. If A emits and B subscribes to A, B receives the fact.
6. B reads A only if B holds `read:A`.
7. If B does not hold `read:A`, B cannot read A.
8. A patch to a Note updates every Pin of that Note.
9. A Machine has no DOM.
10. Containment has no cycles.

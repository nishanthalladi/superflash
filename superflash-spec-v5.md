# Superflash spec v5 — the paper is writable

v4 made a canvas a surface that holds boxes and nothing else. v5 keeps that and
lets you draw and write *on* the surface: a canvas note's body, after its name,
is an Excalidraw scene, rendered as crisp SVG under the pins.

## What changed

- **A canvas body is `name\n\n{"type":"excalidraw","version":2,"elements":[...]}`**,
  or just the name. Elements use Excalidraw's schema (`rectangle`, `ellipse`,
  `arrow`, `line`, `freedraw`, `text`), so the file opens in Excalidraw and an
  agent draws by writing JSON. `roughness: 0` everywhere: architect style.
- **Ink coordinates are pin coordinates.** An element at `x: 96, y: 96` sits
  where a pin at `x: 96, y: 96` would. Ink pans and zooms with the boxes, at
  every depth; a nested canvas draws its own ink through its own camera.
- **One toolbar, on the outermost canvas:** select (V), rectangle (R), ellipse
  (O), arrow (A), line (L), pen (P), text (T), eraser (E). Nested canvases
  draw with the same tool. Letters pick tools only when nothing is focused.
- **Typing on bare paper writes on the paper**, a loose `text` element where the
  pointer last was, not a text box. Double-click still makes a canvas box; paste
  still makes text/web/image boxes.
- **`sketch` is gone.** A sketch box is a canvas box with no children.
- No style panel yet: stroke `--ink`, no fill, width 2.

## Invariants (computable)

Keep v0–v4, except 30 (typing makes a `text` element, not a pin). Add:

34. For every pin of Type `canvas`, `body.slice(nameOf(body).length)` is either
    `''` or `\n\n` followed by JSON whose `type` is `excalidraw` and whose
    `elements` is an array.
35. Every element's `x, y` (plus `points` offsets) is in the coordinate space of
    the pins on the same note: `at(e)` for a pointer event yields the same point
    for an element as for a pin under it.
36. One gesture — a drag, a text edit, an erase — is one `patch` of the note and
    one undo step; `journal.depth.past` grows by exactly one per gesture.

# Superflash spec v4 — a Type is a way of looking

v3 had one Type, `canvas`, and a rule inside it: a note is text *or* boxes, never
both, and Cmd+N flipped a text note into a box note by spilling its text into a
child. That flip was a type switch hiding inside one Type. v4 takes it out.

## What changed

- **A canvas is always a canvas.** It never shows a body, never spills, has no
  mode. Cmd+N is gone.
- **`text`** is a seed Type: everything after the name line in a textarea, and
  Shift+Enter runs the body and shows the result. What v3's canvas did in text
  mode, this does as a Type.
- **The bar is the canvas's, not the child's.** Every child pin — canvas, text,
  code, anything — gets the same bar: name (line one) and a grip. No controls.
- **Right-click a bar to re-pin.** A pin's Type is fixed at birth, so picking
  another is `unpin` + `pin` with the same note and geometry, in one transaction.
  Same note, different way of looking at it. One undo step.
- **Right-click the big title bar to change how the note you are inside is
  shown.** That is view state, beside the camera, not the document: a note holds
  what it holds; how you last looked at it is yours. The Type fills the stage,
  reading and writing that note through the shell's own powers.
- **Seed pointers stay pointers.** A module Note whose body is `@canvas.js` is
  resolved when it compiles, not when the document is made, so `seed/*.js` on
  disk is what runs, in every stored document, on every reload. A document that
  carried its own copy is pointed back at disk on boot; one that predates a seed
  Type gains it. `?fresh=1` is for throwing away *your* boxes, nothing else.
- **Typing on bare canvas makes a text box** and the keystroke lands in it.
  **Pasting** makes a text box holding the clipboard. Double-click still makes a
  canvas.

## Why the Type lives on the Pin

The model already said so: `Pin.type`, not `Note.type`. A Note is a body; how it
is drawn is a property of one placement of it. So "change this from text to
canvas" needs no converter and no new field — the body is the shared substrate
every Type reads. An `image` Type is a body that is a URL and a Type that draws
`<img>`; nothing else has to know.

## Name

Line one, exactly. Not "the first non-blank line": a body that starts with `\n`
has an empty name, which is what a text box you just started typing in has.

## Invariants (computable)

Keep v0–v3. Add:

28. `grep -n "holds\|spill" seed/canvas.js` is empty. A canvas has no text mode.
29. Retyping a pin leaves `childPins(parent).length` unchanged and the note's
    body untouched, and undoes in one step.
30. A keydown of one printable character with nothing focused creates exactly
    one pin, of Type `text`, and it holds the focus.
31. Right-click on any `.canvas-bar` opens one `.canvas-menu` listing every
    registered Type; a click elsewhere closes it and changes nothing.
32. Choosing a Type from the title bar changes no pin and no body; it changes
    `toJSON()` not at all.
33. A stored document whose `canvas` module body is not `@canvas.js` boots with
    it rewritten to `@canvas.js` and the disk canvas mounted.

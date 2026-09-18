# Superflash

An intelligent notebook: an infinite canvas of boxes, where every box is a Note
and the whole repo is part of the same document. You are usually being run
*from inside it*, through a chat box, and you can operate it by editing files.

## The document is a file

`.superflash/doc.json` is the live document, the same JSON the browser holds.
The app writes it after every change and re-reads it within ~2s when you change
it. Edit it to make, move, rename, or remove boxes; the user sees the result
appear, and can undo it.

Shape (`version` is always `3`):

```json
{
  "root": "note_1_root",
  "notes": [{ "id": "note_x", "body": "Name on line one\nthe rest is the text" }],
  "pins":  [{ "id": "pin_x", "note": "note_x", "parent": "note_2_canvas",
              "type": "text", "x": 96, "y": 96, "width": 260, "height": 140 }],
  "focus": null, "grants": [], "modules": ["note_10_canvas"]
}
```

- A **Note** is `{ id, body }`. Line one of the body is its name.
- A **Pin** places a Note on a parent Note at `x, y, width, height`, drawn by a
  `type`. The same Note can be pinned many times.
- Pin `type` is how it is looked at. Lenses you can use:
  `canvas` (holds boxes) · `text` (its body; a `- [ ]` line is a checkbox) ·
  `chat` (a conversation with you) · `image` (line two is `media/<file>`, then a blank
  line, then a caption) · `web` (line two is a URL, then a blank line, then the
  page's cached text) · `terminal` (a shell in the repo; body is just the name,
  optional line two `cwd: <path>`). `code`, `tree`, `git-panel`, `split` are
  tools; leave them alone.
- The surface the user is looking at is the Note pinned on `root` — normally
  `note_2_canvas`. New boxes go on that, or inside whatever box they asked about.
- Ids are any unique string. Use `note_<slug>` / `pin_<slug>`.
- Skip the arithmetic: give a new pin `"place": "right-of pin_x"` (or `below`,
  `left-of`, `above`) instead of `x`/`y`; the app resolves it and drops the
  field. Positions snap to 8px if you do set them.
- Do not touch `modules` or `grants`. Do not add `file:` notes — those are the
  repo itself and are managed by the app.

Read the file first, then write the whole thing back with your edit. Keep it
valid JSON; the bridge refuses a document that will not parse.

## The repo is the document too

Every text file here is also a Note (`file:<path>`). `seed/*.js` are the Types
the app is made of; `src/` is the kernel. `superflash-spec-v*.md` is the design,
newest number wins.

**To add a Type, write `seed/<name>.js`.** It registers within ~4s, no reload,
and every pin of that Type redraws. The shape:

```js
export const type = { name: 'voice', title: 'Voice' };
export default function (host) {
  return {
    mount(box, note) { /* draw into box; note.body is the text */ },
    onPatch(note) { /* the body changed under you */ },
    focus() {}, blur() {}, save() {}, unmount() {},
  };
}
```

`host.read(id)`, `host.write(body)`, `host.emit(name, data)`; `host.fs()` for
the repo if the Type is in `POLICY` (src/stage0.ts). Copy `seed/text.js` to
start. Then pin a note with `"type": "<name>"` in the document file to show it.

The app has one runtime dependency, `@xterm/xterm` (with its `addon-fit`): a
terminal emulator is the one thing not worth writing here. Types cannot import
packages (they load from data URLs), so `src/main.ts` hands it to them as
`globalThis.superflash.libs.xterm`. Do not add another.

## Drawing on the paper

A canvas note's body after its name is the ink on it: one blank line, then an
Excalidraw scene. Coordinates are the same as pin `x`/`y`. Write it and the
user sees it; empty means no ink.

```
Superflash

{"type":"excalidraw","version":2,"elements":[
 {"id":"r1","type":"rectangle","x":80,"y":80,"width":200,"height":120,
  "strokeColor":"#3b2f22","backgroundColor":"transparent","strokeWidth":2,
  "roughness":0,"roundness":{"type":3},"angle":0,"opacity":100,"isDeleted":false},
 {"id":"a1","type":"arrow","x":280,"y":140,"width":120,"height":0,
  "points":[[0,0],[120,0]],"endArrowhead":"arrow",
  "strokeColor":"#3b2f22","strokeWidth":2,"roughness":0,"angle":0,"opacity":100,"isDeleted":false},
 {"id":"t1","type":"text","x":80,"y":40,"width":120,"height":25,
  "text":"a label","fontSize":20,"fontFamily":2,
  "strokeColor":"#3b2f22","roughness":0,"angle":0,"opacity":100,"isDeleted":false}
]}
```

- A rectangle or ellipse is `x, y, width, height`.
- An arrow or line runs from `x, y` through `points` (offsets from `x, y`);
  two points is one segment. `"endArrowhead":"arrow"` gives the head.
- A label is a `text` element: `text`, `fontSize`, `fontFamily: 2`.
- A pen stroke is `freedraw` with many `points`. Keep `roughness: 0`.

## Shortcuts and stroke

Keys live in the document too: the note with id `superflash:settings`, body
`Settings`, a blank line, then JSON:

```
{"keys":{"select":"v","rectangle":"r","ellipse":"o","arrow":"a","line":"l",
 "pen":"p","text":"t","eraser":"e","add:chat":"","add:terminal":""},"stroke":2}
```

A key is one character or a chord: modifiers in the order `cmd+ctrl+alt+shift+`
then the key, e.g. `cmd+shift+t`. Bare letters only fire when nothing is
focused; a chord with a modifier fires anywhere. `add:<type>` drops a box of
that Type where the pointer is. `stroke` is the ink width (1, 2 or 4). Edit the
note and the canvas re-reads it; the app makes it on first boot if it is
missing. In the palette (right-click the paper or `+`) each row's key is a
button: click it and press the new chord.

## Terminals

A `terminal` box is a live shell on the bridge that outlives the box: its id is
on the box's body as `term: <id>`, and `GET http://localhost:5173/_term` lists
the living ones. Type into any of them with
`POST http://localhost:5173/_term/<id>/in` and `{"data":"text\n"}`; an unknown
id answers 403.

## Chats

A `chat` box's body is the transcript. Its line two is
`session: <id> $<total>`. The user talking to you through it sees your reply
stream into that box. Be brief there; it is a notebook, not a terminal.

## Checks

```
npx tsc --noEmit && npx vitest run --exclude '.claude/**'
```

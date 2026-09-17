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
- Pin `type` is how it is looked at: `canvas` (holds boxes), `text` (its body),
  `chat` (a conversation with you). Other Types are tools; leave them alone.
- The surface the user is looking at is the Note pinned on `root` — normally
  `note_2_canvas`. New boxes go on that, or inside whatever box they asked about.
- Ids are any unique string. Use `note_<slug>` / `pin_<slug>`.
- Positions snap to 8px. A box next to another is about `x + width + 24`.
- Do not touch `modules` or `grants`. Do not add `file:` notes — those are the
  repo itself and are managed by the app.

Read the file first, then write the whole thing back with your edit. Keep it
valid JSON; the bridge refuses a document that will not parse.

## The repo is the document too

Every text file here is also a Note (`file:<path>`). `seed/*.js` are the Types
the app is made of; `src/` is the kernel. Editing them changes the running app
on reload. `superflash-spec-v*.md` is the design, newest number wins.

## Chats

A `chat` box's body is the transcript. Its line two is
`session: <id> $<total>`. The user talking to you through it sees your reply
stream into that box. Be brief there; it is a notebook, not a terminal.

## Checks

```
npx tsc --noEmit && npx vitest run --exclude '.claude/**'
```

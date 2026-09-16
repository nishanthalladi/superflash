# Superflash spec v1 — self-hosting

v0 got Notes, Pins, grants, and Types-from-Notes. But the app's own code still
lives in `src/`. v1 fixes two things:

1. **Everything is in the project.** `src/` shrinks to the kernel plus a ~30-line
   bootstrap. The Superflash, the palette, every Type: module Notes inside the document.
2. **It's a notebook.** A `cell` Type: body is source, run it, see the output
   under it. That is the unit of work, not a stub box.

## The one new kernel verb

Today only the canvas can mount a Type, because the canvas is the only thing that
imports the registry and owns elements. That is what keeps it outside the
document. So: one verb, one grant.

```ts
// Host
kernel(): Kernel     // needs `shell`
```

The spec first said `mountPin(pin, el)`. Mounting turned out to be one of about
twenty things the canvas needs — it also moves pins, unpins them, walks
containment, drives the journal, subscribes to every fact. Twenty grant-checked
verbs to sandbox the one Type that is *not* untrusted is the wrong trade, so:
one grant that hands over the kernel, and a policy table that gives it to the
furniture only.

With that, **the canvas is just a Type**. Rule 6 already says a Note with one pin
shows that Type full screen — the root Note has one pin, of type `desk`.

Nothing else in the kernel changes. No new model, no new op.

Narrow `shell` into individual verbs the day an untrusted Type needs one of
them. Until then it is one line in `kernel.host()`.

## Boot, after

`src/` keeps: `kernel/*`, `types/{cell,code}.ts`, `main.ts`, `stage0.ts`,
`seed.ts`, `safe.ts`, `eject.ts`. Nothing else.

```
stage0(root, store, { fresh, safe }):
  kernel = new Kernel()
  define built-ins: cell, code            # the two you need to repair anything
  doc = readDoc(store) ?? seedDoc()
  snapshot(doc); kernel.load(doc)
  unless safe: { failed } = await kernel.loadModules()
  applyPolicy over all pins (+ on pin:add)
  autosave
  shell = the single pin on kernel.root       # rule 6
  if safe or no shell or it will not mount → safeShell() and stop
  mount shell into root
  on types.watch: if the shell's factory changed, tear it down and mount again
```

`canvas`, `palette` and `stub` are module Notes in the seed. The policy table is
the only thing that stays behind, because it is the trust root.

That last line is the one that makes this feel like a notebook: edit `desk.js`
in a Cell, hit Run, and the shell you are standing on is replaced under you.

### Grant policy

Policy stays in `src/` — it is the trust root and must not be editable by the
thing it governs. It becomes a table, not code:

```ts
const POLICY: Record<string, Grant[]> = {
  desk:    [SHELL, CREATE, TYPES],
  code:    [DEFINE],
  cell:    [SHELL, DEFINE, CREATE, TYPES, MACHINE],   // a cell is a dev console
  palette: [TYPES, CREATE],
};
```

`cell` is deliberately powerful. That's the point: a cell is how you edit the
project from inside the project.

### Anti-brick

Three layers, cheapest first:

- `?safe=1` — skip `loadModules`, mount the safe shell: one plain textarea per
  module Note with a Run button. A broken `desk` module is still editable.
- Automatic — the same fallback whenever the shell Type fails to compile or
  fails to mount.
- `?fresh=1` and `snapshots()` — already built.

`src/safe.ts` is ~70 lines of plain DOM. Not pretty. It only has to let you fix
the Note that broke.

## Seed round trip

Notes hold the code, so git needs a view of it.

- `seed/*.js` — one file per module Note, plus `seed/doc.json` for the Notes,
  Pins and layout that aren't source. A Note body of exactly `@name.js` points at
  the file of that name; that is the whole format.
- No build step. `src/seed.ts` imports the files with Vite's `?raw` and swaps the
  pointers for source. Vitest reads them the same way, so the tests compile the
  real seed.
- `eject` — writes the live document back out to `seed/`, via the File System
  Access API or a pile of downloads. Without this, in-app edits are trapped in
  localStorage and the repo rots.

Eject drops the grants that policy hands out at boot, so an ejected document
cannot claim a power the policy later takes away.

Eject is not optional. It is the thing that makes "work inside the project" real
instead of a demo.

## The `cell` Type

```
[ source textarea            ]
[ ▸ run              status  ]
[ output                     ]
```

- Body is the source. `host.write` on input, same as `code`.
- **Run** compiles the body as an ES module (reuse `loadSource`) with `host`,
  `kernel`-free, injected — cells get capabilities, not internals.
- Two shapes, checked in order: a default export → called with `host`, its
  return is the output; otherwise the module's `out` export is the output.
  Top-level `await` works for free, because it is a real module.
- Output rendering: an `HTMLElement` is appended; anything else is
  `JSON.stringify`'d, `Error` shows message + stack.
- Output is **not persisted**. It is view state. Re-run to see it again.
- `Shift+Enter` run. `Cmd+Enter` run and focus the next cell — "next" is the
  sibling pin below this one on the same parent, by `y`. No new model.

That last rule is what makes a canvas of cells read as a notebook without adding
a notebook.

## What v1 does not add

No stack/flow layout Type. No cell dependency graph, no re-run-downstream, no
kernel restart button, no output diffing. A canvas of cells you run by hand is
the notebook; add ordering when running them by hand actually hurts.

## v1 to build, in order — all shipped

1. `host.kernel()` + `shell` grant. `test/cell.test.ts` — no grant, `Denied`.
2. `cell` Type in `src/`. `test/cell.test.ts` — default export, `out`, `await`,
   a DOM node, a throw, a syntax error.
3. `canvas` as a module Note; `stage0` replaces `boot`. `test/stage0.test.ts` —
   the seed boots, and redefining `desk` remounts the shell live.
4. `seed/` + `eject`. `test/eject.test.ts` — eject, rehydrate, boot, same `Doc`.
5. `stub` and `palette` moved into `seed/`; `src/desk/`, `src/boot.ts`,
   `src/types/stub.ts`, `src/types/palette.ts` deleted. The tests compile them
   from the seed files, so a broken seed file fails the suite.

Done: `src/` is `kernel/`, two Types, and five small files. A Cell changed the
Type registry with no file touched (`test/stage0.test.ts`).

## Invariants (computable)

Keep v0's ten. Add:

11. A pin without `shell` cannot reach the kernel.
12. Nothing in `src/` imports the canvas, the Stub or the palette — there is
    nothing there to import.
13. A module Note that fails to compile leaves the previous Type registered
    (v0 already holds this) and never prevents boot; if it was the shell, the
    safe shell takes over.
14. eject → rehydrate → load → the same `Doc`.
15. A cell's output is absent from `toJSON()`.
16. Redefining the shell's Type unmounts the old instance and mounts the new
    one, with its window listeners gone.

## Later, and worth naming

An `agent` Type: a cell whose body is a prompt, whose Machine talks to an API,
and whose grants say which Notes it may read and write. Then the loop that
built this thing runs inside it. Everything it needs already exists — Machine,
grants, `defineModule`, the Spine. Not v1.

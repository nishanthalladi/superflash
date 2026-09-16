# What's still missing, and what I'd do about it

Measured against the vision as stated: a spatial notebook where the whole project
lives inside the project, worked on from inside itself, with a view you can swap
per project. v1–v3 got the structure right. What is missing is mostly *the loop* —
the things that make working in there survivable rather than a demo.

Ranked. Each one says what breaks today, then the proposal.

---

## 1. Rescue and verify — the trap

**Today.** `src/kernel/kernel.ts` is a Note. Edit it in a pin, it writes to disk,
Vite reloads, and if it does not parse you get a white page. `?safe=1` cannot save
you: `stage0` imports the kernel that just broke, so there is nothing left to
mount the safe shell *with*. `?fresh=1` cannot either — the bad text is on disk,
not in localStorage. The only way back is a terminal, which is exactly the thing
the vision says you should not need.

There is also no way to know a change is good. No typecheck, no test run, nothing.
You reload and hope.

**Proposal.**

- `rescue.html` — a static page the bridge serves, importing *nothing* from `src/`.
  It shows `git log`, `git diff`, the last N writes the bridge made, and a
  `git checkout -- <path>` button per file. It works when the app cannot boot,
  because it is not the app.
- `POST /_run { script }` — allowlisted npm scripts only (`test`, `build`, and a
  new `check` = `tsc --noEmit`), streamed back line by line.
- A `task` Type: a pane that runs one of those and shows the output, red or green.
  Then "edit the kernel from inside" ends in a green tick instead of a coin flip.
- Optional and cheap: the bridge keeps `.desk/undo/<path>.<n>` copies of the last
  few writes, so rescue works even before you commit.

**Why first.** Everything else assumes you can safely change the thing you are
standing on. Right now you cannot, and the failure is unrecoverable from inside.

---

## 2. The agent — the test you actually named

**Today.** Nothing. The loop that built this runs in a terminal beside it.

**Proposal.** An `agent` Type. Body is the prompt. It holds `fs` and a new
`api` grant.

- The API key lives in the bridge's environment, never in the document, and the
  bridge proxies `POST /_llm` — so a key cannot be ejected into `seed/` or synced
  into localStorage by accident.
- Its reach is grants, not trust: `read:<note>` for context, `fs` for the files it
  may touch. Start with read-only + propose-a-diff.
- Output is a diff, shown in the git panel, applied only when you say so. It
  writes through the same bridge as everything else, so `rescue.html` and
  `git checkout` cover its mistakes too.
- A Machine is the honest home for the network call (no DOM), which is the piece
  v0 already built and nothing has used yet.

**Why second, not first.** An agent that can write files needs the recovery story
from #1 to already exist. Building them in the other order is how you lose an
afternoon.

---

## 3. Actually notebook-y — the complaint I only half fixed

**Today.** A Cell runs, prints, and forgets. Output is view state, so a reload
blanks it. There is no order, no run-all, no way to add a cell below this one, and
the canvas gives you no reading direction. You said "not notebook-y enough" three
iterations ago and this is the part that is still true.

**Proposal.**

- A `stack` Type — a `split` variant that flows its children top to bottom, with
  `+` between panes, drag to reorder, and no free positioning. A notebook is a
  stack; the canvas stays for everything else. Both are Types, so you pick per
  Note.
- Run-all, top to bottom, stopping on the first throw.
- Keep the last output per pin in view state (not the document), so a reload shows
  what you last saw.
- Per-cell status: idle, running, ok, threw — visible without reading the output.
- In `code` and `cell`: a line gutter and `Cmd+F`. Two things you miss within a
  minute of editing a real file.

---

## 4. The filesystem, finished

**Today.** The tree reads. It cannot create, rename, or delete a file, and there
is no search. `_fs` has `list`, `read`, `write` and nothing else. For a project
whose premise is "the repo is the document", that is half a filesystem.

**Proposal.**

- `_fs/move`, `_fs/rm` (same jail, and `git mv` / `git rm` when the path is
  tracked, so history survives), `_fs/mkdir`.
- `_fs/grep` — ripgrep if present, a walk if not; results as a pane you click into.
- Tree: right-click for new file / rename / delete, and a search pane above it.
- `sync` already prunes a deleted file's Note, so the document side is done.

---

## 5. Smaller things I noticed, not worth their own iteration

- **Polling.** `sync` re-lists the repo every 4s. Vite already watches the
  filesystem; pushing over the HMR socket is strictly better and about as much
  code. Marked `ponytail:` in `src/files.ts`.
- **localStorage carries a copy of the repo.** ~400 KB today, cap is ~5 MB. Strip
  `file:` Notes from the saved Doc when it starts to matter, not before.
- **`list()` walks everything each poll**, including `package-lock.json`. Fine at
  49 files; not at 5,000. An mtime-only listing endpoint fixes it when it hurts.
- **No `push`.** Deliberate — it needs a credentials conversation.
- **Undo crosses into the repo.** `Cmd+Z` on a file Note rewrites the file. That is
  correct and slightly alarming; it deserves a test that says so out loud.
- **The Stub is dead weight.** It was the v0 proof that the sandbox holds. Its job
  is done, and it is now two panes of noise in the seed. Delete it when something
  better wants that space.
- **`?safe=1` lists module Notes only.** With the repo mirrored, it could offer any
  file — but see #1: the safe shell is the wrong layer for that. `rescue.html` is.

---

## What I would do

**#1, then #2.** They are the vision's actual test — "I can work on this from
inside this" — and #1 is what makes #2 safe to build. #3 is the most *visible*
improvement and the one you have asked for twice, so if you would rather feel
progress than build the loop, do #3 first; it is also the smallest of the four.

#4 is the least interesting and the most obviously missing. Good filler, and a
reasonable thing to hand to a subagent while you and I work on #1.

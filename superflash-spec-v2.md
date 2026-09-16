# Superflash spec v2 — the repo is the document

v1 put the app's own Types in the document. But `src/kernel/*` is still just
files, and the app cannot see them. v2 closes that:

1. **Every file in the repo is a Note.** Including the kernel. Edit it in a pin,
   it lands on disk.
2. **A view you already know.** A `tree` Type — the familiar sidebar — as the
   default way in. It is a Type, so a project can replace it with its own view
   later. The filesystem is the default view, not the model.
3. **Git, from inside.** Not as a Type: as a capability. A panel over it is just
   UI.

## Why git is not a Type

A Type is a way to see and touch one Note. Git is neither — it is a verb over the
whole repo. So:

- The **bridge** (below) does the work: `git <args>` in the repo root.
- `host.fs().git([...])` is the call, behind a grant. (One verb, not two: `git` is
  just another thing the repo client does.)
- `seed/git-panel.js` is a Type: status, diff, message, commit. Optional, and
  replaceable, because it is only a view.

If git were a Type you would have to pin it somewhere to run `git status`, and
"where is git pinned" is a question with no good answer.

## The bridge

A Vite plugin — `plugins/bridge.ts` — mounted in dev only.

```
GET  /_fs/list                 → [{ path, size }]      text files under the repo
GET  /_fs/read?path=…          → { path, body }
POST /_fs/write { path, body } → { ok, mtime }
POST /_git { args: [...] }     → { code, stdout, stderr }
```

Rules, all enforced server-side:

- Every path is resolved and must stay inside the repo root. `..` is rejected,
  symlinks are resolved before the check.
- A denylist for the tree: `.git/`, `node_modules/`, `dist/`, anything binary or
  over ~512 KB.
- `_git` takes an argv **array**, never a string, and never goes through a shell.
  A short allowlist of subcommands: `init`, `status`, `diff`, `log`, `add`,
  `reset`, `commit`, `checkout`, `branch`, `stash`, `rev-parse`, `show`. `push` is
  not on it. The allowlist checks `argv[0]`, so `git -c user.email=… commit` is
  refused too — a flag before the subcommand would slip past the check.
- The plugin is `apply: 'serve'`. A production build has no bridge, and the app
  falls back to the seed. That is the security story, stated plainly.

### On grants and honesty

`host.fs()` is behind an `fs` grant, and the policy table gives
them to `cell`, `tree` and `git-panel` only.

That grant is for ergonomics and for the audit trail — one place that knows the
paths, one place to revoke. It is **not** a sandbox: a Type runs in the page and
the page has `fetch`, so any Type can reach the bridge directly. Sandboxing a
Type properly means a Machine, which has no fetch and no DOM. Don't pretend
otherwise in the code comments.

## Files as Notes

The note id **is** the path: `file:src/kernel/kernel.ts`.

No new model field, no index Note, no lookup table — the mapping is the id. (Ids
that are not `prefix_counter_rand` are already ignored by `seedIds`, so nothing
in the kernel needs to change.)

`src/files.ts`, trusted, ~80 lines:

```
sync(kernel, bridge):
  for each file in list():  upsert Note `file:<path>`  (disk wins on boot)
  prune Notes whose file is gone and which nothing pins
  kernel.watch: patch on a `file:` Note → debounced write(path, body)
  poll list() every few seconds → patch Notes whose mtime moved
```

Disk always wins on boot: the app is a view of the repo, not a second copy of it.

```
ponytail: file Notes go into localStorage with everything else, so the doc gets
big (the repo is ~200 KB of text). Strip them from the saved Doc if that starts
to hurt.
```

```
ponytail: polling, not a watcher. Vite already has an fs watcher — push it over
the existing HMR socket if a few seconds of lag turns out to be annoying.
```

### Editing the kernel from the app

The kernel is a file Note like any other. Editing it writes `src/kernel/*.ts`,
Vite reloads the page, and the new kernel boots. So it does hot-reload — via the
front door, a page load, not by patching a live kernel.

A syntax error in `kernel.ts` breaks the page load, not just a module. The safe
shell cannot save you from that; `git checkout` can, which is the real reason git
belongs in here.

## The `tree` Type

A sidebar. Boring on purpose.

- Folders from the paths of the `file:` Notes. Collapsible, `>`/`v`.
- Click a file: the tree emits `open-file`, and the canvas pins it on the Note you
  are looking at as `code`. Always `code`. One rule.
- A pin already open for that Note gets focused instead of a second pin.
- A `code` pin on a file Note shows the path and no Run button: a `.ts` file is a
  file, not a module, and Run could only ever be a compile error.

It ships pinned on the `chrome` Note down the left edge, so it does not pan with
the canvas.

### Custom views later

Nothing to build. The shell pin's Type is in the document, and so is the tree's.
A project that wants a different way in writes a Type and repins it. That is
already true in v1 — v2 just gives it something worth viewing.

## The `git-panel` Type

One pin, four parts: branch and status list, the diff of the selected path, a
message box, a commit button. `git add -A` is not offered; you stage what the
list shows you.

Everything it does is `host.fs().git([...])`. It holds no other power, and it
reports a missing repo as a missing repo rather than as a clean one.

## v2 to build, in order — all shipped

1. `plugins/bridge.ts`. `test/bridge.test.ts` — `..`, an escaping symlink, the
   denylist, the size cap, and `_git` refusing a string or an unlisted subcommand.
2. `host.fs()` + the `fs` grant + policy entries. `test/repo.test.ts` — a Stub is
   `Denied`; tree, git-panel and cell hold it.
3. `src/files.ts`. `test/files.test.ts` — a file becomes a Note, patching writes,
   a burst of keystrokes coalesces into one write, an outside edit lands, a
   deleted file is pruned unless something pins it, and a poll never clobbers what
   you are typing.
4. `seed/tree.js` on chrome. `test/repo.test.ts` — one pin per file, the second
   click focuses it.
5. `seed/git-panel.js`. `test/repo.test.ts` — argv arrays only, a message full of
   shell metacharacters survives intact, no repo reads as "no repo" not "clean".

Found on the way: a focused textarea used to ignore `onPatch`, so an outside edit
was dropped and the next keystroke wrote the stale body back over it. Fixed in
`code`, `cell` and `stub` — take the new body, keep the caret.

Done when you edit `src/kernel/spine.ts` in a pin, watch the page reload with
your change live, and commit it — without a terminal.

## Invariants (computable)

Keep v0's ten and v1's six. Add:

17. No path outside the repo root can be read or written, whatever the input.
18. `_git` never receives a string, and never runs an unlisted subcommand.
19. A production build has no bridge route and no `fs` grant in play.
20. Note id `file:<path>` ↔ that file, one to one, both directions.
21. On boot, disk wins over the stored Doc for every `file:` Note.
22. A Note whose file was deleted, and which nothing pins, is gone after a sync.

## Still later

- `push` — needs credentials, so it needs a conversation about where those live.
- The `agent` Type from v1, now much more interesting: it can read the whole
  repo, write a file, and commit.
- Two people on one Superflash. The Spine is already the right shape; the document is
  not.

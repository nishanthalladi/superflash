# Desk spec v3 — layout is a Type

v2 gave the tree a `chrome` Note: a privileged layer the Desk drew on top,
floating over the canvas. That was wrong twice over — the sidebar wasn't really
always-visible, it was just overlapping, and "chrome" was a special case in a
system whose whole claim is that everything is a Note.

v3 deletes the special case.

## What changed

- **`chrome` is gone** from the kernel, from `Doc`, and from the Desk.
- **`split`** is a new seed Type: a Note whose body is `row` or `col`, whose child
  pins are its panes, with a draggable divider between them. Splits nest.
- The shell is now a `split`: a `col` of [palette, `row` of [tree, desk]]. The
  Desk is one pane among others, and it no longer knows anything is above it.

No dock field. No layout engine in the kernel. Layout is a Type, so a project
that wants a different shape writes one — the same answer as "a project that
wants a different view writes a Type".

## Sizes reuse Pin geometry

A pane's size is `pin.width` in a row, `pin.height` in a column. `0` means
"take what's left".

So dragging a divider is `kernel.move` — which means the layout is in the
document, undoable, autosaved, and ejectable, with no new field anywhere. Order
along the axis is `x` in a row, `y` in a column.

That also answers the open question from v2's design: ratios live in the
document, not in view state, because a Pin already stores exactly that.

## Migration

The stored-document key is now `desk:doc:v2` and `Doc.version` is `2`. A document
written before `split` is simply left in the old key, and the shipped seed boots.
Not worth migration code for a document you can rebuild by pressing `?fresh=1`.

## Repaints, and why they matter

A split rebuilds its DOM only when its own children change. A pane resize sets
`flex` in place instead: removing a focused element from the document blurs it,
so a rebuild on every `pin:move` would have made dragging anything on the canvas
steal focus from whatever you were typing in.

A pane's Type being redefined rebuilds that pane and only that pane, by comparing
factory identity — the same trick `stage0` uses for the shell.

## Invariants (computable)

Keep v0–v2. Add:

23. Nothing in the kernel knows what is always on screen. `grep chrome src/` is
    empty.
24. A dragged divider shows up in `toJSON()` and undoes in one step.
25. Redefining one pane's Type leaves its siblings mounted.
26. Resizing a pane does not blur what is focused inside another one.
27. A pane whose Type will not compile shows the error in that pane; the rest of
    the layout still works. Only a broken *layout* Type reaches the safe shell.

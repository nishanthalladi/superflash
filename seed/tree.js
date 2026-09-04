export const type = { name: 'tree', title: 'Tree' };

/**
 * The sidebar. Boring on purpose — a filesystem view is the one thing everybody
 * already knows how to read.
 *
 * It lists the repo through the bridge and emits `open-file`; the Desk does the
 * pinning, because the Desk is the thing that knows where you are looking. So the
 * tree holds `fs` and nothing else.
 *
 * It is a Type, so a project that wants a different way in writes its own and
 * repins it. The filesystem is the default view, not the model.
 */
export default function (host) {
  let root;
  let list;
  let status;
  const open = new Set(['src', 'seed', 'test']);

  function tree(paths) {
    const top = { dirs: new Map(), files: [] };
    for (const path of paths) {
      const parts = path.split('/');
      let node = top;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1], path });
    }
    return top;
  }

  function draw(node, prefix, depth) {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const shown = open.has(path);

      const row = document.createElement('button');
      row.className = 'tree-dir';
      row.style.paddingLeft = `${depth * 12 + 6}px`;
      row.textContent = `${shown ? '▾' : '▸'} ${name}`;
      row.onclick = () => {
        if (shown) open.delete(path);
        else open.add(path);
        render();
      };
      list.append(row);

      if (shown) draw(child, path, depth + 1);
    }

    for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const row = document.createElement('button');
      row.className = 'tree-file';
      row.style.paddingLeft = `${depth * 12 + 18}px`;
      row.textContent = file.name;
      row.title = file.path;
      row.onclick = () => host.emit('open-file', { path: file.path });
      list.append(row);
    }
  }

  let paths = [];

  function render() {
    list.replaceChildren();
    draw(tree(paths), '', 0);
    status.textContent = `${paths.length} files`;
  }

  async function load() {
    status.textContent = 'reading…';
    try {
      paths = (await host.fs().list()).map((e) => e.path);
      render();
    } catch (err) {
      list.replaceChildren();
      status.textContent = err && err.message ? err.message : String(err);
    }
  }

  return {
    mount(box) {
      root = box;
      root.classList.add('tree');

      const head = document.createElement('div');
      head.className = 'tree-head';
      const refresh = document.createElement('button');
      refresh.textContent = '↻';
      refresh.title = 'Read the repo again';
      refresh.onclick = () => void load();
      status = document.createElement('span');
      status.className = 'tree-status';
      head.append(refresh, status);

      list = document.createElement('div');
      list.className = 'tree-list';

      root.append(head, list);
      void load();
    },

    /** The split rebuilds this pane when a Type is redefined; ↻ is the manual one. */
    reload: load,
  };
}

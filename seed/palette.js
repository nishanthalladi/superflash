export const type = { name: 'palette', title: 'Palette' };

/**
 * The toolbar — a Type, pinned on the `chrome` Note. The app's own furniture is
 * a Note like everything else, which is the point.
 *
 * It needs `types` to list what exists; everything it *does* it does by emitting
 * facts the Desk picks up, so it holds no other power.
 */
export default function (host) {
  let list;
  let armed = '';

  function draw() {
    list.replaceChildren();
    for (const info of host.listTypes()) {
      const b = document.createElement('button');
      b.textContent = info.title;
      b.className = info.name === armed ? 'armed' : '';
      b.title = info.source ? `from ${info.source}` : 'built in';
      b.onclick = () => {
        armed = info.name;
        host.emit('arm', { type: info.name });
        draw();
      };
      list.append(b);
    }
  }

  return {
    mount(box) {
      box.classList.add('palette');

      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = 'types';

      list = document.createElement('div');
      list.className = 'palette-list';

      const cell = document.createElement('button');
      cell.className = 'palette-new';
      cell.textContent = '+ cell';
      cell.title = 'New Cell';
      cell.onclick = () => host.emit('new-cell');

      const mod = document.createElement('button');
      mod.className = 'palette-new';
      mod.textContent = '+ module';
      mod.title = 'New Code note';
      mod.onclick = () => host.emit('new-module');

      box.append(label, list, cell, mod);
      draw();
    },

    /** The Desk remounts chrome when the registry changes, but stay honest. */
    onSpine() {
      draw();
    },
  };
}

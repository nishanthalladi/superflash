// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { SHELL } from '../src/kernel/grants';
import { plain, split } from './help';

/**
 * `split` is not pinned in the shipped seed any more — the app is a bare canvas.
 * It is still the answer for a project that wants panes, so it is still built and
 * still tested: a Note whose body is `row` or `col`, whose child pins are panes.
 */
function setup(body = 'row') {
  const root = document.createElement('div');
  document.body.replaceChildren(root);

  const kernel = new Kernel();
  kernel.types.define('split', split);
  kernel.types.define('plain', plain);

  const layout = kernel.createNote(body);
  const left = kernel.pin(kernel.createNote('left').id, layout.id, 'plain', { x: 0, width: 264 });
  const right = kernel.pin(kernel.createNote('right').id, layout.id, 'plain', { x: 1, width: 0 });

  const shell = kernel.createNote('root');
  kernel.root = shell.id;
  const pin = kernel.pin(layout.id, shell.id, 'split');
  kernel.grants.give(pin.id, SHELL);
  const instance = kernel.types.get('split')(kernel.host(pin.id));
  kernel.attach(pin.id, instance);
  instance.mount(root, kernel.note(layout.id));

  return { kernel, root, layout, left, right };
}

const down = (el: Element, o: MouseEventInit) =>
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...o }));
const move = (o: MouseEventInit) => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...o }));
const up = () => window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('a divider is just a pin resize', () => {
  it('lays panes out along the axis', () => {
    const { root } = setup('row');
    expect(root.classList.contains('split-row')).toBe(true);
    const panes = [...root.querySelectorAll<HTMLElement>('.split-pane')];
    expect(panes).toHaveLength(2);
    expect(panes[0]!.style.flex).toBe('0 0 264px');
    expect(panes[1]!.style.flex).toBe('1 1 0%');
  });

  it('lands in the document and undoes in one step', () => {
    const { kernel, root, left } = setup();

    down(root.querySelector('.split-bar')!, { clientX: 264, clientY: 100 });
    for (const x of [280, 300, 320]) move({ clientX: x, clientY: 100 });
    up();

    expect(kernel.getPin(left.id).width).toBe(320);
    expect(kernel.toJSON().pins.find((p) => p.id === left.id)!.width).toBe(320);

    kernel.journal.undo();
    expect(kernel.getPin(left.id).width).toBe(264);
  });

  it('refuses to squeeze a pane to nothing', () => {
    const { kernel, root, left } = setup();
    down(root.querySelector('.split-bar')!, { clientX: 264, clientY: 100 });
    move({ clientX: -900, clientY: 100 });
    up();
    expect(kernel.getPin(left.id).width).toBe(48);
  });

  it('resizes without blurring what is focused in another pane', () => {
    const { root } = setup();
    const area = root.querySelectorAll<HTMLTextAreaElement>('.plain')[1]!;
    area.focus();
    area.setSelectionRange(2, 2);

    down(root.querySelector('.split-bar')!, { clientX: 264, clientY: 100 });
    move({ clientX: 300, clientY: 100 });
    up();

    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(2);
  });

  it('re-lays-out when the split Note says so', () => {
    const { kernel, root, layout } = setup('row');
    expect(root.classList.contains('split-row')).toBe(true);
    kernel.patch(layout.id, 'col');
    expect(root.classList.contains('split-col')).toBe(true);
    expect(root.classList.contains('split-row')).toBe(false);
  });

  it('drops a pane when its pin goes', () => {
    const { kernel, root, right } = setup();
    kernel.unpin(right.id);
    expect(root.querySelectorAll('.split-pane')).toHaveLength(1);
    expect(root.querySelectorAll('.split-bar')).toHaveLength(0);
  });
});

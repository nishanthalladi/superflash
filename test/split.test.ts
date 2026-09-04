// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { fakeFs } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
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
  it('lands in the document and undoes in one step', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: fakeFs({ 'a.ts': 'a' }).fs });
    const tree = kernel.allPins().find((p) => p.type === 'tree')!;
    expect(tree.width).toBe(264);

    const bar = root.querySelector('.split-row > .split-bar')!;
    down(bar, { clientX: 264, clientY: 100 });
    for (const x of [280, 300, 320]) move({ clientX: x, clientY: 100 });
    up();

    expect(kernel.getPin(tree.id).width).toBe(320);
    expect(kernel.toJSON().pins.find((p) => p.id === tree.id)!.width).toBe(320);

    kernel.journal.undo();
    expect(kernel.getPin(tree.id).width).toBe(264);
  });

  it('refuses to squeeze a pane to nothing', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: fakeFs({ 'a.ts': 'a' }).fs });
    const tree = kernel.allPins().find((p) => p.type === 'tree')!;

    down(root.querySelector('.split-row > .split-bar')!, { clientX: 264, clientY: 100 });
    move({ clientX: -900, clientY: 100 });
    up();

    expect(kernel.getPin(tree.id).width).toBe(48);
  });

  it('resizes without blurring what is focused in another pane', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: fakeFs({ 'a.ts': 'a' }).fs });
    const source = root.querySelector<HTMLTextAreaElement>('.pin[data-type="cell"] .cell-source')!;
    source.focus();
    source.setSelectionRange(3, 3);

    down(root.querySelector('.split-row > .split-bar')!, { clientX: 264, clientY: 100 });
    move({ clientX: 300, clientY: 100 });
    up();

    expect(document.activeElement).toBe(source);
    expect(source.selectionStart).toBe(3);
    expect(kernel.allPins().find((p) => p.type === 'tree')!.width).toBe(300);
  });

  it('re-lays-out when the split Note says so', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { fs: fakeFs({ 'a.ts': 'a' }).fs });
    const layout = kernel.getPin(shell!).note;

    // The outer split's box is `root` itself.
    expect(root.classList.contains('split-col')).toBe(true);
    kernel.patch(layout, 'row');
    expect(root.classList.contains('split-row')).toBe(true);
    expect(root.classList.contains('split-col')).toBe(false);
  });
});

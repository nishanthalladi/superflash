// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { mountCanvas, plain } from './help';

function setup() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('stub', plain);
  k.types.define('box', plain);
  const desk = k.createNote('desk');
  return { k, desk, root };
}

const q = (root: HTMLElement, sel: string) => root.querySelectorAll<HTMLElement>(sel);
const body = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.plain')!;

beforeEach(() => document.body.replaceChildren());

describe('Notes, pins, pan and zoom', () => {
  it('draws a pin per child and pans and zooms the canvas', () => {
    const { k, desk, root } = setup();
    k.pin(k.createNote('a').id, desk.id, 'stub', { x: 10, y: 20 });
    k.pin(k.createNote('b').id, desk.id, 'stub', { x: 300, y: 20 });
    mountCanvas(k, root, desk.id);

    const pins = q(root, '.pin');
    expect(pins).toHaveLength(2);
    expect(pins[0]!.style.left).toBe('10px');

    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
    const layer = root.querySelector<HTMLElement>('.canvas-layer')!;
    expect(layer.style.transform).toBe('translate(0px, 0px) scale(1)');

    viewport.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    viewport.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 15 }));
    expect(layer.style.transform).toBe('translate(40px, 15px) scale(1)');
    viewport.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    viewport.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 0, clientY: 0 }),
    );
    expect(layer.style.transform).toMatch(/scale\(1\.1/);
  });
});

describe('click to focus', () => {
  it('focuses the clicked pin, and only that one', () => {
    const { k, desk, root } = setup();
    const p1 = k.pin(k.createNote('a').id, desk.id, 'stub');
    const p2 = k.pin(k.createNote('b').id, desk.id, 'stub', { x: 300 });
    mountCanvas(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.pin')];
    boxB!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).toBe(p2.id);
    expect(boxB!.classList.contains('focused')).toBe(true);
    expect(boxA!.classList.contains('focused')).toBe(false);

    boxA!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).toBe(p1.id);
    expect(q(root, '.pin.focused')).toHaveLength(1);
  });

  it('clicking bare canvas clears focus', () => {
    const { k, desk, root } = setup();
    k.pin(k.createNote('a').id, desk.id, 'stub');
    mountCanvas(k, root, desk.id);
    q(root, '.pin')[0]!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).not.toBeNull();
    root
      .querySelector<HTMLElement>('.canvas-viewport')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).toBeNull();
  });
});


describe('one Note, two pins, one body', () => {
  it('typing in one pin updates the other', () => {
    const { k, desk, root } = setup();
    const shared = k.createNote('before');
    k.pin(shared.id, desk.id, 'stub');
    k.pin(shared.id, desk.id, 'stub', { x: 300 });
    mountCanvas(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.pin')];
    body(boxA!).value = 'after';
    body(boxA!).dispatchEvent(new Event('input', { bubbles: true }));

    expect(k.note(shared.id).body).toBe('after');
    expect(body(boxB!).value).toBe('after');
  });
});



describe('nesting: double-click enters a Note, Escape leaves', () => {
  it('drills in and back out', () => {
    const { k, desk, root } = setup();
    const inner = k.createNote('inner');
    k.pin(inner.id, desk.id, 'stub');
    k.pin(k.createNote('x').id, inner.id, 'stub');
    k.pin(k.createNote('y').id, inner.id, 'stub', { x: 300 });
    const { instance: view } = mountCanvas(k, root, desk.id);

    expect(view.noteId).toBe(desk.id);
    q(root, '.pin')[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(view.noteId).toBe(inner.id);
    expect(q(root, '.pin')).toHaveLength(2);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.noteId).toBe(desk.id);
    expect(q(root, '.pin')).toHaveLength(1);
  });
});

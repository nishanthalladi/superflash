// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { canvas, mountCanvas, text } from './help';

function setup() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('canvas', canvas);
  k.types.define('text', text);
  const desk = k.createNote('desk');
  return { k, desk, root };
}

const q = (root: HTMLElement, sel: string) => root.querySelectorAll<HTMLElement>(sel);
const body = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.text-body')!;

beforeEach(() => document.body.replaceChildren());

describe('Notes, pins, pan and zoom', () => {
  it('draws a pin per child and pans and zooms the canvas', () => {
    const { k, desk, root } = setup();
    k.pin(k.createNote('a').id, desk.id, 'canvas', { x: 10, y: 20 });
    k.pin(k.createNote('b').id, desk.id, 'canvas', { x: 300, y: 20 });
    mountCanvas(k, root, desk.id);

    const pins = q(root, '.canvas-viewport > .canvas-layer > .pin');
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
    const p1 = k.pin(k.createNote('a').id, desk.id, 'canvas');
    const p2 = k.pin(k.createNote('b').id, desk.id, 'canvas', { x: 300 });
    mountCanvas(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.canvas-viewport > .canvas-layer > .pin')];
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
    k.pin(k.createNote('a').id, desk.id, 'canvas');
    mountCanvas(k, root, desk.id);
    q(root, '.canvas-viewport > .canvas-layer > .pin')[0]!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
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
    k.pin(shared.id, desk.id, 'text');
    k.pin(shared.id, desk.id, 'text', { x: 300 });
    mountCanvas(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.canvas-viewport > .canvas-layer > .pin')];
    body(boxA!).value = 'after';
    body(boxA!).dispatchEvent(new Event('input', { bubbles: true }));

    // 'before' is the name, so it stays on the bar; the text is what changed.
    expect(k.note(shared.id).body).toBe('before\nafter');
    expect(body(boxB!).value).toBe('after');
  });
});



describe('nesting: double-click enters a Note, Escape leaves', () => {
  it('drills in and back out', () => {
    const { k, desk, root } = setup();
    const inner = k.createNote('inner');
    k.pin(inner.id, desk.id, 'canvas');
    k.pin(k.createNote('x').id, inner.id, 'canvas');
    k.pin(k.createNote('y').id, inner.id, 'canvas', { x: 300 });
    const { instance: view } = mountCanvas(k, root, desk.id);

    expect(view.noteId).toBe(desk.id);
    q(root, '.canvas-bar')[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(view.noteId).toBe(inner.id);
    expect(q(root, '.canvas-viewport > .canvas-layer > .pin')).toHaveLength(2);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.noteId).toBe(desk.id);
    expect(q(root, '.canvas-viewport > .canvas-layer > .pin')).toHaveLength(1);
  });
});

describe('a Type is a way of looking', () => {
  it('right-click on the title bar shows the note you are inside as another Type — view state only', () => {
    const { k, desk, root } = setup();
    k.patch(desk.id, 'desk\nwhat the desk says');
    k.pin(k.createNote('a').id, desk.id, 'canvas');
    const { instance: view } = mountCanvas(k, root, desk.id);
    const doc = JSON.stringify(k.toJSON());

    root
      .querySelector<HTMLElement>('.canvas-head')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'text')!.click();

    expect(view.viewAs).toBe('text');
    expect(root.querySelector<HTMLElement>('.canvas-viewport')!.hidden).toBe(true);
    const full = root.querySelector<HTMLTextAreaElement>('.canvas-full .text-body')!;
    expect(full.value).toBe('what the desk says');
    full.value = 'edited inside';
    full.dispatchEvent(new Event('input', { bubbles: true }));
    expect(k.body(desk.id)).toBe('desk\nedited inside');
    // No pin was made or changed: how you look is not in the document.
    expect(k.allPins().map((p) => p.type)).toEqual(JSON.parse(doc).pins.map((p: { type: string }) => p.type));

    view.setView('canvas');
    expect(root.querySelector('.canvas-full')).toBeNull();
    expect(root.querySelectorAll('.canvas-viewport > .canvas-layer > .pin')).toHaveLength(1);
  });

  it('the menu on the bar re-pins the same note as another Type, in one undo step', () => {
    const { k, desk, root } = setup();
    const note = k.createNote('name\nsome words');
    const pin = k.pin(note.id, desk.id, 'canvas');
    k.types.define('tool', () => ({ mount() {} }), { lens: false });
    mountCanvas(k, root, desk.id);

    root
      .querySelector<HTMLElement>('.pin .canvas-bar')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    const menu = document.querySelector<HTMLElement>('.canvas-menu')!;
    const items = [...menu.querySelectorAll('button')];
    expect(items.map((b) => b.textContent)).toContain('text');
    // A tool is not a lens: registered, but not offered.
    expect(items.map((b) => b.textContent)).not.toContain('tool');
    items.find((b) => b.textContent === 'text')!.click();
    expect(document.querySelector('.canvas-menu')).toBeNull();
    const now = k.childPins(desk.id);
    expect(now).toHaveLength(1);
    expect(now[0]!.type).toBe('text');
    expect(now[0]!.note).toBe(note.id);
    expect(k.hasPin(pin.id)).toBe(false);
    expect(body(root.querySelector<HTMLElement>('.pin')!).value).toBe('some words');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(k.hasPin(pin.id)).toBe(true);
    expect(k.childPins(desk.id)).toHaveLength(1);
  });

  it('typing on bare canvas writes on the paper; a canvas never becomes text itself', () => {
    const { k, desk, root } = setup();
    mountCanvas(k, root, desk.id);
    expect(k.childPins(desk.id)).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));

    // No pin: the letter lands in an editor over the paper (see paper.test.ts).
    expect(k.childPins(desk.id)).toHaveLength(0);
    expect(document.activeElement).toBe(root.querySelector('.canvas-ink-edit'));
    // The surface itself is untouched: still a canvas, still showing its boxes.
    expect(k.body(desk.id)).toBe('desk');
    expect(root.querySelector('.canvas-viewport')).not.toBeNull();
  });
});

describe('a canvas inside a canvas is a world of its own', () => {
  it('takes the wheel and the drag, and the outer camera does not move', () => {
    const { k, desk, root } = setup();
    const inner = k.createNote('inner');
    k.pin(inner.id, desk.id, 'canvas', { x: 100, y: 100, width: 400, height: 300 });
    k.pin(k.createNote('deep').id, inner.id, 'text', { x: 10, y: 10 });
    mountCanvas(k, root, desk.id);

    const outerLayer = root.querySelector<HTMLElement>('.canvas-viewport > .canvas-layer')!;
    const insideView = root.querySelector<HTMLElement>('.canvas-inside')!;
    const insideLayer = insideView.querySelector<HTMLElement>('.canvas-layer')!;
    const before = outerLayer.style.transform;

    insideView.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    expect(outerLayer.style.transform).toBe(before);
    expect(insideLayer.style.transform).toMatch(/scale\(1\.1/);

    insideView.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    insideView.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 0 }));
    insideView.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(outerLayer.style.transform).toBe(before);
    expect(insideLayer.style.transform).toMatch(/translate\(30px/);
    // Clicking the paper inside a box selects the box.
    expect(k.focus()).toBe(k.pinsOf(inner.id)[0]!.id);
  });

  it('double-click inside makes the box there, not on the outer surface', () => {
    const { k, desk, root } = setup();
    const inner = k.createNote('inner');
    k.pin(inner.id, desk.id, 'canvas');
    mountCanvas(k, root, desk.id);
    root
      .querySelector<HTMLElement>('.canvas-inside')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    expect(k.childPins(inner.id)).toHaveLength(1);
    expect(k.childPins(desk.id)).toHaveLength(1);
  });
});

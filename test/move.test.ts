// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { canvas, mountCanvas, text } from './help';

/** Moving a box into another note: by drag, by cut and paste, by the bar menu. */

function setup(types: string[] = ['canvas', 'canvas']) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('canvas', canvas);
  k.types.define('text', text);
  const desk = k.createNote('desk');
  const pins = types.map((t, i) => k.pin(k.createNote(`n${i}`).id, desk.id, t, { x: i * 300, y: 0, width: 240, height: 160 }));
  const { instance: view } = mountCanvas(k, root, desk.id);
  const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
  return { k, desk, root, view, pins, viewport };
}

const bar = (root: HTMLElement, i = 0) => [...root.querySelectorAll<HTMLElement>('.canvas-bar')][i]!;
const ev = (el: Element, type: string, o: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...o }));
const key = (k: string, o: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
/** Drag the first bar and drop at `to` (the second box covers 300..540 × 0..160). */
const dragTo = (root: HTMLElement, viewport: HTMLElement, to: [number, number]) => {
  ev(bar(root), 'pointerdown', { clientX: 0, clientY: 0 });
  ev(viewport, 'pointermove', { clientX: to[0] / 2, clientY: to[1] / 2 });
  ev(viewport, 'pointermove', { clientX: to[0], clientY: to[1] });
  ev(viewport, 'pointerup', { clientX: to[0], clientY: to[1] });
};
const rows = () => [...document.querySelectorAll<HTMLElement>('.canvas-menu button span')].map((s) => s.textContent);
const pick = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.canvas-menu button')].find((b) => b.querySelector('span')?.textContent === label)!.click();

beforeEach(() => document.body.replaceChildren());

describe('drag into a box', () => {
  it('drops the box inside a canvas box; one undo brings it back', () => {
    const { k, desk, root, viewport, pins } = setup();
    const [a, b] = pins.map((p) => p.note);
    ev(bar(root), 'pointerdown', { clientX: 0, clientY: 0 });
    ev(viewport, 'pointermove', { clientX: 400, clientY: 50 });
    expect(root.querySelector('.pin.drop-target')?.getAttribute('data-pin')).toBe(pins[1]!.id);
    ev(viewport, 'pointerup', { clientX: 400, clientY: 50 });

    expect(k.hasPin(pins[0]!.id)).toBe(false);
    expect(k.childPins(desk.id).map((p) => p.note)).toEqual([b]);
    expect(k.childPins(b!).map((p) => p.note)).toEqual([a]);
    // It lands where the pointer let go, in the target's own coordinates; size and Type travel with it.
    expect(k.childPins(b!)[0]).toMatchObject({ width: 240, height: 160, type: 'canvas' });
    expect(root.querySelector('.pin.drop-target')).toBeNull();

    key('z', { metaKey: true });
    expect(k.hasPin(pins[0]!.id)).toBe(true);
    expect(k.childPins(b!)).toHaveLength(0);
    expect(k.childPins(desk.id)).toHaveLength(2);
  });

  it('does nothing over a text box', () => {
    const { k, desk, root, viewport, pins } = setup(['canvas', 'text']);
    dragTo(root, viewport, [400, 50]);
    expect(k.hasPin(pins[0]!.id)).toBe(true);
    expect(k.childPins(desk.id)).toHaveLength(2);
    expect(k.childPins(pins[1]!.note)).toHaveLength(0);
  });

  it('refuses a cycle', () => {
    const { k, desk, root, viewport, pins } = setup();
    const [a, b] = pins.map((p) => p.note);
    k.pin(b!, a!, 'canvas');
    dragTo(root, viewport, [400, 50]);
    expect(k.hasPin(pins[0]!.id)).toBe(true);
    expect(k.childPins(desk.id)).toHaveLength(2);
    expect(k.childPins(b!)).toHaveLength(0);
  });
});

describe('cut and paste', () => {
  it('Cmd+X then Cmd+V moves a box into the note you entered', () => {
    const { k, desk, root, view, pins } = setup();
    const [a, b] = pins.map((p) => p.note);
    ev(root.querySelector('.pin')!, 'pointerdown');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(k.focus()).toBe(pins[0]!.id);

    key('x', { metaKey: true });
    expect(k.hasPin(pins[0]!.id)).toBe(false);
    expect(k.childPins(desk.id)).toHaveLength(1);

    view.enter(b!);
    key('v', { metaKey: true });
    expect(k.childPins(b!).map((p) => p.note)).toEqual([a]);
    expect(k.childPins(b!)[0]).toMatchObject({ type: 'canvas', width: 240, height: 160 });
    expect(k.focus()).toBe(k.childPins(b!)[0]!.id);
  });

  it('Cmd+X inside a text field is left to the field', () => {
    const { k, root, pins } = setup();
    ev(root.querySelector('.pin')!, 'pointerdown');
    root.querySelector<HTMLInputElement>('.canvas-name')!.focus();
    key('x', { metaKey: true });
    expect(k.hasPin(pins[0]!.id)).toBe(true);
  });
});

describe('move to…', () => {
  it('lists the canvases but not the box itself, and picking one moves it', () => {
    const { k, desk, root, pins } = setup(['canvas', 'canvas', 'text']);
    const [a, b, c] = pins.map((p) => p.note);
    ev(bar(root), 'contextmenu', { clientX: 10, clientY: 10 });
    pick('move to…');
    expect(document.querySelector('.canvas-menu-search')).not.toBeNull();
    expect(rows()).toEqual(['desk', 'n1']);

    pick('n1');
    expect(k.hasPin(pins[0]!.id)).toBe(false);
    expect(k.childPins(b!).map((p) => p.note)).toEqual([a]);
    expect(k.childPins(b!)[0]).toMatchObject({ x: 40, y: 40 });
    expect(k.childPins(desk.id).map((p) => p.note)).toEqual([b, c]);
  });

  it('leaves out what the box already holds', () => {
    const { k, root, pins } = setup();
    const [a, b] = pins.map((p) => p.note);
    k.pin(b!, a!, 'canvas');
    ev(bar(root), 'contextmenu', { clientX: 10, clientY: 10 });
    pick('move to…');
    expect(rows()).toEqual(['desk']);
  });
});

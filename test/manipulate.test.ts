// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { mountCanvas, plain } from './help';

function setup(pins = 2) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('stub', plain);
  k.types.define('box', plain);
  const desk = k.createNote('desk');
  const made = [];
  for (let i = 0; i < pins; i += 1) {
    made.push(k.pin(k.createNote(`n${i}`).id, desk.id, 'stub', { x: i * 300, y: 0, width: 240, height: 160 }));
  }
  const { instance: view } = mountCanvas(k, root, desk.id);
  return { k, desk, root, view, pins: made };
}

/** The drag pad on the title bar. The name field beside it only takes a caret. */
const grip = (root: HTMLElement, i = 0) => [...root.querySelectorAll<HTMLElement>('.pin-drag')][i]!;
const handle = (root: HTMLElement, i = 0) => [...root.querySelectorAll<HTMLElement>('.pin-resize')][i]!;
const down = (el: HTMLElement, o: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...o }));
const move = (el: HTMLElement, o: MouseEventInit) =>
  el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...o }));
const up = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
const key = (k: string, o: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));

beforeEach(() => document.body.replaceChildren());

describe('drag to move', () => {
  it('moves the pin and snaps to the grid', () => {
    const { k, root, pins } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;

    down(grip(root), { clientX: 0, clientY: 0 });
    move(viewport, { clientX: 43, clientY: 27 });
    up(viewport);

    expect(k.getPin(pins[0]!.id)).toMatchObject({ x: 40, y: 24 });
    expect(k.focus()).toBe(pins[0]!.id);
  });

  it('leaves geometry alone when the drag starts inside the Type', () => {
    const { k, root, pins } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
    const face = root.querySelector<HTMLElement>('.pin-face')!;

    down(face, { clientX: 0, clientY: 0 });
    move(viewport, { clientX: 100, clientY: 100 });
    up(viewport);

    expect(k.getPin(pins[0]!.id)).toMatchObject({ x: 0, y: 0 });
  });

  it('resizes from the corner and refuses to go tiny', () => {
    const { k, root, pins } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;

    down(handle(root), { clientX: 0, clientY: 0 });
    move(viewport, { clientX: 80, clientY: 40 });
    up(viewport);
    expect(k.getPin(pins[0]!.id)).toMatchObject({ width: 320, height: 200 });

    down(handle(root), { clientX: 0, clientY: 0 });
    move(viewport, { clientX: -900, clientY: -900 });
    up(viewport);
    expect(k.getPin(pins[0]!.id)).toMatchObject({ width: 64, height: 64 });
  });

  it('alt+drag makes a second pin of the same Note', () => {
    const { k, root, pins } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
    const note = k.getPin(pins[0]!.id).note;

    down(grip(root), { clientX: 0, clientY: 0, altKey: true });
    move(viewport, { clientX: 200, clientY: 100 });
    up(viewport);

    const copies = k.pinsOf(note);
    expect(copies).toHaveLength(2);
    expect(k.focus()).not.toBe(pins[0]!.id);
    expect(k.getPin(pins[0]!.id)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('create and delete', () => {
  it('double-clicking bare canvas makes an empty box', () => {
    const { k, root, desk } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;

    viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));

    expect(k.childPins(desk.id)).toHaveLength(3);
    const made = k.getPin(k.focus()!);
    // Nothing to arm any more: a new box is a box.
    expect(made.type).toBe('box');
    expect(k.body(made.note)).toBe('');
    expect(root.querySelectorAll('.pin')).toHaveLength(3);
  });

  it('Backspace unpins the focused pin, but not while typing', () => {
    const { k, root, pins, desk } = setup();
    root.querySelector<HTMLElement>('.pin')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).toBe(pins[0]!.id);

    const field = root.querySelector<HTMLTextAreaElement>('.plain')!;
    field.focus();
    key('Backspace');
    expect(k.childPins(desk.id)).toHaveLength(2);

    field.blur();
    key('Backspace');
    expect(k.childPins(desk.id)).toHaveLength(1);
    expect(k.hasPin(pins[0]!.id)).toBe(false);
  });

  it('Cmd+D duplicates the pin, not the Note', () => {
    const { k, root, pins } = setup();
    root.querySelector<HTMLElement>('.pin')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    key('d', { metaKey: true });

    const note = k.getPin(pins[0]!.id).note;
    expect(k.pinsOf(note)).toHaveLength(2);
    // desk, n0, n1 and the shell Note the canvas is pinned on.
    expect(k.allNotes()).toHaveLength(4);
  });
});

describe('undo', () => {
  it('puts a moved pin back where it was, in one step', () => {
    const { k, root, pins } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;

    down(grip(root), { clientX: 0, clientY: 0 });
    for (const x of [10, 20, 30, 40, 56]) move(viewport, { clientX: x, clientY: 0 });
    up(viewport);
    expect(k.getPin(pins[0]!.id).x).toBe(56);

    key('z', { metaKey: true });
    expect(k.getPin(pins[0]!.id).x).toBe(0);

    key('z', { metaKey: true, shiftKey: true });
    expect(k.getPin(pins[0]!.id).x).toBe(56);
  });

  it('restores a deleted pin with its id', () => {
    const { k, root, pins, desk } = setup();
    root.querySelector<HTMLElement>('.pin')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    key('Backspace');
    expect(k.hasPin(pins[0]!.id)).toBe(false);

    key('z', { metaKey: true });
    expect(k.hasPin(pins[0]!.id)).toBe(true);
    expect(k.childPins(desk.id)).toHaveLength(2);
    expect(root.querySelectorAll('.pin')).toHaveLength(2);
  });

  it('undoes a created pin in one step, and typing as one edit', () => {
    const { k, root, desk } = setup();
    const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
    viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    expect(k.childPins(desk.id)).toHaveLength(3);

    key('z', { metaKey: true });
    expect(k.childPins(desk.id)).toHaveLength(2);

    const note = k.childPins(desk.id)[0]!.note;
    for (const body of ['h', 'he', 'hel', 'hell', 'hello']) k.patch(note, body);
    key('z', { metaKey: true });
    expect(k.body(note)).toBe('n0');
  });
});

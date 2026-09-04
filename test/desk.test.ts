// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { mountDesk, stub } from './help';
import { readGrant } from '../src/kernel/grants';

function setup() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('stub', stub);
  const desk = k.createNote('desk');
  return { k, desk, root };
}

const q = (root: HTMLElement, sel: string) => root.querySelectorAll<HTMLElement>(sel);
const body = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.stub-body')!;

beforeEach(() => document.body.replaceChildren());

describe('v0 item 1 & 2: Notes, Pins, pan/zoom', () => {
  it('draws a pin per child and pans and zooms the canvas', () => {
    const { k, desk, root } = setup();
    k.pin(k.createNote('a').id, desk.id, 'stub', { x: 10, y: 20 });
    k.pin(k.createNote('b').id, desk.id, 'stub', { x: 300, y: 20 });
    mountDesk(k, root, desk.id);

    const pins = q(root, '.pin');
    expect(pins).toHaveLength(2);
    expect(pins[0]!.style.left).toBe('10px');

    const viewport = root.querySelector<HTMLElement>('.desk-viewport')!;
    const layer = root.querySelector<HTMLElement>('.desk-layer')!;
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

describe('v0 item 3: click to focus', () => {
  it('focuses the clicked pin, and only that one', () => {
    const { k, desk, root } = setup();
    const p1 = k.pin(k.createNote('a').id, desk.id, 'stub');
    const p2 = k.pin(k.createNote('b').id, desk.id, 'stub', { x: 300 });
    mountDesk(k, root, desk.id);

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
    mountDesk(k, root, desk.id);
    q(root, '.pin')[0]!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).not.toBeNull();
    root
      .querySelector<HTMLElement>('.desk-viewport')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(k.focus()).toBeNull();
  });
});

describe('v0 item 4: the Stub Type', () => {
  it('shows its body, and emitting reaches a listener', () => {
    const { k, desk, root } = setup();
    const a = k.createNote('hello A');
    const b = k.createNote('hello B');
    const pinA = k.pin(a.id, desk.id, 'stub');
    const pinB = k.pin(b.id, desk.id, 'stub', { x: 300 });
    mountDesk(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.pin')];
    expect(body(boxA!).value).toBe('hello A');

    // B listens to A, A pings.
    const target = boxB!.querySelector<HTMLInputElement>('.stub-target')!;
    target.value = a.id;
    [...boxB!.querySelectorAll('button')].find((x) => x.textContent === 'listen')!.click();
    [...boxA!.querySelectorAll('button')].find((x) => x.textContent === 'ping')!.click();

    expect(boxB!.querySelector('.stub-log')!.textContent).toContain('ping from');
    expect(k.instance(pinA.id)).toBeDefined();
    expect(k.instance(pinB.id)).toBeDefined();
  });
});

describe('v0 item 5: one Note, two pins, one body', () => {
  it('typing in one pin updates the other', () => {
    const { k, desk, root } = setup();
    const shared = k.createNote('before');
    k.pin(shared.id, desk.id, 'stub');
    k.pin(shared.id, desk.id, 'stub', { x: 300 });
    mountDesk(k, root, desk.id);

    const [boxA, boxB] = [...q(root, '.pin')];
    body(boxA!).value = 'after';
    body(boxA!).dispatchEvent(new Event('input', { bubbles: true }));

    expect(k.note(shared.id).body).toBe('after');
    expect(body(boxB!).value).toBe('after');
  });
});

describe('v0 item 6: no grant, no read', () => {
  it("Stub B's read button fails until it holds read:A", () => {
    const { k, desk, root } = setup();
    const a = k.createNote('secret A');
    const b = k.createNote('B');
    k.pin(a.id, desk.id, 'stub');
    const pinB = k.pin(b.id, desk.id, 'stub', { x: 300 });
    mountDesk(k, root, desk.id);

    const boxB = [...q(root, '.pin')][1]!;
    const target = boxB.querySelector<HTMLInputElement>('.stub-target')!;
    const read = [...boxB.querySelectorAll('button')].find((x) => x.textContent === 'read')!;
    const log = boxB.querySelector('.stub-log')!;

    target.value = a.id;
    read.click();
    expect(log.textContent).toContain(`denied: read:${a.id}`);

    k.grants.give(pinB.id, readGrant(a.id));
    read.click();
    expect(log.textContent).toContain('read: secret A');
  });
});

describe('rule 6: one pin means full screen', () => {
  it('switches between full screen and canvas as pins come and go', () => {
    const { k, desk, root } = setup();
    const solo = k.pin(k.createNote('only').id, desk.id, 'stub', { x: 10, y: 10 });
    mountDesk(k, root, desk.id);

    const viewport = root.querySelector<HTMLElement>('.desk-viewport')!;
    expect(viewport.classList.contains('solo')).toBe(true);
    expect(q(root, '.pin')[0]!.style.inset).toBe('0px');

    k.pin(k.createNote('second').id, desk.id, 'stub', { x: 300, y: 10 });
    expect(viewport.classList.contains('solo')).toBe(false);
    expect(q(root, '.pin')[0]!.style.left).toBe('10px');

    k.unpin(k.childPins(desk.id).filter((p) => p.id !== solo.id)[0]!.id);
    expect(viewport.classList.contains('solo')).toBe(true);
    expect(q(root, '.pin')).toHaveLength(1);
  });
});

describe('nesting: double-click enters a Note, Escape leaves', () => {
  it('drills in and back out', () => {
    const { k, desk, root } = setup();
    const inner = k.createNote('inner');
    k.pin(inner.id, desk.id, 'stub');
    k.pin(k.createNote('x').id, inner.id, 'stub');
    k.pin(k.createNote('y').id, inner.id, 'stub', { x: 300 });
    const { instance: view } = mountDesk(k, root, desk.id);

    expect(view.noteId).toBe(desk.id);
    q(root, '.pin')[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(view.noteId).toBe(inner.id);
    expect(q(root, '.pin')).toHaveLength(2);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.noteId).toBe(desk.id);
    expect(q(root, '.pin')).toHaveLength(1);
  });
});

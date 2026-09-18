// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { canvas, mountCanvas, text } from './help';

/** The paper of a canvas is an Excalidraw scene after the name line. */

function setup(body = 'desk') {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  k.types.define('canvas', canvas);
  k.types.define('text', text);
  const desk = k.createNote(body);
  mountCanvas(k, root, desk.id);
  const viewport = root.querySelector<HTMLElement>('.canvas-viewport')!;
  return { k, desk, root, viewport };
}

const scene = (body: string) => JSON.parse(body.slice(body.indexOf('\n\n') + 2));
const ev = (el: Element, type: string, o: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...o }));
const key = (k: string, o: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
const drag = (el: Element, from: [number, number], to: [number, number]) => {
  ev(el, 'pointerdown', { clientX: from[0], clientY: from[1] });
  ev(el, 'pointermove', { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  ev(el, 'pointermove', { clientX: to[0], clientY: to[1] });
  ev(el, 'pointerup', { clientX: to[0], clientY: to[1] });
};

beforeEach(() => {
  document.body.replaceChildren();
  key('v');
});

describe('drawing on the paper', () => {
  it('a drag with the rectangle tool adds one rectangle, in canvas coordinates', () => {
    const { k, desk, viewport } = setup();
    key('r');
    expect(document.body.dataset.tool).toBe('rectangle');
    drag(viewport, [100, 50], [220, 130]);
    const els = scene(k.body(desk.id)).elements;
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ type: 'rectangle', x: 100, y: 50, width: 120, height: 80, roughness: 0 });
    expect(k.body(desk.id).startsWith('desk\n\n{"type":"excalidraw","version":2')).toBe(true);
    expect(k.childPins(desk.id)).toHaveLength(0);
    expect(viewport.querySelector('.canvas-ink-scene rect')).not.toBeNull();
  });

  it('a body with an arrow renders a polyline with an arrowhead marker', () => {
    const body = `desk\n\n${JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'a1', type: 'arrow', x: 10, y: 20, width: 100, height: 0, points: [[0, 0], [100, 0]], strokeColor: '#000', strokeWidth: 2 }],
    })}`;
    const { root } = setup(body);
    const line = root.querySelector('.canvas-ink-scene polyline')!;
    expect(line.getAttribute('points')).toBe('10,20 110,20');
    expect(line.getAttribute('marker-end')).toBe('url(#canvas-arrowhead)');
    expect(root.querySelector('marker#canvas-arrowhead')).not.toBeNull();
  });

  it('typing on bare paper writes a text element, not a text pin', () => {
    const { k, desk, root } = setup();
    key('h');
    expect(k.childPins(desk.id)).toHaveLength(0);
    const area = root.querySelector<HTMLTextAreaElement>('.canvas-ink-edit')!;
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe('h');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const els = scene(k.body(desk.id)).elements;
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ type: 'text', text: 'h', fontFamily: 2 });
    expect(root.querySelector('.canvas-ink-edit')).toBeNull();
    expect(root.querySelector('.canvas-ink-scene text')!.textContent).toBe('h');
    expect(k.childPins(desk.id)).toHaveLength(0);
  });

  it('select + Backspace removes the element and leaves the pins alone', () => {
    const { k, desk, root, viewport } = setup();
    k.pin(k.createNote('box').id, desk.id, 'canvas', { x: 400, y: 400 });
    key('r');
    drag(viewport, [10, 10], [60, 60]);
    key('v');
    ev(root.querySelector('.canvas-ink-scene rect')!, 'pointerdown', { clientX: 10, clientY: 10 });
    ev(viewport, 'pointerup');
    expect(root.querySelector('.canvas-ink-sel')!.getAttribute('visibility')).toBe('visible');
    key('Backspace');
    expect(k.body(desk.id)).toBe('desk');
    expect(k.childPins(desk.id)).toHaveLength(1);
    expect(root.querySelectorAll('.pin')).toHaveLength(1);
  });

  it('Cmd+Z undoes a whole drag in one step', () => {
    const { k, desk, viewport } = setup();
    key('o');
    ev(viewport, 'pointerdown', { clientX: 0, clientY: 0 });
    for (const x of [10, 20, 30, 40, 50]) ev(viewport, 'pointermove', { clientX: x, clientY: x });
    ev(viewport, 'pointerup', { clientX: 50, clientY: 50 });
    expect(scene(k.body(desk.id)).elements[0]).toMatchObject({ type: 'ellipse', width: 50, height: 50 });
    key('z', { metaKey: true });
    expect(k.body(desk.id)).toBe('desk');
    key('z', { metaKey: true, shiftKey: true });
    expect(scene(k.body(desk.id)).elements).toHaveLength(1);
  });

  it('ink drawn while zoomed lands at canvas coordinates', () => {
    const { k, desk, root, viewport } = setup();
    viewport.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -Math.log(2) / 0.0015, clientX: 0, clientY: 0 }),
    );
    expect(root.querySelector<HTMLElement>('.canvas-layer')!.style.transform).toMatch(/scale\(2/);
    key('l');
    drag(viewport, [100, 100], [200, 100]);
    const [el] = scene(k.body(desk.id)).elements;
    expect(el.type).toBe('line');
    expect(el.x).toBeCloseTo(50, 5);
    expect(el.points[1][0]).toBeCloseTo(50, 5);
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { loadSource } from '../src/kernel/modules';
import type { TypeFactory } from '../src/kernel/type';
import sketchJs from '../seed/sketch.js?raw';
import { mountOne } from './help';

const sketch = (await loadSource(sketchJs))['default'] as TypeFactory;

function setup() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const k = new Kernel();
  const { pin } = mountOne(k, root, 'sketch', sketch, []);
  return { k, root, note: k.getPin(pin).note };
}

const scene = (body: string) => JSON.parse(body.slice(body.indexOf('\n\n') + 2));
const ev = (el: Element, type: string, x: number, y: number) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));

beforeEach(() => document.body.replaceChildren());

describe('sketch', () => {
  it('an empty body gets the Excalidraw skeleton', () => {
    const { k, note } = setup();
    expect(scene(k.body(note))).toEqual({ type: 'excalidraw', version: 2, elements: [] });
    expect(document.getElementById('type-sketch')).not.toBeNull();
  });

  it('a pen stroke becomes one freedraw element with its points, and does not reach the canvas', () => {
    const { k, root, note } = setup();
    const svg = root.querySelector('svg')!;
    let leaked = false;
    root.addEventListener('pointerdown', () => (leaked = true));
    ev(svg, 'pointerdown', 10, 10);
    ev(svg, 'pointermove', 15, 12);
    ev(svg, 'pointermove', 20, 20);
    ev(svg, 'pointerup', 20, 20);
    expect(leaked).toBe(false);
    const [el] = scene(k.body(note)).elements;
    expect(el.type).toBe('freedraw');
    expect([el.x, el.y]).toEqual([10, 10]);
    expect(el.points).toEqual([[0, 0], [5, 2], [10, 10]]);
    expect(root.querySelectorAll('path')).toHaveLength(1);
  });

  it('an existing element renders as a path; the eraser removes it', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const k = new Kernel();
    k.types.define('sketch', sketch);
    const body = `draw\n\n${JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'a', type: 'freedraw', x: 1, y: 2, strokeColor: '#000', strokeWidth: 3, points: [[0, 0], [4, 4]] }],
    })}`;
    const parent = k.createNote('parent');
    const pin = k.pin(k.createNote(body).id, parent.id, 'sketch');
    const instance = k.types.get('sketch')(k.host(pin.id));
    k.attach(pin.id, instance);
    instance.mount(root, k.note(pin.note));
    const path = root.querySelector('path')!;
    expect(path.getAttribute('d')).toBe('M1 2 L5 6');
    expect(path.getAttribute('stroke')).toBe('#000');

    [...root.querySelectorAll('button')].find((b) => b.textContent === 'erase')!.click();
    ev(path, 'pointerdown', 0, 0);
    expect(root.querySelectorAll('path')).toHaveLength(0);
    expect(scene(k.body(pin.note)).elements).toEqual([]);
    expect(k.body(pin.note).startsWith('draw\n\n')).toBe(true);
  });
});

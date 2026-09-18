// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { mountOne, text } from './help';

beforeEach(() => document.body.replaceChildren());

describe('tasks in text', () => {
  it('a `- [ ]` line gets a checkbox, and ticking it edits the text', () => {
    const k = new Kernel();
    const root = document.createElement('div');
    document.body.append(root);
    const { pin } = mountOne(k, root, 'text', text, []);
    const note = k.getPin(pin).note;
    k.patch(note, 'Groceries\n- [ ] milk\n- [x] eggs\nnot a task');

    const boxes = root.querySelectorAll<HTMLInputElement>('.text-task input');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.checked).toBe(false);
    expect(boxes[1]!.checked).toBe(true);

    boxes[0]!.checked = true;
    boxes[0]!.dispatchEvent(new Event('change'));
    expect(k.body(note)).toBe('Groceries\n- [x] milk\n- [x] eggs\nnot a task');
    // An agent ticking one by editing the text shows up too.
    k.patch(note, 'Groceries\n- [x] milk\n- [ ] eggs\nnot a task');
    expect(root.querySelectorAll<HTMLInputElement>('.text-task input')[1]!.checked).toBe(false);
  });
});

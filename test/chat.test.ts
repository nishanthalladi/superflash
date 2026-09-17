// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { chat, fakeFs, mountOne, until } from './help';

beforeEach(() => document.body.replaceChildren());

describe('chat: the door', () => {
  it('keeps the whole conversation, and its session, in the body', async () => {
    const k = new Kernel();
    const { fs, asked } = fakeFs();
    k.fs = fs;
    const root = document.createElement('div');
    document.body.append(root);
    const { pin, instance } = mountOne(k, root, 'chat', chat);
    const note = k.getPin(pin).note;
    k.patch(note, 'Claude');

    const input = root.querySelector<HTMLTextAreaElement>('.chat-input')!;
    input.value = 'hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => k.body(note).includes('echo: hello'));

    expect(k.body(note)).toBe('Claude\nsession: sess-1 $0.01\n\n> hello\n\necho: hello');
    expect(root.querySelector('.chat-log')!.textContent).toBe('> hello\n\necho: hello');

    input.value = 'again';
    await (instance as unknown as { send(): Promise<void> }).send();
    expect(asked.map((a) => a.session)).toEqual([undefined, 'sess-1']);
    expect(k.body(note).split('session:')).toHaveLength(2);
    expect(k.body(note).split('\n')[1]).toBe('session: sess-1 $0.02');
    expect(root.querySelector('.chat-status')!.textContent).toBe('$0.02');
  });
});

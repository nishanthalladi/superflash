export const type = { name: 'chat', title: 'Chat' };

/**
 * The door. A conversation with Claude Code, in this repo, as a note.
 *
 * The body is the whole thing, and it is plain text on purpose:
 *
 *   <name>
 *   session: <id> $<total>  ← how the next turn continues the last one, and what
 *                             the whole conversation has cost so far
 *
 *   > what you said
 *
 *   what it said
 *
 * So the conversation is a note like any other — pin it twice, undo it, read it
 * as text, hand it to another chat. Nothing is kept anywhere else.
 */

const SESSION = /^session: (\S+)(?: \$([\d.]+))?$/m;

export default function (host) {
  let log;
  let input;
  let status;
  let busy = false;

  const body = () => host.read(host.pin.note);
  const lines = () => body().split('\n');
  const transcript = () => lines().slice(1).join('\n').replace(SESSION, '').replace(/^\n+/, '');
  const total = () => Number(SESSION.exec(body())?.[2] || 0);

  function draw() {
    log.textContent = transcript();
    log.scrollTop = log.scrollHeight;
    if (!busy) status.textContent = total() ? `$${total().toFixed(2)}` : '';
  }

  function append(text) {
    host.write(`${body().replace(/\n+$/, '')}\n\n${text}`);
  }

  async function send() {
    const prompt = input.value.trim();
    if (!prompt || busy) return;
    busy = true;
    input.value = '';
    input.disabled = true;
    status.textContent = 'thinking…';
    // The reply is written into the body as it arrives, so it is never anywhere else.
    append(`> ${prompt}`);
    let reply = '';
    const base = body();
    try {
      const session = SESSION.exec(base)?.[1];
      const out = await host.fs().ask(prompt, session, (piece) => {
        reply += piece;
        host.write(`${base}\n\n${reply}`);
      });
      host.write(`${base}\n\n${reply.trim()}`);
      // The running total lives on the session line, so it survives a reload.
      const spent = (total() + out.cost).toFixed(2);
      const all = lines();
      if (session) all[1] = `session: ${out.session} $${spent}`;
      else all.splice(1, 0, `session: ${out.session} $${spent}`);
      host.write(all.join('\n'));
    } catch (err) {
      append(`! ${err && err.message ? err.message : String(err)}`);
      status.textContent = 'failed';
    } finally {
      busy = false;
      input.disabled = false;
      input.focus();
      draw();
    }
  }

  return {
    mount(box) {
      box.classList.add('chat');
      log = document.createElement('pre');
      log.className = 'chat-log';
      const foot = document.createElement('div');
      foot.className = 'chat-foot';
      input = document.createElement('textarea');
      input.className = 'chat-input';
      input.placeholder = 'ask, then Enter';
      input.rows = 1;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      });
      status = document.createElement('span');
      status.className = 'chat-status';
      foot.append(input, status);
      box.append(log, foot);
      draw();
    },
    focus() {
      input.focus();
    },
    onPatch: draw,
    send,
  };
}

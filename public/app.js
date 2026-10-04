// Chat UI: streaming answers, markdown, sources, search mode.
// Nothing is stored on the server: the current conversation lives only in this
// tab's memory (sent back as recent context), and is cleared by refresh / New Chat.
(() => {
  'use strict';
  const { api, el, wireChrome } = window.SecCommon;
  const md = window.SecMarkdown;

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const welcomeEl = $('welcome');
  const input = $('input');
  const sendBtn = $('send-btn');

  const state = {
    busy: false,
    mode: 'ask', // 'ask' | 'search'
    turns: [], // [{role:'user'|'assistant', content}] — in memory only
    maxTurns: 8,
    maxLen: parseInt(input.getAttribute('maxlength'), 10) || 12000,
  };

  // ---------- helpers ----------
  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  const scrollToBottom = (force = false) => { if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight; };

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
    const n = input.value.length;
    $('char-count').textContent = n > state.maxLen * 0.8 ? `${n.toLocaleString()} / ${state.maxLen.toLocaleString()}` : '';
  }

  function setBusy(b) {
    state.busy = b;
    sendBtn.disabled = b;
  }

  function hideWelcome() { welcomeEl.hidden = true; }

  function clearMessages() {
    for (const n of [...messagesEl.children]) if (n !== welcomeEl) n.remove();
  }

  // ---------- rendering ----------
  function userBubble(text) {
    const node = el('div', { class: 'msg user' }, el('div', { class: 'body', text }));
    messagesEl.append(node);
    return node;
  }

  function xagentLabel() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M16 2 4 7v8c0 7.2 5 13.4 12 15 7-1.6 12-7.8 12-15V7L16 2Z', 'm11 16 3.5 3.5L21.5 12']) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2.4');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    return el('div', { class: 'who' }, svg, el('span', { text: 'Xagent' }));
  }

  function assistantShell() {
    const content = el('div', { class: 'content' });
    const extras = el('div', { class: 'extras' });
    const body = el('div', { class: 'body' }, xagentLabel(), extras, content);
    const node = el('div', { class: 'msg assistant' }, body);
    messagesEl.append(node);
    return { node, content, extras, body };
  }

  function typingIndicator() {
    return el('div', { class: 'typing' }, el('span', { class: 'dots' }, el('i'), el('i'), el('i')), 'AI is typing…');
  }

  function renderSources(sources) {
    if (!sources || !sources.length) return null;
    const list = el('ol');
    for (const s of sources) {
      // Plain text only — which tab/section the answer came from, no links.
      const where = s.section ? s.section.split(' > ').join(' › ') : (s.document || 'Documentation');
      const meta = [];
      if (s.file) meta.push(`File: ${s.file}`);
      if (s.function) meta.push(`Function: ${s.function}`);
      if (s.version) meta.push(`Version: ${s.version}`);
      list.append(el('li', {},
        el('span', { class: 'cite', text: s.label }),
        el('div', {}, el('span', { class: 'src-where', text: where }),
          meta.length ? el('div', { class: 'src-meta', text: meta.join(' · ') }) : null)));
    }
    return el('div', { class: 'sources' }, el('h4', { text: 'Sources' }), list);
  }

  function newChat() {
    if (state.busy) return;
    state.turns = [];
    clearMessages();
    welcomeEl.hidden = false;
    input.focus();
  }

  function showError(message) {
    hideWelcome();
    const shell = assistantShell();
    shell.extras.append(el('div', { class: 'notice err', text: message }));
    scrollToBottom(true);
  }

  // ---------- SSE over fetch ----------
  async function* readSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { yield { event, data: JSON.parse(data) }; } catch { /* skip */ }
      }
    }
  }

  // ---------- ask ----------
  async function ask(question) {
    hideWelcome();
    userBubble(question);
    const shell = assistantShell();
    const typing = typingIndicator();
    shell.content.append(typing);
    scrollToBottom(true);

    let text = '';
    let pending = false;
    const paint = () => {
      pending = false;
      shell.content.innerHTML = md.render(text);
      scrollToBottom();
    };

    try {
      const res = await api('/api/chat', {
        method: 'POST', raw: true,
        body: { message: question, history: state.turns.slice(-state.maxTurns) },
      });
      const type = res.headers.get('Content-Type') || '';
      if (!res.ok || !type.includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      for await (const { event, data } of readSse(res)) {
        if (event === 'meta') {
          if (data.notice) shell.extras.append(el('div', { class: 'notice warn', text: data.notice }));
        } else if (event === 'delta') {
          text += data.t;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (event === 'done') {
          paint();
          // Remember this exchange (memory only) so follow-up questions have context.
          state.turns.push({ role: 'user', content: question }, { role: 'assistant', content: text });
          state.turns = state.turns.slice(-state.maxTurns);
          const src = renderSources(data.sources);
          if (src) shell.body.append(src);
        } else if (event === 'error') {
          if (!text) typing.remove();
          shell.extras.append(el('div', { class: 'notice err', text: data.message || 'AI service temporarily unavailable.' }));
        }
      }
      if (!text) typing.remove();
    } catch (e) {
      typing.remove();
      shell.extras.append(el('div', { class: 'notice err', text: e.message || 'AI service temporarily unavailable.' }));
    } finally {
      scrollToBottom();
    }
  }

  // ---------- search docs ----------
  async function search(query) {
    hideWelcome();
    userBubble(`🔎 ${query}`);
    const shell = assistantShell();
    shell.content.append(el('div', { class: 'typing', text: 'Searching documentation…' }));
    scrollToBottom(true);
    try {
      const { results, notice } = await api('/api/search', { method: 'POST', body: { query } });
      shell.content.replaceChildren();
      if (notice || !results.length) {
        shell.extras.append(el('div', { class: 'notice warn', text: notice || 'No sufficiently relevant documentation found.' }));
        return;
      }
      for (const r of results) {
        const title = el('strong', { text: r.section ? r.section.split(' > ').join(' › ') : (r.document || 'Documentation') });
        const meta = [r.file && `File: ${r.file}`, r.function && `Function: ${r.function}`, r.version && `v${r.version}`]
          .filter(Boolean).join(' · ');
        const snippet = el('div', { class: 'content' });
        snippet.innerHTML = md.render(r.snippet);
        shell.content.append(el('div', { class: 'search-result' },
          el('div', { class: 'sr-head' },
            el('div', {}, el('span', { class: 'cite', text: r.label }), ' ', title,
              meta ? el('div', { class: 'src-meta muted small', text: meta }) : null),
            el('span', { class: 'score', text: `relevance ${r.score}` })),
          snippet));
      }
    } catch (e) {
      shell.content.replaceChildren();
      shell.extras.append(el('div', { class: 'notice err', text: e.message }));
    } finally {
      scrollToBottom();
    }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || state.busy) return;
    if (text.length > state.maxLen) return showError(`Message is too long (max ${state.maxLen} characters).`);
    input.value = '';
    autosize();
    setBusy(true);
    try {
      if (state.mode === 'search') await search(text);
      else await ask(text);
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function setMode(mode) {
    state.mode = mode;
    for (const [id, m] of [['mode-ask', 'ask'], ['mode-search', 'search']]) {
      const b = $(id);
      b.classList.toggle('active', m === mode);
      b.setAttribute('aria-selected', String(m === mode));
    }
    const narrow = window.matchMedia('(max-width: 520px)').matches;
    input.placeholder = mode === 'search'
      ? (narrow ? 'Search documentation…' : 'Search the documentation (no AI generation)…')
      : (narrow ? 'Ask xagent…' : 'Ask xagent anything… (paste logs, config or code too)');
    $('mode-hint').textContent = mode === 'search'
      ? 'Search mode returns matching documentation sections only'
      : 'Enter to send · Shift+Enter for a new line';
    input.focus();
  }

  // ---------- wiring ----------
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', autosize);
  $('new-chat').addEventListener('click', newChat);
  $('mode-ask').addEventListener('click', () => setMode('ask'));
  $('mode-search').addEventListener('click', () => setMode('search'));

  if (window.matchMedia('(max-width: 520px)').matches) input.placeholder = 'Ask xagent…';

  (async () => {
    try {
      const { user, app } = await api('/api/me');
      wireChrome(user);
      if (app) document.title = app;
      if (user.role === 'admin') $('admin-link').hidden = false;
    } catch { return; }
    input.focus();
  })();
})();

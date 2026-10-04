// Shared helpers for authenticated pages.
(function (global) {
  'use strict';

  const THEME_KEY = 'xagent-theme';
  function applyTheme(t) { document.documentElement.dataset.theme = t; }
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') applyTheme(t);
  } catch { /* storage unavailable */ }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  }

  // fetch wrapper: same-origin cookie, CSRF header, JSON, 401 -> login.
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'X-Requested-With': 'xagent' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      window.location.replace('/login');
      throw new Error('Session expired. Please sign in again.');
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    window.location.replace('/login');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function wireChrome(user) {
    const name = document.getElementById('user-name');
    if (name) {
      name.textContent = user.username;
      if (user.role === 'admin') name.append(el('span', { class: 'role', text: 'Admin' }));
    }
    document.getElementById('logout-btn')?.addEventListener('click', logout);
    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
  }

  global.SecCommon = { api, logout, fmtDate, el, wireChrome, toggleTheme };
})(window);

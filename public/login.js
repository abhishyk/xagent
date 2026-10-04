(() => {
  'use strict';
  try {
    const t = localStorage.getItem('xagent-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* storage unavailable */ }

  const form = document.getElementById('login-form');
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');

  function showError(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) return showError('Enter your username and password.');

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'xagent' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || 'Sign-in failed.');
        form.password.value = '';
        form.password.focus();
        return;
      }
      window.location.replace('/');
    } catch {
      showError('Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  });
})();

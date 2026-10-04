// Admin panel: sync dashboard, knowledge base view, user management.
(() => {
  'use strict';
  const { api, el, fmtDate, wireChrome } = window.SecCommon;
  const $ = (id) => document.getElementById(id);

  let syncing = false;

  function badge(status) {
    const cls = { synced: 'ok', success: 'ok', active: 'ok', failed: 'bad', disabled: 'bad', partial: 'mid', syncing: 'mid', running: 'mid', pending: 'mid' }[status] || '';
    return el('span', { class: `badge ${cls}`, text: status || '—' });
  }

  function stat(k, v, small = false) {
    return el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: `v${small ? ' small-v' : ''}`, text: v }));
  }

  async function loadStatus() {
    const s = await api('/api/admin/sync-status');
    const last = s.last_sync;
    $('stats').replaceChildren(
      stat('Last Sync', last ? fmtDate(last.completed_at || last.started_at) : 'Never', true),
      stat('Last Status', last ? last.status : '—', true),
      stat('Documents', `${s.knowledge.documents} / ${s.config.configured_documents}`),
      stat('Chunks', s.knowledge.chunks.toLocaleString()),
      stat('Successful', String(s.knowledge.synced)),
      stat('Failed', String(s.knowledge.failed)),
      stat('AI calls today', `${s.usage.ai_today} / ${s.usage.daily_ai_limit || '∞'}`),
      stat('Users', String(s.usage.users)),
    );

    const warn = [];
    if (!s.config.google_credentials) warn.push('Google credentials are not set. Add GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY as Worker secrets.');
    if (s.config.config_error) warn.push(`GOOGLE_DOCUMENT_IDS: ${s.config.config_error}`);
    else if (!s.config.configured_documents) warn.push('No documents configured. Set GOOGLE_DOCUMENT_IDS.');
    if (s.config.bootstrap_secrets_present) warn.push('ADMIN_INITIAL_USERNAME / ADMIN_INITIAL_PASSWORD are still set. Delete them: wrangler secret delete ADMIN_INITIAL_PASSWORD');
    $('warnings').replaceChildren(...warn.map((w) => el('div', { class: 'notice warn', text: w })));

    $('config-info').textContent = `Model ${s.config.ai_model} · Embeddings ${s.config.embedding_model} · top_k ${s.config.top_k} · min similarity ${s.config.min_similarity}` +
      (s.config.service_account_email ? ` · Share docs with ${s.config.service_account_email}` : '');

    $('docs-body').replaceChildren(...(s.documents.length ? s.documents.map((d) => el('tr', {},
      el('td', {}, d.url ? el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', text: d.name || d.id }) : (d.name || d.id),
        d.last_error ? el('div', { class: 'small', text: d.last_error }) : null),
      el('td', { text: d.document_type }),
      el('td', { text: d.version || '—' }),
      el('td', { text: String(d.chunk_count) }),
      el('td', { class: 'mono', text: d.content_hash || '—' }),
      el('td', {}, badge(d.status)),
      el('td', { text: fmtDate(d.last_synced_at) }),
    )) : [el('tr', {}, el('td', { colspan: '7', class: 'muted', text: 'Nothing indexed yet. Click “Sync Now”.' }))]));

    $('runs-body').replaceChildren(...(s.runs.length ? s.runs.map((r) => el('tr', {},
      el('td', { text: String(r.id) }),
      el('td', { text: r.trigger_type }),
      el('td', { text: fmtDate(r.started_at) }),
      el('td', {}, badge(r.status)),
      el('td', { text: String(r.documents_processed) }),
      el('td', { text: String(r.documents_failed) }),
      el('td', { text: String(r.chunks_processed) }),
      el('td', { text: String(r.chunks_deleted) }),
      el('td', { class: 'err-cell', text: r.error_message || '' }),
    )) : [el('tr', {}, el('td', { colspan: '9', class: 'muted', text: 'No sync runs yet.' }))]));
  }

  function log(line) {
    const pre = $('sync-log');
    pre.textContent += `${line}\n`;
    pre.scrollTop = pre.scrollHeight;
  }

  async function syncNow() {
    if (syncing) return;
    syncing = true;
    const btn = $('sync-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    $('sync-progress').hidden = false;
    $('sync-log').textContent = '';
    $('progress-bar').style.width = '0%';
    const force = $('force').checked;
    try {
      const { run_id: runId, documents } = await api('/api/admin/sync', { method: 'POST', body: { action: 'start' } });
      log(`Sync run #${runId} started — ${documents.length} document(s)${force ? ' (force re-index)' : ''}`);
      let done = 0;
      for (const docId of documents) {
        let steps = 0;
        let res;
        do {
          res = await api('/api/admin/sync', { method: 'POST', body: { action: 'step', run_id: runId, document_id: docId, force: force && steps === 0 } });
          steps++;
          if (res.status === 'in_progress') log(`  ${docId.slice(0, 12)}…: +${res.added} chunks, ${res.remaining} remaining`);
        } while (res.status === 'in_progress' && steps < 500);
        done++;
        $('progress-bar').style.width = `${Math.round((done / documents.length) * 100)}%`;
        const label = docId.slice(0, 12);
        if (res.status === 'failed') log(`✗ ${label}…: ${res.error}`);
        else if (res.status === 'unchanged') log(`= ${label}…: unchanged (${res.chunks} chunks)`);
        else log(`✓ ${label}…: ${res.chunks} chunks (${res.added} new, ${res.deleted} removed)`);
      }
      const { run } = await api('/api/admin/sync', { method: 'POST', body: { action: 'finish', run_id: runId } });
      log(`Finished: ${run.status}. New chunks ${run.chunks_processed}, removed ${run.chunks_deleted}.`);
      log('Note: Vectorize can take a few seconds to make new vectors searchable.');
    } catch (e) {
      log(`Sync error: ${e.message}`);
    } finally {
      syncing = false;
      btn.disabled = false;
      btn.textContent = 'Sync Now';
      $('force').checked = false;
      loadStatus().catch(() => {});
    }
  }

  // ---------- users ----------
  async function loadUsers(me) {
    const { users } = await api('/api/admin/users');
    $('users-body').replaceChildren(...users.map((u) => {
      const isMe = u.username.toLowerCase() === me.username.toLowerCase();
      return el('tr', {},
        el('td', { text: u.username + (isMe ? ' (you)' : '') }),
        el('td', { text: u.role }),
        el('td', {}, badge(u.status)),
        el('td', { text: fmtDate(u.last_login_at) }),
        el('td', {},
          isMe ? null : el('button', {
            class: `btn btn-sm ${u.status === 'active' ? 'btn-danger' : ''}`, type: 'button',
            text: u.status === 'active' ? 'Disable' : 'Enable',
            onclick: () => toggleUser(u, me),
          }),
          ' ',
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Reset password', onclick: () => resetPassword(u, me) })));
    }));
  }

  function userMsg(text, ok) {
    const p = $('user-msg');
    p.hidden = false;
    p.textContent = text;
    p.style.color = ok ? 'var(--success)' : 'var(--danger)';
  }

  async function toggleUser(u, me) {
    try {
      await api('/api/admin/users/toggle', { method: 'POST', body: { user_id: u.id } });
      await loadUsers(me);
    } catch (e) { userMsg(e.message, false); }
  }

  async function resetPassword(u, me) {
    const pw = window.prompt(`New password for ${u.username} (min 10 characters). Their sessions will be signed out.`);
    if (!pw) return;
    try {
      await api('/api/admin/users/reset-password', { method: 'POST', body: { user_id: u.id, password: pw } });
      userMsg(`Password reset for ${u.username}.`, true);
      await loadUsers(me);
    } catch (e) { userMsg(e.message, false); }
  }

  (async () => {
    let me;
    try {
      ({ user: me } = await api('/api/me'));
    } catch { return; }
    wireChrome(me);
    $('sync-btn').addEventListener('click', syncNow);
    $('user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/admin/users', { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value, role: f.role.value } });
        userMsg(`User ${f.username.value.trim()} created.`, true);
        f.reset();
        await loadUsers(me);
      } catch (err) { userMsg(err.message, false); }
    });
    await Promise.all([loadStatus().catch((e) => $('warnings').replaceChildren(el('div', { class: 'notice err', text: e.message }))), loadUsers(me)]);
  })();
})();

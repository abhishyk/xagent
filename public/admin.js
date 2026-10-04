<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Admin · xagent</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
</head>
<body class="admin-page">
  <header class="topbar admin-topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 4 7v8c0 7.2 5 13.4 12 15 7-1.6 12-7.8 12-15V7L16 2Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="m11 16 3.5 3.5L21.5 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>xagent · Admin</span>
    </div>
    <div class="user-menu">
      <button id="theme-btn" class="icon-btn" type="button" aria-label="Toggle light/dark theme" title="Toggle theme">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      </button>
      <a class="btn btn-ghost btn-sm" href="/">← Assistant</a>
      <span id="user-name" class="user-chip"></span>
      <button id="logout-btn" class="btn btn-ghost btn-sm" type="button">Logout</button>
    </div>
  </header>

  <main class="admin-main">
    <div id="warnings"></div>

    <section class="card">
      <div class="card-head">
        <h2>Documentation Sync</h2>
        <div class="card-actions">
          <label class="check small"><input id="force" type="checkbox"> Force full re-index</label>
          <button id="sync-btn" class="btn btn-primary" type="button">Sync Now</button>
        </div>
      </div>
      <div id="stats" class="stats"></div>
      <div id="sync-progress" class="sync-progress" hidden>
        <div class="progress"><div id="progress-bar" class="progress-bar"></div></div>
        <pre id="sync-log" class="sync-log"></pre>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Free Usage Today</h2><span class="muted small">Resets daily at 5:30 AM IST (00:00 UTC)</span></div>
      <div id="usage" class="usage-grid"></div>
      <div id="usage-tips" class="usage-tips"></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Knowledge Base</h2><span id="config-info" class="muted small"></span></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Document</th><th>Type</th><th>Version</th><th>Chunks</th><th>Hash</th><th>Status</th><th>Last sync</th></tr></thead>
          <tbody id="docs-body"></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Recent Sync Runs</h2></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>#</th><th>Trigger</th><th>Started</th><th>Status</th><th>Docs OK</th><th>Docs failed</th><th>New chunks</th><th>Removed</th><th>Error</th></tr></thead>
          <tbody id="runs-body"></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Users</h2></div>
      <form id="user-form" class="inline-form" autocomplete="off">
        <input name="username" placeholder="Username" required maxlength="32" autocomplete="off">
        <input name="password" type="password" placeholder="Password (min 10 chars)" required minlength="10" maxlength="256" autocomplete="new-password">
        <select name="role" aria-label="Role"><option value="user">user</option><option value="admin">admin</option></select>
        <button class="btn btn-primary" type="submit">Create user</button>
      </form>
      <p id="user-msg" class="small" hidden></p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Action</th></tr></thead>
          <tbody id="users-body"></tbody>
        </table>
      </div>
    </section>
  </main>

  <script src="/common.js"></script>
  <script src="/admin.js"></script>
</body>
</html>

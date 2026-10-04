// User queries. password_hash is only ever read for verification and is never
// returned by listUsers / API responses.

export async function findUserByUsername(db, username) {
  return db.prepare('SELECT id, username, password_hash, role, status FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username).first();
}

export async function findUserById(db, id) {
  return db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').bind(id).first();
}

export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row ? row.n : 0;
}

export async function countActiveAdmins(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").first();
  return row ? row.n : 0;
}

export async function createUser(db, { username, passwordHash, role }) {
  const res = await db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id')
    .bind(username, passwordHash, role).first();
  return res.id;
}

export async function listUsers(db) {
  const { results } = await db.prepare(
    'SELECT id, username, role, status, created_at, last_login_at FROM users ORDER BY username COLLATE NOCASE'
  ).all();
  return results;
}

export async function setUserStatus(db, id, status) {
  await db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(status, new Date().toISOString(), id).run();
}

export async function setUserPassword(db, id, passwordHash) {
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(passwordHash, new Date().toISOString(), id).run();
}

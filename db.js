const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, 'messages.db'));

// Create tables if they don't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS tradies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    business TEXT,
    email TEXT,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    incoming TEXT,
    outgoing TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

function logMessage(phone, incoming, outgoing) {
  const stmt = db.prepare(`INSERT INTO messages (phone, incoming, outgoing) VALUES (?, ?, ?)`);
  const info = stmt.run(phone, incoming, outgoing);
  return info.lastInsertRowid;
}

function registerTradie(name, business, email, phone) {
  const stmt = db.prepare(`INSERT INTO tradies (name, business, email, phone) VALUES (?, ?, ?, ?)`);
  const info = stmt.run(name, business, email, phone);
  return info.lastInsertRowid;
}

function getMessagesForPhone(phone) {
  const stmt = db.prepare(`SELECT * FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 50`);
  return stmt.all(phone);
}

module.exports = {
  logMessage,
  registerTradie,
  getMessagesForPhone,
};


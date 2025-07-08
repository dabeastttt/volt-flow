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
    phone TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    name TEXT,
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

// Log incoming and outgoing messages
function logMessage(phone, incoming, outgoing) {
  const stmt = db.prepare(`INSERT INTO messages (phone, incoming, outgoing) VALUES (?, ?, ?)`);
  const info = stmt.run(phone, incoming, outgoing);
  return info.lastInsertRowid;
}

// Register tradie
function registerTradie(name, business, email, phone) {
  const stmt = db.prepare(`INSERT INTO tradies (name, business, email, phone) VALUES (?, ?, ?, ?)`);
  const info = stmt.run(name, business, email, phone);
  return info.lastInsertRowid;
}

// Get messages by phone number (most recent first)
function getMessagesForPhone(phone, options = {}) {
  const limit = options.limit || 50;
  const stmt = db.prepare(`SELECT * FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT ?`);
  return stmt.all(phone, limit);
}

// Get customer by phone
function getCustomerByPhone(phone) {
  const stmt = db.prepare(`SELECT * FROM customers WHERE phone = ?`);
  return stmt.get(phone) || null;
}

// Save or update customer name by phone
function saveCustomer({ phone, name }) {
  // Try update first
  const update = db.prepare(`UPDATE customers SET name = ? WHERE phone = ?`);
  const info = update.run(name, phone);

  if (info.changes === 0) {
    // If no row updated, insert new
    const insert = db.prepare(`INSERT INTO customers (phone, name) VALUES (?, ?)`);
    return insert.run(phone, name);
  }
  return info;
}

//summary
function getTodaysBookingsSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const startISO = startOfDay.toISOString();
  const endISO = endOfDay.toISOString();

  // Use parentheses to group OR conditions correctly,
  // and use LOWER() for case-insensitive search.
  const stmt = db.prepare(`
    SELECT phone, incoming, created_at FROM messages
    WHERE created_at BETWEEN ? AND ?
      AND (
        LOWER(incoming) LIKE '%book%'
        OR LOWER(incoming) LIKE '%booking%'
        OR LOWER(incoming) LIKE '%schedule%'
        OR LOWER(incoming) LIKE '%call%'
        OR LOWER(incoming) LIKE '%quote%'
        OR LOWER(incoming) LIKE '%job%'
        OR LOWER(incoming) LIKE '%call back%'
        OR LOWER(incoming) LIKE '%quoting%'
        OR LOWER(incoming) LIKE '%ring%'
      )
    ORDER BY created_at ASC
  `);

  const rows = stmt.all(startISO, endISO);

  if (!rows.length) return '';

  const customerNameStmt = db.prepare(`SELECT name FROM customers WHERE phone = ?`);

  let summaryLines = [];
  rows.forEach(row => {
    const customer = customerNameStmt.get(row.phone);
    const name = customer?.name || 'Unknown';

    summaryLines.push(`- ${name} (${row.phone}): "${row.incoming.trim()}" at ${new Date(row.created_at).toLocaleTimeString()}`);
  });

  return summaryLines.join('\n');
}


  const rows = stmt.all(startISO, endISO);

  if (!rows.length) return '';

  // Get customer names for phones
  const customerNameStmt = db.prepare(`SELECT name FROM customers WHERE phone = ?`);

  let summaryLines = [];
  rows.forEach(row => {
    const customer = customerNameStmt.get(row.phone);
    const name = customer?.name || 'Unknown';

    summaryLines.push(`- ${name} (${row.phone}): "${row.incoming.trim()}" at ${new Date(row.created_at).toLocaleTimeString()}`);
  });

  return summaryLines.join('\n');
}

module.exports = {
  logMessage,
  registerTradie,
  getMessagesForPhone,
  getCustomerByPhone,
  saveCustomer,
  getTodaysBookingsSummary,
};

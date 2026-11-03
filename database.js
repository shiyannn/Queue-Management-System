const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'cho_queue.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initializeDatabase() {
  // Stations / Rooms (4 Doctors + 1 Dental + Pharmacy)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      counter_number INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'medical', -- 'medical', 'dental'
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE,
      department TEXT NOT NULL DEFAULT 'medical', -- 'medical', 'dental'
      priority_rank INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'medical', -- 'medical', 'dental', 'pharmacy'
      is_priority INTEGER NOT NULL DEFAULT 0, -- 1 = Senior / PWD / Pregnant, 0 = Regular
      category_id INTEGER,
      current_station_id INTEGER,
      patient_name TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'CALLED', -- 'CALLED', 'SERVING', 'HOLD', 'SKIPPED', 'COMPLETED'
      queue_date TEXT NOT NULL, -- YYYY-MM-DD
      sequence_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      called_at TEXT,
      served_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (category_id) REFERENCES categories (id),
      FOREIGN KEY (current_station_id) REFERENCES stations (id)
    );

    CREATE TABLE IF NOT EXISTS ticket_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      station_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
      FOREIGN KEY (station_id) REFERENCES stations (id)
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_queue_date ON tickets(queue_date);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_current_station ON tickets(current_station_id);
  `);

  // Ensure department and is_priority columns exist in tickets
  try {
    db.exec(`ALTER TABLE tickets ADD COLUMN department TEXT NOT NULL DEFAULT 'medical';`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tickets ADD COLUMN is_priority INTEGER NOT NULL DEFAULT 0;`);
  } catch (e) {}

  // Ensure default categories & stations are seeded
  syncDefaultCategories();
  syncDefaultStations();
}

function syncDefaultCategories() {
  const desiredCategories = [
    { id: 1, name: 'Medical Consultation (Regular)', prefix: 'R', department: 'medical', priority_rank: 2, description: 'General walk-in consultation' },
    { id: 2, name: 'Priority Medical (Senior / PWD / Pregnant)', prefix: 'P', department: 'medical', priority_rank: 1, description: 'Senior Citizens, PWDs, Pregnant Women' },
    { id: 3, name: 'Dental Clinic (Regular)', prefix: 'D', department: 'dental', priority_rank: 2, description: 'Dental examination and oral care' },
    { id: 4, name: 'Pharmacy / Dispensing', prefix: 'Rx', department: 'pharmacy', priority_rank: 2, description: 'Prescription dispensing' },
    { id: 5, name: 'Emergency / Urgent Care', prefix: 'E', department: 'medical', priority_rank: 0, description: 'Immediate medical triage' },
  ];

  const count = db.prepare('SELECT COUNT(*) as count FROM categories').get().count;
  if (count < 5) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO categories (id, name, prefix, department, priority_rank, description, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    desiredCategories.forEach(c => insert.run(c.id, c.name, c.prefix, c.department, c.priority_rank, c.description));
  }
}

function syncDefaultStations() {
  const desiredStations = [
    { id: 1, name: 'Dra. Mennie', code: 'DOC-1', counter: 1, type: 'medical' },
    { id: 2, name: 'Dr. Perry', code: 'DOC-2', counter: 2, type: 'medical' },
    { id: 3, name: 'Dr. Dhiet', code: 'DOC-3', counter: 3, type: 'medical' },
    { id: 6, name: 'Dr. Cabral', code: 'DOC-4', counter: 4, type: 'medical' },
    { id: 4, name: 'Dra. Yvonne', code: 'DENT-1', counter: 5, type: 'dental' },
    { id: 5, name: 'Pharmacy / Dispensing', code: 'PHARM-1', counter: 6, type: 'pharmacy' },
  ];

  // Always upsert station names so renames take effect without clearing data
  const upsert = db.prepare(`
    INSERT INTO stations (id, name, code, counter_number, type, active)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      code = excluded.code,
      counter_number = excluded.counter_number,
      type = excluded.type,
      active = 1
  `);
  const count = db.prepare('SELECT COUNT(*) as count FROM stations').get().count;
  if (count === 0) {
    // Fresh DB — clear any stale data and insert cleanly
    db.transaction(() => {
      db.exec(`DELETE FROM ticket_logs; DELETE FROM tickets; DELETE FROM stations;`);
      desiredStations.forEach(s => upsert.run(s.id, s.name, s.code, s.counter, s.type));
    })();
  } else {
    // Existing DB — just update names/codes/counters in-place, preserve queue data
    desiredStations.forEach(s => upsert.run(s.id, s.name, s.code, s.counter, s.type));
  }
}

initializeDatabase();

module.exports = db;

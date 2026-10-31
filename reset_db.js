const db = require('./database');

console.log('🧹 Resetting tickets and logs...');
db.exec(`
  DELETE FROM ticket_logs;
  DELETE FROM tickets;
  DELETE FROM sqlite_sequence WHERE name IN ('tickets', 'ticket_logs');
`);
console.log('✅ Clinic queue database has been reset to a clean state!');


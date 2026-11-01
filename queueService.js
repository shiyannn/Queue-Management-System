const db = require('./database');

function getTodayString() {
  // Use Asia/Manila (UTC+8) so clinic queue dates stay consistent regardless of server host location
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

const queueService = {
  getTodayString,

  // Get active stations (Doctor 1, Doctor 2, Doctor 3, Dental Clinic)
  getStations() {
    return db.prepare('SELECT * FROM stations WHERE active = 1 ORDER BY counter_number ASC').all();
  },

  // Get single ticket details
  getTicketById(ticketId) {
    return db.prepare(`
      SELECT 
        t.*,
        s.name as station_name,
        s.counter_number,
        s.code as station_code,
        s.type as station_type
      FROM tickets t
      LEFT JOIN stations s ON t.current_station_id = s.id
      WHERE t.id = ?
    `).get(ticketId);
  },

  // Get active ticket at a station
  getCurrentTicketForStation(stationId) {
    const today = getTodayString();
    return db.prepare(`
      SELECT 
        t.*,
        s.name as station_name,
        s.counter_number,
        s.code as station_code,
        s.type as station_type
      FROM tickets t
      JOIN stations s ON t.current_station_id = s.id
      WHERE t.current_station_id = ? 
        AND t.status IN ('CALLED', 'SERVING') 
        AND t.queue_date = ?
      ORDER BY t.called_at DESC
      LIMIT 1
    `).get(stationId, today);
  },

  // Call the next sequential pre-printed token in FIFO order
  callNextToken(stationId) {
    const today = getTodayString();
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error(`Station ${stationId} not found`);

    const runTx = db.transaction(() => {
      const nowIso = new Date().toISOString();

      // 1. Auto-complete currently active ticket at this station if any
      const current = this.getCurrentTicketForStation(stationId);
      if (current) {
        db.prepare(`UPDATE tickets SET status = 'COMPLETED', completed_at = ? WHERE id = ?`).run(nowIso, current.id);
        db.prepare(`INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp) VALUES (?, ?, 'COMPLETED', 'Completed on call next', ?)`).run(current.id, stationId, nowIso);
      }

      // 2. First check if any transferred ticket is specifically waiting for this station
      const transferredTicket = db.prepare(`
        SELECT id FROM tickets 
        WHERE current_station_id = ? AND status = 'WAITING' AND queue_date = ?
        ORDER BY created_at ASC LIMIT 1
      `).get(stationId, today);

      if (transferredTicket) {
        db.prepare(`UPDATE tickets SET status = 'CALLED', called_at = ? WHERE id = ?`).run(nowIso, transferredTicket.id);
        db.prepare(`INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp) VALUES (?, ?, 'CALLED', 'Called transferred patient', ?)`).run(transferredTicket.id, stationId, nowIso);
        return this.getTicketById(transferredTicket.id);
      }

      // 3. Auto-advance the physical pre-printed token sequence
      const isDental = station.type === 'dental';
      const isPharmacy = station.type === 'pharmacy';
      const dept = isDental ? 'dental' : (isPharmacy ? 'pharmacy' : 'medical');

      const lastSeqRow = db.prepare(`
        SELECT MAX(sequence_number) as max_seq 
        FROM tickets 
        WHERE department = ? AND queue_date = ?
      `).get(dept, today);

      const nextSeq = (lastSeqRow && lastSeqRow.max_seq ? lastSeqRow.max_seq : 0) + 1;
      const ticketNumber = isDental ? `D-${nextSeq}` : (isPharmacy ? `Rx-${nextSeq}` : `${nextSeq}`);

      const defaultCatId = isDental ? 3 : (isPharmacy ? 4 : 1);
      const insert = db.prepare(`
        INSERT INTO tickets (
          ticket_number, department, category_id, current_station_id, status,
          queue_date, sequence_number, created_at, called_at
        ) VALUES (?, ?, ?, ?, 'CALLED', ?, ?, ?, ?)
      `);

      const result = insert.run(ticketNumber, dept, defaultCatId, stationId, today, nextSeq, nowIso, nowIso);
      const ticketId = result.lastInsertRowid;

      db.prepare(`
        INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
        VALUES (?, ?, 'CALLED', ?, ?)
      `).run(ticketId, stationId, `Called token ${ticketNumber} at ${station.name}`, nowIso);

      return this.getTicketById(ticketId);
    });

    return runTx();
  },

  // Call a specific token number (e.g. if patient returned or manual call)
  callSpecificNumber(stationId, inputNumber) {
    if (!inputNumber || !inputNumber.trim()) throw new Error('Ticket number is required');
    const cleanNumber = inputNumber.trim().toUpperCase();
    const today = getTodayString();
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) throw new Error(`Station ${stationId} not found`);

    const runTx = db.transaction(() => {
      const nowIso = new Date().toISOString();

      // Complete currently serving ticket at this station
      const current = this.getCurrentTicketForStation(stationId);
      if (current) {
        db.prepare(`UPDATE tickets SET status = 'COMPLETED', completed_at = ? WHERE id = ?`).run(nowIso, current.id);
        db.prepare(`INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp) VALUES (?, ?, 'COMPLETED', 'Completed on specific call', ?)`).run(current.id, stationId, nowIso);
      }

      // Check if ticket already exists today (e.g. was SKIPPED or HOLD)
      const existing = db.prepare(`
        SELECT id FROM tickets WHERE ticket_number = ? AND queue_date = ? LIMIT 1
      `).get(cleanNumber, today);

      if (existing) {
        db.prepare(`
          UPDATE tickets SET status = 'CALLED', called_at = ?, current_station_id = ? WHERE id = ?
        `).run(nowIso, stationId, existing.id);
        db.prepare(`
          INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
          VALUES (?, ?, 'RECALLED', 'Specific recall of existing token', ?)
        `).run(existing.id, stationId, nowIso);
        return this.getTicketById(existing.id);
      }

      // If new, insert directly
      const isDental = station.type === 'dental';
      const isPharmacy = station.type === 'pharmacy';
      const dept = isDental ? 'dental' : (isPharmacy ? 'pharmacy' : 'medical');
      const defaultCatId = isDental ? 3 : (isPharmacy ? 4 : 1);
      const seqMatch = cleanNumber.match(/\d+/);
      const seqNum = seqMatch ? parseInt(seqMatch[0], 10) : 1;

      const insert = db.prepare(`
        INSERT INTO tickets (
          ticket_number, department, category_id, current_station_id, status,
          queue_date, sequence_number, created_at, called_at
        ) VALUES (?, ?, ?, ?, 'CALLED', ?, ?, ?, ?)
      `);

      const result = insert.run(cleanNumber, dept, defaultCatId, stationId, today, seqNum, nowIso, nowIso);
      const ticketId = result.lastInsertRowid;

      db.prepare(`
        INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
        VALUES (?, ?, 'CALLED', ?, ?)
      `).run(ticketId, stationId, `Called specific token ${cleanNumber}`, nowIso);

      return this.getTicketById(ticketId);
    });

    return runTx();
  },

  // Recall current ticket
  recallTicket(ticketId) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) throw new Error('Ticket not found');
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
      VALUES (?, ?, 'RECALLED', 'Patient recalled to station', ?)
    `).run(ticket.id, ticket.current_station_id, nowIso);
    return ticket;
  },

  // Skip ticket (Patient didn't show up)
  skipTicket(ticketId, reason = 'No-show') {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) throw new Error('Ticket not found');
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE tickets SET status = 'SKIPPED' WHERE id = ?`).run(ticketId);
    db.prepare(`
      INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
      VALUES (?, ?, 'SKIPPED', ?, ?)
    `).run(ticketId, ticket.current_station_id, reason, nowIso);
    return this.getTicketById(ticketId);
  },

  // Complete consultation
  completeTicket(ticketId) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) throw new Error('Ticket not found');
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE tickets SET status = 'COMPLETED', completed_at = ? WHERE id = ?`).run(nowIso, ticketId);
    db.prepare(`
      INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
      VALUES (?, ?, 'COMPLETED', 'Consultation finished', ?)
    `).run(ticketId, ticket.current_station_id, nowIso);
    return this.getTicketById(ticketId);
  },

  // Transfer patient to another counter
  transferTicket(ticketId, targetStationId, notes = '') {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) throw new Error('Ticket not found');
    const targetStation = db.prepare('SELECT * FROM stations WHERE id = ?').get(targetStationId);
    if (!targetStation) throw new Error('Target station not found');

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE tickets 
      SET current_station_id = ?, status = 'WAITING', notes = ? 
      WHERE id = ?
    `).run(targetStationId, notes ? `${ticket.notes || ''} | ${notes}`.trim() : ticket.notes, ticketId);

    db.prepare(`
      INSERT INTO ticket_logs (ticket_id, station_id, action, details, timestamp)
      VALUES (?, ?, 'TRANSFERRED', ?, ?)
    `).run(ticketId, targetStationId, `Transferred to ${targetStation.name}`, nowIso);

    return this.getTicketById(ticketId);
  },

  // Get skipped tokens for a department (allows 1-click re-call)
  getSkippedTickets(department = 'medical') {
    const today = getTodayString();
    return db.prepare(`
      SELECT t.*, s.name as station_name, s.counter_number
      FROM tickets t
      LEFT JOIN stations s ON t.current_station_id = s.id
      WHERE t.status = 'SKIPPED' 
        AND t.department = ?
        AND t.queue_date = ?
      ORDER BY t.called_at DESC
    `).all(department, today);
  },

  // Display board data for the TV
  getActiveDisplayBoard() {
    const today = getTodayString();
    return db.prepare(`
      SELECT 
        s.id as station_id,
        s.name as station_name,
        s.counter_number,
        s.code as station_code,
        s.type as station_type,
        t.id as ticket_id,
        t.ticket_number,
        t.status,
        t.called_at
      FROM stations s
      LEFT JOIN tickets t ON t.current_station_id = s.id 
        AND t.status IN ('CALLED', 'SERVING') 
        AND t.queue_date = ?
      WHERE s.active = 1
      ORDER BY s.counter_number ASC
    `).all(today);
  },

  // Next expected token numbers
  getNextExpected() {
    const today = getTodayString();
    const medMax = db.prepare(`SELECT MAX(sequence_number) as m FROM tickets WHERE department = 'medical' AND queue_date = ?`).get(today);
    const dentMax = db.prepare(`SELECT MAX(sequence_number) as m FROM tickets WHERE department = 'dental' AND queue_date = ?`).get(today);
    const pharmMax = db.prepare(`SELECT MAX(sequence_number) as m FROM tickets WHERE department = 'pharmacy' AND queue_date = ?`).get(today);

    const nextMed = (medMax && medMax.m ? medMax.m : 0) + 1;
    const nextDent = (dentMax && dentMax.m ? dentMax.m : 0) + 1;
    const nextPharm = (pharmMax && pharmMax.m ? pharmMax.m : 0) + 1;

    return {
      medical: [nextMed, nextMed + 1, nextMed + 2],
      dental: [`D-${nextDent}`, `D-${nextDent + 1}`],
      pharmacy: [`Rx-${nextPharm}`, `Rx-${nextPharm + 1}`]
    };
  },

  // Next expected token for a specific station (prioritizes transferred patients)
  getNextForStation(stationId) {
    const today = getTodayString();
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) return '1';

    const transferred = db.prepare(`
      SELECT ticket_number FROM tickets 
      WHERE current_station_id = ? AND status = 'WAITING' AND queue_date = ?
      ORDER BY created_at ASC LIMIT 1
    `).get(stationId, today);

    if (transferred) {
      return `${transferred.ticket_number} (Transferred)`;
    }

    const nextExpected = this.getNextExpected();
    if (station.type === 'dental') {
      return nextExpected.dental[0];
    } else if (station.type === 'pharmacy') {
      return nextExpected.pharmacy[0];
    } else {
      return nextExpected.medical[0];
    }
  },

  // Recent calls (last 6 calls)
  getRecentCalls(limit = 6) {
    const today = getTodayString();
    return db.prepare(`
      SELECT t.ticket_number, t.called_at, s.name as station_name, s.counter_number, s.type as station_type
      FROM tickets t
      JOIN stations s ON t.current_station_id = s.id
      WHERE t.called_at IS NOT NULL AND t.queue_date = ?
      ORDER BY t.called_at DESC
      LIMIT ?
    `).all(today, limit);
  },

  // Stats
  getDailyStats() {
    const today = getTodayString();
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_called,
        SUM(CASE WHEN status IN ('CALLED', 'SERVING') THEN 1 ELSE 0 END) as serving_count,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped_count,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count
      FROM tickets
      WHERE queue_date = ?
    `).get(today);

    return {
      today,
      totalCalled: stats.total_called || 0,
      serving: stats.serving_count || 0,
      skipped: stats.skipped_count || 0,
      completed: stats.completed_count || 0
    };
  },

  // Reset today's queue back to 0/clean
  resetTodayQueue() {
    const today = getTodayString();
    db.prepare(`DELETE FROM ticket_logs WHERE ticket_id IN (SELECT id FROM tickets WHERE queue_date = ?)`).run(today);
    db.prepare(`DELETE FROM tickets WHERE queue_date = ?`).run(today);
    return true;
  }
};

module.exports = queueService;

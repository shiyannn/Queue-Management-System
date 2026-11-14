const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const queueService = require('./queueService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Simple admin session (protects reports + queue reset) ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cho-cho';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return cookies;
}

function getAdminToken(req) {
  const token = parseCookies(req).cho_admin;
  if (!token) return null;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return null;
  if (expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return token;
}

function requireAdmin(req, res, next) {
  if (!getAdminToken(req)) {
    return res.status(401).json({ success: false, error: 'Admin login required' });
  }
  next();
}

function passwordMatches(candidate) {
  const given = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const expected = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
  return crypto.timingSafeEqual(given, expected);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Helper: Broadcast state change to all screens and terminals
function notifyQueueUpdate(extraEvent = null, extraPayload = null) {
  io.emit('queue:updated', {
    displayBoard: queueService.getActiveDisplayBoard(),
    nextExpected: queueService.getNextExpected(),
    recentCalls: queueService.getRecentCalls(6),
    stats: queueService.getDailyStats()
  });

  if (extraEvent && extraPayload) {
    io.emit(extraEvent, extraPayload);
  }
}

// ================= API ROUTES =================

// 1. Get Stations
app.get('/api/stations', (req, res) => {
  try {
    const stations = queueService.getStations();
    res.json({ success: true, data: stations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1b. Update Station Online/Duty Status
app.post('/api/stations/:id/status', (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const { isOnline, onBreak, status } = req.body || {};
    
    let target = status;
    if (!target) {
      if (onBreak) target = 'ON_BREAK';
      else if (isOnline !== undefined) target = isOnline ? 'ON_DUTY' : 'OFFLINE';
      else target = 'ON_DUTY';
    }

    const info = queueService.setStationStatus(stationId, target);
    
    notifyQueueUpdate('station:status_changed', {
      stationId,
      ...info
    });

    res.json({ success: true, data: { stationId, ...info } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Call Next Token for a Station (Auto-advancing Pre-Printed Sequence)
app.post('/api/stations/:id/call-next', (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const isPriority = req.body && Boolean(req.body.isPriority);
    const ticket = queueService.callNextToken(stationId, isPriority);

    notifyQueueUpdate('ticket:called', {
      ticket,
      stationId,
      stationName: ticket.station_name,
      counterNumber: ticket.counter_number,
      ticketNumber: ticket.ticket_number,
      isPriority: ticket.is_priority === 1
    });

    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Call Specific Token Number (e.g. Doctor enters 5, or D-3, or skipped patient returns)
app.post('/api/stations/:id/call-specific', (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const { ticketNumber } = req.body;
    const ticket = queueService.callSpecificNumber(stationId, ticketNumber);

    notifyQueueUpdate('ticket:called', {
      ticket,
      stationId,
      stationName: ticket.station_name,
      counterNumber: ticket.counter_number,
      ticketNumber: ticket.ticket_number,
      isPriority: ticket.is_priority === 1
    });

    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Recall Ticket (Re-triggers TV chime & voice announcement)
app.post('/api/tickets/:id/recall', (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const ticket = queueService.recallTicket(ticketId);

    notifyQueueUpdate('ticket:called', {
      ticket,
      stationId: ticket.current_station_id,
      stationName: ticket.station_name,
      counterNumber: ticket.counter_number,
      ticketNumber: ticket.ticket_number,
      isRecall: true
    });

    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Skip Ticket (Patient didn't show up)
app.post('/api/tickets/:id/skip', (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const { reason } = req.body;
    const ticket = queueService.skipTicket(ticketId, reason);
    notifyQueueUpdate('ticket:skipped', ticket);
    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Complete Consultation
app.post('/api/tickets/:id/complete', (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const ticket = queueService.completeTicket(ticketId);
    notifyQueueUpdate('ticket:completed', ticket);
    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Transfer Ticket to another counter
app.post('/api/tickets/:id/transfer', (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const { targetStationId, notes } = req.body;
    const ticket = queueService.transferTicket(ticketId, Number(targetStationId), notes);
    notifyQueueUpdate('ticket:transferred', ticket);
    res.json({ success: true, data: ticket });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Terminal State for a Station
app.get('/api/stations/:id/terminal', (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const station = queueService.getStations().find(s => s.id === stationId);
    if (!station) return res.status(404).json({ success: false, error: 'Station not found' });

    const currentServing = queueService.getCurrentTicketForStation(stationId);
    const skippedList = queueService.getSkippedTickets(station.type);
    const history = queueService.getStationHistory(stationId, 30);

    const nextForStation = queueService.getNextForStation(stationId);

    res.json({
      success: true,
      data: {
        station,
        currentServing,
        skippedList,
        history,
        nextNumbers: nextForStation,
        nextNumber: nextForStation.waitingTransferred || nextForStation.regular
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8b. Station History
app.get('/api/stations/:id/history', (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const history = queueService.getStationHistory(stationId);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8c. Ticket Lookup / Search (Triage & Patient Station Finder)
app.get('/api/tickets/lookup', (req, res) => {
  try {
    const { q } = req.query;
    const results = queueService.lookupTicket(q || '');
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Display Board Data
app.get('/api/display', (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        displayBoard: queueService.getActiveDisplayBoard(),
        nextExpected: queueService.getNextExpected(),
        recentCalls: queueService.getRecentCalls(6),
        stats: queueService.getDailyStats()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Reset Today's Queue (Morning start) — admin only
app.post('/api/reset-today', requireAdmin, (req, res) => {
  try {
    queueService.resetTodayQueue();
    notifyQueueUpdate('queue:reset', null);
    res.json({ success: true, message: 'Queue reset successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= ADMIN AUTH =================
app.post('/api/admin/login', (req, res) => {
  try {
    if (!passwordMatches(req.body && req.body.password)) {
      return res.status(401).json({ success: false, error: 'Incorrect password' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `cho_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = getAdminToken(req);
  if (token) adminSessions.delete(token);
  res.setHeader('Set-Cookie', 'cho_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ success: true, authenticated: Boolean(getAdminToken(req)) });
});

// ================= REPORTS =================
app.get('/api/reports/summary', requireAdmin, (req, res) => {
  try {
    const today = queueService.getTodayString();
    const to = isValidDate(req.query.to) ? req.query.to : today;
    const from = isValidDate(req.query.from) ? req.query.from : addDays(to, -6);
    const groupBy = ['day', 'week', 'month'].includes(req.query.groupBy) ? req.query.groupBy : 'day';

    if (from > to) {
      return res.status(400).json({ success: false, error: '`from` must be on or before `to`' });
    }

    const summary = queueService.getReportSummary(from, to, groupBy);
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/hourly', requireAdmin, (req, res) => {
  try {
    const today = queueService.getTodayString();
    const date = isValidDate(req.query.date) ? req.query.date : today;

    const data = queueService.getHourlyCounts(date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route Shortcuts
app.get('/reports', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});
app.get('/staff', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff.html'));
});

// Socket.io Handshake & Active Station Tracking
const stationSockets = new Map(); // stationId -> Set of socket.id's
const disconnectTimers = new Map(); // stationId -> timeoutId

io.on('connection', (socket) => {
  let attachedStationId = null;

  socket.emit('queue:updated', {
    displayBoard: queueService.getActiveDisplayBoard(),
    nextExpected: queueService.getNextExpected(),
    recentCalls: queueService.getRecentCalls(6),
    stats: queueService.getDailyStats()
  });

  // Doctor joins / opens a terminal counter
  socket.on('station:join', ({ stationId }) => {
    if (!stationId) return;
    const sId = Number(stationId);
    attachedStationId = sId;

    // Clear any pending disconnect timer (e.g. from page refresh)
    if (disconnectTimers.has(sId)) {
      clearTimeout(disconnectTimers.get(sId));
      disconnectTimers.delete(sId);
    }

    if (!stationSockets.has(sId)) {
      stationSockets.set(sId, new Set());
    }
    stationSockets.get(sId).add(socket.id);

    // Automatically set station Online
    queueService.setStationStatus(sId, true);
    notifyQueueUpdate('station:status_changed', { stationId: sId, isOnline: true });
  });

  // Doctor leaves / switches counter manually
  socket.on('station:leave', ({ stationId }) => {
    const sId = Number(stationId || attachedStationId);
    if (!sId) return;
    if (stationSockets.has(sId)) {
      stationSockets.get(sId).delete(socket.id);
      if (stationSockets.get(sId).size === 0) {
        stationSockets.delete(sId);
        queueService.setStationStatus(sId, false);
        notifyQueueUpdate('station:status_changed', { stationId: sId, isOnline: false });
      }
    }
    attachedStationId = null;
  });

  // Doctor closes browser tab, powers down, or loses connection
  socket.on('disconnect', () => {
    if (!attachedStationId) return;
    const sId = attachedStationId;
    if (stationSockets.has(sId)) {
      const set = stationSockets.get(sId);
      set.delete(socket.id);

      if (set.size === 0) {
        // Start a 5-second grace period in case of quick page refresh
        const timer = setTimeout(() => {
          if (!stationSockets.has(sId) || stationSockets.get(sId).size === 0) {
            stationSockets.delete(sId);
            queueService.setStationStatus(sId, false);
            notifyQueueUpdate('station:status_changed', { stationId: sId, isOnline: false });
          }
          disconnectTimers.delete(sId);
        }, 5000);

        disconnectTimers.set(sId, timer);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🏥 CHO Pre-Printed Clinic Queue System is running!`);
  console.log(`   - Display (Waiting Room TV):  http://localhost:${PORT}/display`);
  console.log(`   - Staff Terminal (Doctors):   http://localhost:${PORT}/staff`);
  console.log(`   - Reports Dashboard (admin):  http://localhost:${PORT}/reports`);
  console.log(`   - Control Hub:                http://localhost:${PORT}/`);
  console.log(`====================================================`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('⚠️  ADMIN_PASSWORD not set — using default "cho-cho". Set it in the environment for production.');
  }
});

const express = require('express');
const http = require('http');
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

// 10. Reset Today's Queue (Morning start)
app.post('/api/reset-today', (req, res) => {
  try {
    queueService.resetTodayQueue();
    notifyQueueUpdate('queue:reset', null);
    res.json({ success: true, message: 'Queue reset successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route Shortcuts
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});
app.get('/staff', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff.html'));
});

// Socket.io Handshake
io.on('connection', (socket) => {
  socket.emit('queue:updated', {
    displayBoard: queueService.getActiveDisplayBoard(),
    nextExpected: queueService.getNextExpected(),
    recentCalls: queueService.getRecentCalls(6),
    stats: queueService.getDailyStats()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🏥 CHO Pre-Printed Clinic Queue System is running!`);
  console.log(`   - Display (Waiting Room TV):  http://localhost:${PORT}/display`);
  console.log(`   - Staff Terminal (Doctors):   http://localhost:${PORT}/staff`);
  console.log(`   - Control Hub:                http://localhost:${PORT}/`);
  console.log(`====================================================`);
});

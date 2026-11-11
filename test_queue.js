// Service-level tests for the CHO pre-printed queue system.
// Runs against an isolated temporary database so real queue data is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `cho_queue_test_${Date.now()}.db`);
process.env.DB_PATH = dbPath;

const db = require('./database');
const queueService = require('./queueService');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` :: ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function cleanup() {
  try { db.close(); } catch (_) { }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) { }
  }
}

function run() {
  console.log('\n=== Stations & categories ===');
  const stations = queueService.getStations();
  check('5 active stations', stations.length === 5, `got ${stations.length}`);
  check('sorted by counter_number', stations.every((s, i) => i === 0 || s.counter_number > stations[i - 1].counter_number));
  const medical = stations.filter(s => s.type === 'medical');
  const dental = stations.filter(s => s.type === 'dental');
  check('4 medical stations', medical.length === 4, `got ${medical.length}`);
  check('1 dental station', dental.length === 1, `got ${dental.length}`);

  const medA = medical.find(s => s.counter_number === 1).id;
  const medB = medical.find(s => s.counter_number === 2).id;
  const medC = medical.find(s => s.counter_number === 3).id;
  const medD = medical.find(s => s.counter_number === 4).id;
  const dentId = dental[0].id;

  console.log('\n=== FIFO / priority / dental calling ===');
  queueService.resetTodayQueue();
  const r1 = queueService.callNextToken(medA);
  check('first medical call -> R-1', r1.ticket_number === 'R-1', r1.ticket_number);
  const r2 = queueService.callNextToken(medA);
  check('second medical call -> R-2', r2.ticket_number === 'R-2', r2.ticket_number);
  check('previous R-1 auto-completed', queueService.getTicketById(r1.id).status === 'COMPLETED');

  const p1 = queueService.callNextToken(medB, true);
  check('priority call -> P-1', p1.ticket_number === 'P-1', p1.ticket_number);
  check('P-1 flagged priority', p1.is_priority === 1);

  const d1 = queueService.callNextToken(dentId);
  check('dental call -> D-1', d1.ticket_number === 'D-1', d1.ticket_number);
  const d2 = queueService.callNextToken(dentId);
  check('dental call again -> D-2', d2.ticket_number === 'D-2', d2.ticket_number);

  console.log('\n=== Display board / stats / next expected ===');
  const board = queueService.getActiveDisplayBoard();
  check('board has 5 stations', board.length === 5, `got ${board.length}`);
  check('board counter 1 serving R-2', board.find(s => s.counter_number === 1).ticket_number === 'R-2');
  const stats = queueService.getDailyStats();
  check('totalCalled = 5', stats.totalCalled === 5, `got ${stats.totalCalled}`);
  check('serving = 3', stats.serving === 3, `got ${stats.serving}`);
  check('recentCalls has 5', queueService.getRecentCalls(10).length === 5);
  const next = queueService.getNextExpected();
  check('next medical R-3', next.medical[0] === 'R-3', next.medical[0]);
  check('next priority P-2', next.priority[0] === 'P-2', next.priority[0]);
  check('next dental D-3', next.dental[0] === 'D-3', next.dental[0]);
  check('nextForStation regular R-3', queueService.getNextForStation(medA).regular === 'R-3');

  console.log('\n=== Specific call / skip / complete / recall ===');
  const r9 = queueService.callSpecificNumber(medC, 'R-9');
  check('call-specific R-9', r9.ticket_number === 'R-9', r9.ticket_number);
  const bare = queueService.callSpecificNumber(medD, '7');
  check('bare "7" normalized to R-7', bare.ticket_number === 'R-7', bare.ticket_number);
  const skipped = queueService.skipTicket(r9.id, 'No-show');
  check('skip -> SKIPPED', skipped.status === 'SKIPPED');
  check('skipped list contains R-9', queueService.getSkippedTickets('medical').some(t => t.ticket_number === 'R-9'));
  const recalled = queueService.callSpecificNumber(medC, 'R-9');
  check('call-specific recalls existing R-9', recalled.id === r9.id && recalled.status === 'CALLED');
  const completed = queueService.completeTicket(recalled.id);
  check('complete -> COMPLETED', completed.status === 'COMPLETED');
  const recalledAgain = queueService.recallTicket(r2.id);
  check('recall returns R-2', recalledAgain.ticket_number === 'R-2');

  console.log('\n=== Transfer ===');
  const transferred = queueService.transferTicket(bare.id, dentId, 'Needs dental check');
  check('transfer -> WAITING', transferred.status === 'WAITING');
  check('transfer moves station', transferred.current_station_id === dentId);
  check('transfer saves notes', (transferred.notes || '').includes('Needs dental check'));
  check('nextForStation shows waiting transfer', queueService.getNextForStation(dentId).waitingTransferred === 'R-7');
  const recalledTransfer = queueService.callNextToken(dentId);
  check('callNext recalls transferred R-7', recalledTransfer.id === bare.id && recalledTransfer.ticket_number === 'R-7');
  check('transferred ticket now CALLED', recalledTransfer.status === 'CALLED');

  console.log('\n=== Lookup & history ===');
  check('lookup R-2', queueService.lookupTicket('R-2').some(t => t.ticket_number === 'R-2'));
  check('lookup #R-2 strips hash', queueService.lookupTicket('#R-2').some(t => t.ticket_number === 'R-2'));
  check('lookup D-2', queueService.lookupTicket('D-2').some(t => t.ticket_number === 'D-2'));
  check('lookup unknown empty', queueService.lookupTicket('ZZZ-999').length === 0);
  const history = queueService.getStationHistory(medA);
  check('history includes R-1 and R-2', history.some(h => h.ticket_number === 'R-1') && history.some(h => h.ticket_number === 'R-2'));

  console.log('\n=== Reports ===');
  const today = queueService.getTodayString();
  const report = queueService.getReportSummary(today, today, 'day');
  check('report totals match daily stats', report.totals.total === queueService.getDailyStats().totalCalled, `${report.totals.total} vs ${queueService.getDailyStats().totalCalled}`);
  check('report counts 1 priority ticket', report.totals.priority === 1, `got ${report.totals.priority}`);
  check('report regular = total - priority', report.totals.regular === report.totals.total - report.totals.priority);
  check('report has one day bucket', report.series.length === 1 && report.series[0].bucket === today);
  check('report has medical + dental stations', report.byStation.some(d => d.stationType === 'medical') && report.byStation.some(d => d.stationType === 'dental'));
  check('report byStation total matches report total', report.byStation.reduce((sum, s) => sum + s.total, 0) === report.totals.total);
  const weekReport = queueService.getReportSummary(today, today, 'week');
  check('week report buckets by week', weekReport.series.length === 1 && /^\d{4}-W\d{2}$/.test(weekReport.series[0].bucket), weekReport.series[0] && weekReport.series[0].bucket);
  const monthReport = queueService.getReportSummary(today, today, 'month');
  check('month report buckets by month', monthReport.series.length === 1 && /^\d{4}-\d{2}$/.test(monthReport.series[0].bucket));

  const hourly = queueService.getHourlyCounts(today);
  check('hourly has 24 buckets', hourly.hours.length === 24);
  check('hourly sum equals hourly total', hourly.hours.reduce((a, b) => a + b, 0) === hourly.total);
  check('hourly total equals report total', hourly.total === report.totals.total, `${hourly.total} vs ${report.totals.total}`);
  const emptyHourly = queueService.getHourlyCounts('2000-01-01');
  check('empty day has zero total', emptyHourly.total === 0);
  check('empty day has 24 buckets', emptyHourly.hours.length === 24);

  console.log('\n=== Reset ===');
  queueService.resetTodayQueue();
  check('stats zero after reset', queueService.getDailyStats().totalCalled === 0);
  check('board cleared after reset', queueService.getActiveDisplayBoard().every(s => s.ticket_number === null));
  check('lookup empty after reset', queueService.lookupTicket('R-1').length === 0);

  console.log('\n================ SUMMARY ================');
  console.log(`PASSED: ${pass}`);
  console.log(`FAILED: ${fail}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
}

try {
  run();
} catch (err) {
  fail++;
  console.error('\nTEST ERROR:', err);
} finally {
  cleanup();
}

process.exit(fail === 0 ? 0 : 1);

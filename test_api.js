// End-to-end tests: boots the real server on a free port against an isolated
// temporary database, then exercises HTTP routes, ticket lifecycle and Socket.io.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const dbPath = path.join(os.tmpdir(), `cho_queue_api_test_${Date.now()}.db`);
const TEST_ADMIN_PASSWORD = 'test-admin-pass';
let BASE = '';
let child = null;
let serverOut = '';
let serverErr = '';
let adminCookie = '';

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await getFreePort();
  BASE = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { serverOut += d.toString(); });
  child.stderr.on('data', d => { serverErr += d.toString(); });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + '/api/display');
      if (res.status === 200) return;
    } catch (_) { }
    await sleep(200);
  }
  throw new Error(`Server did not start.\nstdout: ${serverOut}\nstderr: ${serverErr}`);
}

async function api(method, route, body) {
  const opts = { method, headers: {} };
  if (adminCookie) opts.headers['Cookie'] = adminCookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + route, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { }
  return { status: res.status, text, json };
}

async function run() {
  console.log('\n=== Admin auth ===');
  const noAuthReport = await api('GET', '/api/reports/summary');
  check('reports require auth -> 401', noAuthReport.status === 401, `status=${noAuthReport.status}`);
  const noAuthHourly = await api('GET', '/api/reports/hourly');
  check('hourly report requires auth -> 401', noAuthHourly.status === 401, `status=${noAuthHourly.status}`);
  const noAuthReset = await api('POST', '/api/reset-today');
  check('reset requires auth -> 401', noAuthReset.status === 401, `status=${noAuthReset.status}`);
  const badLogin = await api('POST', '/api/admin/login', { password: 'wrong-password' });
  check('wrong password -> 401', badLogin.status === 401, `status=${badLogin.status}`);
  const loginRes = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  adminCookie = setCookie.split(';')[0];
  check('correct password -> 200', loginRes.status === 200, `status=${loginRes.status}`);
  check('login sets session cookie', adminCookie.startsWith('cho_admin='), setCookie.slice(0, 40));
  const sess = await api('GET', '/api/admin/session');
  check('session authenticated', sess.json.authenticated === true);
  const authReport = await api('GET', '/api/reports/summary');
  check('reports allowed after login', authReport.status === 200 && authReport.json.success === true);

  console.log('\n=== Static pages & assets ===');
  const pages = [
    ['/', 'Outpatient Department Queue'],
    ['/', 'Active Consultation Rooms'],
    ['/', 'Patient Token'],
    ['/', 'statActiveCounters'],
    ['/display', 'Waiting Area TV'],
    ['/staff', ''],
    ['/reports', 'Admin Access'],
  ];
  for (const [route, marker] of pages) {
    const r = await api('GET', route);
    check(`GET ${route} -> 200`, r.status === 200, `status=${r.status}`);
    if (marker) check(`GET ${route} contains "${marker}"`, r.text.includes(marker));
  }
  const logo = await fetch(BASE + '/logo.jpg');
  check('GET /logo.jpg -> 200', logo.status === 200, `status=${logo.status}`);

  console.log('\n=== Welcome page wiring ===');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  for (const id of ['liveTime', 'statTotalCalled', 'statServing', 'statActiveCounters', 'stationsList', 'tokenSearchInput', 'lookupResultBox']) {
    check(`element #${id} exists`, html.includes(`id="${id}"`));
  }
  for (const fn of ['updateClock', 'updateStats', 'renderStations', 'loadData', 'resetDailyQueue', 'lookupToken']) {
    check(`function ${fn} defined`, html.includes(`function ${fn}`) || html.includes(`${fn} =`));
  }
  check('no stale default stations', !html.includes('renderStations(defaultStations)'));
  check('no SOP section', !html.includes('Standard Operating Procedure'));
  check('no old workflow section', !html.includes('Clinic Queue Workflow'));

  const reportsHtml = fs.readFileSync(path.join(__dirname, 'public', 'reports.html'), 'utf8');
  for (const id of ['loginForm', 'passwordInput', 'dashboardView', 'fromDate', 'toDate', 'groupBy', 'reportChart', 'doctorTableBody', 'hourlyDate', 'hourlyChart']) {
    check(`reports element #${id} exists`, reportsHtml.includes(`id="${id}"`));
  }
  for (const fn of ['checkSession', 'loadReports', 'renderReport', 'exportCsv', 'exportPdf', 'logout', 'loadHourly', 'renderHourly']) {
    check(`reports function ${fn} defined`, reportsHtml.includes(`function ${fn}`) || reportsHtml.includes(`async function ${fn}`));
  }
  check('reports PDF export button present', reportsHtml.includes('id="exportPdfBtn"') && reportsHtml.includes('exportPdf()'));
  check('reports loads jsPDF', reportsHtml.includes('jspdf.umd.min.js'));
  check('reports loads autoTable plugin', reportsHtml.includes('jspdf.plugin.autotable.min.js'));
  check('reports PDF includes doctor breakdown', reportsHtml.includes('By Doctor / Station'));

  for (const file of ['index.html', 'kiosk.html', 'display.html', 'staff.html', 'reports.html']) {
    const content = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
    check(`${file} has footer credit`, content.includes('© shiyann'));
  }

  console.log('\n=== Stations API ===');
  const stRes = await api('GET', '/api/stations');
  check('/api/stations success', stRes.status === 200 && stRes.json.success === true);
  const stations = stRes.json.data;
  check('5 active stations', stations.length === 5, `got ${stations.length}`);
  check('sorted by counter_number', stations.every((s, i) => i === 0 || s.counter_number > stations[i - 1].counter_number));
  const medical = stations.filter(s => s.type === 'medical');
  const dental = stations.filter(s => s.type === 'dental');
  check('4 medical stations', medical.length === 4, `got ${medical.length}`);
  check('1 dental station', dental.length === 1, `got ${dental.length}`);

  console.log('\n=== Fresh reset ===');
  const reset0 = await api('POST', '/api/reset-today');
  check('reset-today success', reset0.status === 200 && reset0.json.success);
  let disp = (await api('GET', '/api/display')).json.data;
  check('stats zero after reset', disp.stats.totalCalled === 0 && disp.stats.serving === 0);
  check('board all ready after reset', disp.displayBoard.every(s => s.ticket_number === null));

  const medA = medical.find(s => s.counter_number === 1).id;
  const medB = medical.find(s => s.counter_number === 2).id;
  const medC = medical.find(s => s.counter_number === 3).id;
  const medD = medical.find(s => s.counter_number === 4).id;
  const dentId = dental[0].id;

  console.log('\n=== Call next (regular / priority / dental) ===');
  const c1 = await api('POST', `/api/stations/${medA}/call-next`, {});
  check('medical #1 -> R-1', c1.status === 200 && c1.json.data.ticket_number === 'R-1');
  check('R-1 status CALLED', c1.json.data.status === 'CALLED');
  const c2 = await api('POST', `/api/stations/${medA}/call-next`, {});
  check('medical #1 again -> R-2', c2.json.data.ticket_number === 'R-2');
  const r1look = await api('GET', '/api/tickets/lookup?q=R-1');
  check('R-1 auto-completed on next call', r1look.json.data[0] && r1look.json.data[0].status === 'COMPLETED');

  const cp = await api('POST', `/api/stations/${medB}/call-next`, { isPriority: true });
  check('priority -> P-1', cp.json.data.ticket_number === 'P-1');
  check('P-1 is_priority = 1', cp.json.data.is_priority === 1);

  const d1 = await api('POST', `/api/stations/${dentId}/call-next`, {});
  check('dental -> D-1', d1.json.data.ticket_number === 'D-1');
  const d2 = await api('POST', `/api/stations/${dentId}/call-next`, {});
  check('dental again -> D-2', d2.json.data.ticket_number === 'D-2');

  console.log('\n=== Display board / stats ===');
  disp = (await api('GET', '/api/display')).json.data;
  check('totalCalled = 5', disp.stats.totalCalled === 5, `got ${disp.stats.totalCalled}`);
  check('serving = 3', disp.stats.serving === 3, `got ${disp.stats.serving}`);
  check('recentCalls has 5', disp.recentCalls.length === 5, `got ${disp.recentCalls.length}`);
  check('next medical R-3', disp.nextExpected.medical[0] === 'R-3');
  check('next priority P-2', disp.nextExpected.priority[0] === 'P-2');
  check('next dental D-3', disp.nextExpected.dental[0] === 'D-3');
  check('board counter 1 serving R-2', disp.displayBoard.find(s => s.counter_number === 1).ticket_number === 'R-2');

  console.log('\n=== Reports API ===');
  const rep = (await api('GET', '/api/reports/summary')).json.data;
  check('report total = 5', rep.totals.total === 5, `got ${rep.totals.total}`);
  check('report priority = 1', rep.totals.priority === 1, `got ${rep.totals.priority}`);
  check('report regular = 4', rep.totals.regular === 4, `got ${rep.totals.regular}`);
  check('report completed = 2', rep.totals.completed === 2, `got ${rep.totals.completed}`);
  check('report serving = 3', rep.totals.serving === 3, `got ${rep.totals.serving}`);
  check('report default groupBy day', rep.groupBy === 'day');
  check('report series has today', rep.series.length >= 1);
  check('report byStation total sums to 5', rep.byStation.reduce((sum, s) => sum + s.total, 0) === 5, JSON.stringify(rep.byStation));
  const repCounter1 = rep.byStation.find(s => s.counterNumber === 1);
  check('report counter 1 total = 2', repCounter1 && repCounter1.total === 2, JSON.stringify(repCounter1));
  check('report counter 1 completed = 1', repCounter1 && repCounter1.completed === 1, JSON.stringify(repCounter1));
  const repDentStation = rep.byStation.find(s => s.stationType === 'dental');
  check('report dental station total = 2', repDentStation && repDentStation.total === 2, JSON.stringify(repDentStation));
  const repWeek = (await api('GET', '/api/reports/summary?groupBy=week')).json.data;
  check('report week bucket format', repWeek.series.length === 1 && /^\d{4}-W\d{2}$/.test(repWeek.series[0].bucket), JSON.stringify(repWeek.series[0]));
  const repMonth = (await api('GET', '/api/reports/summary?groupBy=month')).json.data;
  check('report month bucket format', repMonth.series.length === 1 && /^\d{4}-\d{2}$/.test(repMonth.series[0].bucket), JSON.stringify(repMonth.series[0]));
  const badRange = await api('GET', '/api/reports/summary?from=2026-12-31&to=2026-01-01');
  check('report invalid range -> 400', badRange.status === 400, `status=${badRange.status}`);
  const badGroup = (await api('GET', '/api/reports/summary?groupBy=year')).json.data;
  check('report invalid groupBy falls back to day', badGroup.groupBy === 'day');

  const hourly = (await api('GET', '/api/reports/hourly')).json.data;
  check('hourly returns a single day', !!hourly.date && !hourly.days);
  check('hourly total = 5', hourly.total === 5, `got ${hourly.total}`);
  check('hourly has 24 buckets', hourly.hours.length === 24);
  check('hourly sum matches total', hourly.hours.reduce((a, b) => a + b, 0) === hourly.total);
  const hourlyEmpty = (await api('GET', '/api/reports/hourly?date=2000-01-01')).json.data;
  check('hourly empty day total = 0', hourlyEmpty.total === 0, `got ${hourlyEmpty.total}`);
  const hourlyBad = (await api('GET', '/api/reports/hourly?date=nope')).json.data;
  check('hourly invalid date falls back to today', hourlyBad.date === hourly.date);

  console.log('\n=== Terminal endpoint ===');
  const term = await api('GET', `/api/stations/${medA}/terminal`);
  check('terminal success', term.status === 200 && term.json.success);
  check('terminal serving R-2', term.json.data.currentServing && term.json.data.currentServing.ticket_number === 'R-2');
  check('terminal next regular R-3', term.json.data.nextNumbers.regular === 'R-3');
  check('terminal history has R-1 & R-2', term.json.data.history.some(h => h.ticket_number === 'R-1') && term.json.data.history.some(h => h.ticket_number === 'R-2'));

  console.log('\n=== Lookup ===');
  const lk1 = await api('GET', '/api/tickets/lookup?q=R-2');
  check('lookup R-2', lk1.json.data.length >= 1 && lk1.json.data[0].ticket_number === 'R-2');
  const lk2 = await api('GET', '/api/tickets/lookup?q=%23R-2');
  check('lookup #R-2 strips hash', lk2.json.data.length >= 1);
  const lk3 = await api('GET', '/api/tickets/lookup?q=D-2');
  check('lookup D-2', lk3.json.data.length >= 1 && lk3.json.data[0].ticket_number === 'D-2');
  const lk4 = await api('GET', '/api/tickets/lookup?q=ZZZ-999');
  check('lookup unknown empty', Array.isArray(lk4.json.data) && lk4.json.data.length === 0);

  console.log('\n=== Recall ===');
  const rec = await api('POST', `/api/tickets/${c2.json.data.id}/recall`, {});
  check('recall success', rec.status === 200 && rec.json.success);
  check('recall returns R-2', rec.json.data.ticket_number === 'R-2');

  console.log('\n=== Call specific / skip / complete ===');
  const cs = await api('POST', `/api/stations/${medC}/call-specific`, { ticketNumber: 'R-9' });
  check('call-specific R-9', cs.status === 200 && cs.json.data.ticket_number === 'R-9');
  const skip = await api('POST', `/api/tickets/${cs.json.data.id}/skip`, { reason: 'No show' });
  check('skip -> SKIPPED', skip.json.data.status === 'SKIPPED');
  const termC = await api('GET', `/api/stations/${medC}/terminal`);
  check('skipped list has R-9', termC.json.data.skippedList.some(t => t.ticket_number === 'R-9'));
  const comp = await api('POST', `/api/tickets/${cs.json.data.id}/complete`, {});
  check('complete -> COMPLETED', comp.json.data.status === 'COMPLETED');
  const bare = await api('POST', `/api/stations/${medD}/call-specific`, { ticketNumber: '7' });
  check('bare "7" -> R-7', bare.json.data.ticket_number === 'R-7', bare.json.data.ticket_number);

  console.log('\n=== Transfer ===');
  const tr = await api('POST', `/api/tickets/${bare.json.data.id}/transfer`, { targetStationId: dentId, notes: 'Needs dental check' });
  check('transfer success', tr.status === 200 && tr.json.success);
  check('transferred WAITING', tr.json.data.status === 'WAITING');
  check('transferred to dental', tr.json.data.current_station_id === dentId);
  check('transfer notes saved', (tr.json.data.notes || '').includes('Needs dental check'));
  const dn = await api('POST', `/api/stations/${dentId}/call-next`, {});
  check('callNext recalls transferred R-7', dn.json.data.ticket_number === 'R-7', JSON.stringify(dn.json.data));
  check('transferred now CALLED', dn.json.data.status === 'CALLED');

  console.log('\n=== Recall an existing skipped token ===');
  const rec9 = await api('POST', `/api/stations/${medC}/call-specific`, { ticketNumber: 'R-9' });
  check('call-specific recalls existing R-9', rec9.json.data.ticket_number === 'R-9');
  check('R-9 now CALLED', rec9.json.data.status === 'CALLED');

  console.log('\n=== History endpoint ===');
  const hist = await api('GET', `/api/stations/${medA}/history`);
  check('/history returns array', hist.status === 200 && Array.isArray(hist.json.data));

  console.log('\n=== Error handling ===');
  const e1 = await api('POST', `/api/stations/${medA}/call-specific`, {});
  check('call-specific without number -> 500', e1.status === 500, `status=${e1.status}`);
  const e2 = await api('POST', '/api/stations/999/call-next', {});
  check('call-next invalid station -> 500', e2.status === 500, `status=${e2.status}`);
  const e3 = await api('GET', '/api/stations/999/terminal');
  check('terminal invalid station -> 404', e3.status === 404, `status=${e3.status}`);

  console.log('\n=== Socket.io real-time updates ===');
  const hs = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`);
  const hsText = await hs.text();
  check('engine.io handshake opens', hs.status === 200 && hsText.startsWith('0'), hsText.slice(0, 60));
  const hsJson = JSON.parse(hsText.slice(1));
  const sessionUrl = `${BASE}/socket.io/?EIO=4&transport=polling&sid=${hsJson.sid}`;

  const postC = await fetch(sessionUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '40' });
  check('socket.io connect POST ok', (await postC.text()) === 'ok');
  const poll1 = await (await fetch(sessionUrl)).text();
  const packets1 = poll1.split('\u001e');
  check('namespace connect ack received', packets1.some(p => p.startsWith('40')));
  const firstUpdate = packets1.find(p => p.startsWith('42'));
  let firstEvent = null;
  if (firstUpdate) firstEvent = JSON.parse(firstUpdate.slice(2))[0];
  check('initial queue:updated received', firstEvent === 'queue:updated', String(firstEvent));
  const beforeSockStats = firstUpdate ? JSON.parse(firstUpdate.slice(2))[1].stats.totalCalled : null;

  await api('POST', `/api/stations/${medA}/call-next`, {});
  const poll2 = await (await fetch(sessionUrl)).text();
  const updates = poll2.split('\u001e').filter(p => p.startsWith('42')).map(p => JSON.parse(p.slice(2)));
  const qUpdate = updates.find(u => u[0] === 'queue:updated');
  const calledEvt = updates.find(u => u[0] === 'ticket:called');
  check('broadcast queue:updated', !!qUpdate);
  check('broadcast ticket:called', !!calledEvt, updates.map(u => u[0]).join(','));
  if (qUpdate) {
    check('socket stats incremented', qUpdate[1].stats.totalCalled === (beforeSockStats === null ? 1 : beforeSockStats + 1));
    check('socket payload has 5-station displayBoard', Array.isArray(qUpdate[1].displayBoard) && qUpdate[1].displayBoard.length === 5);
  }

  console.log('\n=== Final reset ===');
  const reset1 = await api('POST', '/api/reset-today');
  check('final reset success', reset1.status === 200 && reset1.json.success);
  disp = (await api('GET', '/api/display')).json.data;
  check('stats cleared', disp.stats.totalCalled === 0 && disp.stats.serving === 0);
  check('board cleared', disp.displayBoard.every(s => s.ticket_number === null));
  const lkAfter = await api('GET', '/api/tickets/lookup?q=R-1');
  check('lookup empty after reset', lkAfter.json.data.length === 0);

  console.log('\n=== Logout ===');
  const logoutRes = await api('POST', '/api/admin/logout');
  check('logout success', logoutRes.status === 200 && logoutRes.json.success === true);
  const afterLogout = await api('GET', '/api/reports/summary');
  check('reports blocked after logout', afterLogout.status === 401, `status=${afterLogout.status}`);
  const resetAfterLogout = await api('POST', '/api/reset-today');
  check('reset blocked after logout', resetAfterLogout.status === 401, `status=${resetAfterLogout.status}`);
}

async function teardown() {
  if (child && !child.killed) {
    try { child.kill(); } catch (_) { }
  }
  await sleep(600);
  for (const suffix of ['', '-wal', '-shm']) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
        break;
      } catch (_) {
        await sleep(200);
      }
    }
  }
}

(async () => {
  try {
    console.log('Starting test server with isolated DB:', dbPath);
    await startServer();
    await run();
  } catch (err) {
    fail++;
    console.error('\nTEST HARNESS ERROR:', err.message || err);
  } finally {
    await teardown();
  }

  console.log('\n================ SUMMARY ================');
  console.log(`PASSED: ${pass}`);
  console.log(`FAILED: ${fail}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail === 0 ? 0 : 1);
})();

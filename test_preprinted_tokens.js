const queueService = require('./queueService');

console.log('🧪 Testing Pre-Printed Token FIFO Queue System (3 Doctors + 1 Dental)...');

// Clean slate for test
queueService.resetTodayQueue();

// 1. Get Stations
const stations = queueService.getStations();
console.log('✅ Loaded Stations:', stations.map(s => `C${s.counter_number}: ${s.name} (${s.type})`));

const doc1 = stations[0].id;
const doc2 = stations[1].id;
const doc3 = stations[2].id;
const dental = stations.find(s => s.type === 'dental').id;

// 2. Doctor 1 calls next token
const c1 = queueService.callNextToken(doc1);
console.log(`Doctor 1 called: #${c1.ticket_number} (Expected: #R-1)`);
if (c1.ticket_number !== 'R-1') throw new Error('Expected #R-1');

// 3. Doctor 2 calls next token
const c2 = queueService.callNextToken(doc2);
console.log(`Doctor 2 called: #${c2.ticket_number} (Expected: #R-2)`);
if (c2.ticket_number !== 'R-2') throw new Error('Expected #R-2');

// 4. Doctor 3 calls next token
const c3 = queueService.callNextToken(doc3);
console.log(`Doctor 3 called: #${c3.ticket_number} (Expected: #R-3)`);
if (c3.ticket_number !== 'R-3') throw new Error('Expected #R-3');

// 5. Dental Clinic calls next token
const d1 = queueService.callNextToken(dental);
console.log(`Dental Clinic called: #${d1.ticket_number} (Expected: #D-1)`);
if (d1.ticket_number !== 'D-1') throw new Error('Expected #D-1');

// 6. Dental Clinic calls again
const d2 = queueService.callNextToken(dental);
console.log(`Dental Clinic called: #${d2.ticket_number} (Expected: #D-2)`);
if (d2.ticket_number !== 'D-2') throw new Error('Expected #D-2');

// 7. Doctor 1 finishes #1 and calls next token
const c4 = queueService.callNextToken(doc1);
console.log(`Doctor 1 called: #${c4.ticket_number} (Expected: #R-4)`);
if (c4.ticket_number !== 'R-4') throw new Error('Expected #R-4');

// 8. Doctor 2 skips token #2 (no-show)
queueService.skipTicket(c2.id, 'Patient stepped out');
const skipped = queueService.getSkippedTickets('medical');
console.log(`Skipped tokens in medical: ${skipped.length} (Token: #${skipped[0].ticket_number})`);
if (skipped[0].ticket_number !== 'R-2') throw new Error('Expected skipped token #2');

// 9. Doctor 3 calls specific token #2 back
const recallSpec = queueService.callSpecificNumber(doc3, '2');
console.log(`Doctor 3 recalled specific token: #${recallSpec.ticket_number}`);
if (recallSpec.ticket_number !== 'R-2') throw new Error('Expected token #R-2 to be recalled');

// 10. Check Next Expected numbers for TV display
const nextExp = queueService.getNextExpected();
console.log('Next Expected Tokens on TV:', nextExp);

// 11. Check Display Board
const board = queueService.getActiveDisplayBoard();
console.log('Display Board State:');
board.forEach(st => console.log(`  Counter ${st.counter_number} (${st.station_name}): Serving #${st.ticket_number || 'Ready'}`));

console.log('\n🎉 ALL PRE-PRINTED TOKEN TESTS PASSED PERFECTLY!');


const queueService = require('./queueService');

console.log('🧪 Testing CHO FIFO Queue System (3 Doctors & 1 Dental)...');

// 1. Verify Stations & Categories
const stations = queueService.getStations();
console.log(`✅ Loaded ${stations.length} stations:`, stations.map(s => `Counter ${s.counter_number}: ${s.name} (${s.type})`));
if (stations.length !== 4) throw new Error(`Expected exactly 4 stations, got ${stations.length}`);

const categories = queueService.getCategories();
console.log(`✅ Loaded ${categories.length} categories:`, categories.map(c => `${c.prefix} (${c.name})`));

// 2. Issue tickets
// Medical Regular
const t1 = queueService.issueTicket({ categoryId: 1, patientName: 'Juan Dela Cruz' });
console.log(`🎫 Issued Medical Regular: ${t1.ticket_number}`);

// Medical Priority (Senior Citizen)
const t2 = queueService.issueTicket({ categoryId: 2, patientName: 'Lolo Pedro' });
console.log(`🎫 Issued Medical Priority: ${t2.ticket_number}`);

// Dental Regular
const t3 = queueService.issueTicket({ categoryId: 3, patientName: 'Maria Santos' });
console.log(`🎫 Issued Dental Regular: ${t3.ticket_number}`);

// Dental Priority
const t4 = queueService.issueTicket({ categoryId: 4, patientName: 'Lola Carmen' });
console.log(`🎫 Issued Dental Priority: ${t4.ticket_number}`);

// Emergency Medical
const t5 = queueService.issueTicket({ categoryId: 5, patientName: 'Urgent Care' });
console.log(`🎫 Issued Emergency: ${t5.ticket_number}`);

// 3. Test Doctor 1 calling next Medical patient:
// Emergency (E-001) should be called first!
const doc1 = stations[0].id;
const callDoc1 = queueService.callNextTicket(doc1);
console.log(`Doctor 1 called: ${callDoc1.ticket_number} (Expected E-001)`);
if (callDoc1.ticket_number !== 'E-001') throw new Error('Emergency priority failed');

// Doctor 2 calling next Medical patient:
// Priority Medical (P-001) should be called!
const doc2 = stations[1].id;
const callDoc2 = queueService.callNextTicket(doc2);
console.log(`Doctor 2 called: ${callDoc2.ticket_number} (Expected P-001)`);
if (callDoc2.ticket_number !== 'P-001') throw new Error('Priority medical failed');

// Doctor 3 calling next Medical patient:
// Regular Medical (R-001) should be called!
const doc3 = stations[2].id;
const callDoc3 = queueService.callNextTicket(doc3);
console.log(`Doctor 3 called: ${callDoc3.ticket_number} (Expected R-001)`);
if (callDoc3.ticket_number !== 'R-001') throw new Error('Regular medical failed');

// 4. Test Dental Clinic calling next Dental patient:
// Dental Priority (DP-001) should be called first!
const dental = stations[3].id;
const callDental = queueService.callNextTicket(dental);
console.log(`Dental Clinic called: ${callDental.ticket_number} (Expected DP-001)`);
if (callDental.ticket_number !== 'DP-001') throw new Error('Dental priority failed');

// Next call at Dental Clinic should be Dental Regular (D-001)!
const callDental2 = queueService.callNextTicket(dental);
console.log(`Dental Clinic called: ${callDental2.ticket_number} (Expected D-001)`);
if (callDental2.ticket_number !== 'D-001') throw new Error('Dental regular failed');

console.log('\n📊 Daily Stats:', queueService.getDailyStats());
console.log('\n🎉 ALL TESTS PASSED! 3 Doctors and 1 Dental clinic queue working cleanly in FIFO order!');

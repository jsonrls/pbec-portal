import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSZip, records, studentActions, fixture, selections, user } from './class-record-fixture.mjs';

test('roster names, numeric IDs, zero IDs, archive filtering and escaping', () => {
    const students = [{ _id: 'mobile', studentName: 'Ána Smith', studentId: 123 },
        { _id: 'zero', fullName: 'Zero', studentId: 0 }, { _id: 'archive', name: 'Archived', studentId: '001', isArchived: true }];
    assert.equal(studentActions.filterStudents(students, '123')[0].name, 'Ána Smith');
    assert.equal(studentActions.filterStudents(students, 'ÁNA')[0].studentId, '123');
    assert.equal(studentActions.filterStudents(students, '0')[0].studentId, '0');
    assert.equal(studentActions.filterStudents(students, '', '', true).length, 2);
    assert.equal(studentActions.escapeHtml(`O'Neil <img "x"> &`), 'O&#39;Neil &lt;img &quot;x&quot;&gt; &amp;');
});

test('raw grading combines mobile and portal, preserves zero and missing', () => {
    const { rows } = records.buildClassRecord(fixture());
    assert.deepEqual(rows[0].percentages, [80, 75, 75]);
    assert.equal(rows[0].rating, 76.25);
    assert.equal(rows[0].remark, 'PASSED');
    assert.deepEqual(rows[1].percentages, [75, null, 75]);
    assert.equal(rows[1].rating, null);
    assert.equal(rows[1].remark, 'INCOMPLETE');
    assert.deepEqual(rows[2].percentages, [0, 0, 0]);
    assert.equal(rows[2].remark, 'FAILED');
    assert.equal(rows[2].isArchived, true);
});

test('all subjects >=50 and rating >=70, invalid scores and empty values', () => {
    const data = fixture(1);
    data.scanResults = [];
    data.portalResults.forEach((result, index) => result.scoreA = [49, 100, 100][index]);
    assert.equal(records.buildClassRecord(data).rows[0].remark, 'FAILED');
    data.portalResults.forEach((result, index) => result.scoreA = [50, 50, 100][index]);
    assert.equal(records.buildClassRecord(data).rows[0].remark, 'PASSED');
    for (const value of [null, '', ' ', undefined, NaN, Infinity, -1, 101, true]) assert.equal(records.percentage(value), null);
    assert.equal(records.percentage('0'), 0);
    assert.deepEqual(records.portalPercentages({ scoreA: 40, scoreB: 0, scoreType: 'raw', total: 50 }), [80, 0]);
    assert.deepEqual(records.portalPercentages({ scoreA: 40, scoreB: 0 }), [40, 0]);
    assert.deepEqual(records.portalPercentages({ scoreA: 40, scoreType: 'raw', total: 0 }), [null, null]);
});

test('attempt policy is deterministic across source order, duplicates and timestamps', () => {
    const data = fixture(1);
    data.scanResults.push({ ...data.scanResults[0], _id: 'scan-newer', scannedAt: 3000 });
    let report = records.buildClassRecord(data);
    assert.equal(report.rows[0].subjects[0].id, 'scan-newer');
    data.scanResults.reverse(); data.portalResults.reverse();
    assert.deepEqual(records.buildClassRecord(data), report);
    data.scanResults.push({ ...data.scanResults[0], _id: 'scan-invalid', score: 101, total: 100 });
    assert.equal(records.buildClassRecord(data).rows[0].subjects[0].id, 'scan-newer');
});

test('owner and cluster isolation, numeric and document exam keys, trashed scans', () => {
    const data = fixture(1);
    data.scanResults.push({ ...data.scanResults[0], _id: 'other-owner', uploadedByUid: 'teacher-2', score: 50 });
    data.scanResults.push({ ...data.scanResults[0], _id: 'other-cluster', clusterId: 44, score: 50 });
    data.scanResults.push({ ...data.scanResults[0], _id: 'trashed', deletedAt: 123, score: 50 });
    assert.equal(records.buildClassRecord(data).rows[0].percentages[0], 80);
    const scoped = records.buildClassRecord({ ...data, clusterId: 44 });
    assert.deepEqual(scoped.rows[0].percentages, [100, null, null]);
    assert.equal(records.matchesExam({ examId: '100', uploadedByUid: user.uid }, selections[0], selections, user), true);
    const webExams = selections.map(exam => ({ ...exam, createdByEmail: user.email }));
    assert.equal(records.matchesExam({ examId: 'exam-0', teacherEmail: user.email }, webExams[0], webExams, user), true);
    assert.equal(records.matchesExam({ examId: 100 }, selections[0], selections, user), false);
    const collision = { ...selections[0], _id: 'other-exam', uploadedByUid: 'teacher-2' };
    assert.equal(records.matchesExam(data.scanResults[0], selections[0], [...selections, collision], user), true);
    assert.throws(() => records.buildClassRecord({ ...data, selections: [{ ...selections[0], uploadedByUid: 'teacher-2' }, ...selections.slice(1)] }), /access/);
    assert.equal(records.canReadExam({ uploadedByUid: 'teacher-2', createdByEmail: user.email, uploadedByTeacherId: user.teacherId }, user), false);
    assert.equal(records.matchesExam({ examId: 'exam-0', uploadedByUid: 'teacher-2', teacherEmail: user.email },
        { ...selections[0], createdByEmail: user.email }, selections, { ...user, role: 'admin' }), false);
});

test('stable IDs keep namesakes separate and ambiguous student IDs exclude scans', () => {
    const data = fixture(2);
    data.students[1].name = data.students[0].name;
    assert.equal(records.buildClassRecord(data).rows.length, 2);
    data.students[1].studentId = data.students[0].studentId;
    const result = records.buildClassRecord(data);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.rows[0].percentages[0], 75);
    assert.equal(result.rows.length, 2);
});

test('actual teacher score writer exports against mobile UID-owned exams and safely bridges legacy rows', async () => {
    const html = await readFile(new URL('../teacher/summary.html', import.meta.url), 'utf8');
    const writer = html.match(/window\.saveScore = async[\s\S]*?(?=\n        window\.clearScore)/)[0];
    const writes = [];
    const data = fixture(1);
    const context = vm.createContext({ window: {}, currentExam: selections[0], user,
        allStudents: data.students, resultsMap: {}, db: {},
        portalPercentages: records.portalPercentages, studentSnapshot: studentActions.studentSnapshot,
        doc: (_, collection, id) => ({ collection, id }), serverTimestamp: () => 1000,
        setDoc: async (ref, payload) => writes.push({ ...payload, _id: ref.id }),
        logActivity: async () => {}, showToast: message => { throw new Error(message); } });
    vm.runInContext(writer, context);
    await context.window.saveScore('student-0', 'A', '80');
    assert.equal(writes[0].uploadedByUid, user.uid);
    assert.equal(records.matchesExam(writes[0], selections[0], selections, user), true);
    const report = records.buildClassRecord({ ...data, portalResults: writes, scanResults: [] });
    assert.deepEqual(report.rows[0].percentages, [80, null, null]);
    const legacy = { ...writes[0] };
    delete legacy.uploadedByUid; delete legacy.uploadedByTeacherId;
    assert.equal(records.matchesExam(legacy, selections[0], selections, user), true);
    assert.equal(records.matchesExam({ ...legacy, examId: 100 }, selections[0], selections, user), false);
    assert.equal(records.matchesExam({ ...legacy, teacherEmail: 'foreign@example.test' }, selections[0], selections, user), false);
    assert.equal(records.matchesExam({ ...legacy, uploadedByUid: 'foreign-uid' }, selections[0], selections, user), false);
    assert.equal(records.matchesExam(legacy, selections[0], selections, { role: 'admin', uid: 'admin', email: 'admin@example.test' }), false);
});

test('actual teacher page searches names/numeric IDs and releases archive pending state', async () => {
    const html = await readFile(new URL('../teacher/students.html', import.meta.url), 'utf8');
    const render = html.match(/function renderTable\(students\)[\s\S]*?(?=\n        \/\/ Search & filter)/)[0];
    const archive = html.match(/window\.archiveStudent = async[\s\S]*?(?=\n        \/\/ ─── Bulk Import)/)[0];
    const elements = Object.fromEntries(['search-input', 'filter-year', 'student-count', 'students-tbody']
        .map(id => [id, { value: '', textContent: '', innerHTML: '' }]));
    const students = [{ _id: 'numeric', name: 'Numeric Student', studentId: 123 }, { _id: 'named', name: 'Name Search', studentId: '0007' }].map(studentActions.normalizeStudent);
    let confirm = false;
    const writes = [], pendingActions = new Set();
    const context = vm.createContext({ window: {}, document: { getElementById: id => elements[id] },
        allStudents: students, pendingActions, user, db: {}, ...studentActions,
        confirmStudentAction: async () => confirm, lucideIcon: () => '', formatDate: () => '',
        doc: (_, collection, id) => ({ collection, id }), serverTimestamp: () => 1000,
        updateDoc: async (ref, payload) => { writes.push(payload); Object.assign(students.find(student => student._id === ref.id), payload); },
        logActivity: async () => {}, showToast: () => {} });
    vm.runInContext(render + '\n' + archive, context);
    elements['search-input'].value = 'Name Search';
    context.renderTable(students);
    assert.equal(elements['student-count'].textContent, '1 student');
    assert.match(elements['students-tbody'].innerHTML, /Name Search/);
    elements['search-input'].value = '123';
    context.renderTable(students);
    assert.match(elements['students-tbody'].innerHTML, /Numeric Student/);
    await context.window.archiveStudent('numeric');
    assert.equal(writes.length, 0);
    assert.equal(pendingActions.size, 0);
    confirm = true;
    await context.window.archiveStudent('numeric');
    assert.equal(writes[0].isArchived, true);
    assert.equal(elements['student-count'].textContent, '0 students');
    assert.equal(pendingActions.size, 0);
});

test('admin resolves selected UID owner profiles so legacy portal grades match teacher exports', async () => {
    const data = fixture(1);
    data.scanResults = [];
    data.portalResults = data.portalResults.map(record => ({ ...record, teacherEmail: user.email }));
    const admin = { role: 'admin', uid: 'admin', email: 'admin@example.test' };
    const reads = [];
    const api = {
        collection: (_, name) => ({ name }), where: (field, operator, value) => ({ field, operator, value }),
        query: (collection, filter) => ({ ...collection, filter }),
        getDocsFromServer: async request => {
            reads.push(request);
            const rows = request.name === 'users' ? [{ _id: user.uid, uid: 'untrusted-field', email: user.email }] :
                request.name === 'students' ? data.students : request.name === 'examResults' && request.filter.field === 'examId'
                    ? data.portalResults.filter(record => request.filter.value.includes(record.examId)) : [];
            return { docs: rows.map(row => ({ id: row._id, data: () => row })) };
        }
    };
    const loaded = await records.loadClassRecordData({ db: {}, api, selections, user: admin });
    assert.deepEqual(reads.filter(read => read.name === 'users'), [{ name: 'users', filter: { field: '__name__', operator: 'in', value: [user.uid] } }]);
    assert.deepEqual(loaded.ownerProfiles, [{ uid: user.uid, email: user.email }]);
    assert.deepEqual(records.buildClassRecord({ ...loaded, selections, user: admin }), records.buildClassRecord(data));
    const legacy = data.portalResults[0], profiles = loaded.ownerProfiles;
    assert.equal(records.matchesExam({ ...legacy, uploadedByUid: 'foreign' }, selections[0], selections, admin, profiles), false);
    assert.equal(records.matchesExam({ ...legacy, teacherEmail: 'foreign@example.test' }, selections[0], selections, admin, profiles), false);
    assert.equal(records.matchesExam({ ...legacy, examId: 100 }, selections[0], selections, admin, profiles), false);
    assert.equal(records.matchesExam(legacy, selections[0], selections, admin, [{ uid: 'foreign', email: user.email }]), false);
    reads.length = 0;
    await records.loadClassRecordData({ db: {}, api, selections, user });
    assert.equal(reads.some(read => read.name === 'users'), false);
});

test('deleted roster rows and late-arriving results resolve immutable snapshots', () => {
    const data = fixture(1);
    data.snapshots = [{ recordType: 'rosterSnapshot', studentDocId: data.students[0]._id,
        studentSnapshot: studentActions.studentSnapshot(data.students[0]) }];
    data.students = [];
    const row = records.buildClassRecord(data).rows[0];
    assert.equal(row.studentId, '000001');
    assert.equal(row.name, `O'Neil <Test> & Student`);
    assert.deepEqual(row.percentages, [80, 75, 75]);
    assert.equal(row.rosterDeleted, true);
});

function deleteApi(count = 1, fail = false) {
    const operations = [], commits = [];
    const results = Array.from({ length: count }, (_, index) => ({ ref: `result-${index}`, data: () => ({ scoreA: 91 }) }));
    const api = {
        collection: (_, name) => name, doc: (_, collection, id) => `${collection}/${id}`,
        query: (...parts) => parts, where: (...parts) => parts,
        getDocFromServer: async () => ({ exists: () => true, data: () => ({ name: 'Built-in', studentId: '00001', isDefault: true }) }),
        getDocsFromServer: async () => ({ docs: results }), serverTimestamp: () => 'server-time',
        writeBatch: () => ({ update: (...args) => operations.push(['update', ...args]),
            set: (...args) => operations.push(['set', ...args]), delete: (...args) => operations.push(['delete', ...args]),
            commit: async () => { if (fail) throw new Error('commit failed'); commits.push([...operations]); } })
    };
    return { api, operations, commits };
}
test('built-in delete atomically snapshots identities, updates metadata only, deletes roster last', async () => {
    const mock = deleteApi();
    await studentActions.deleteStudentPreservingResults({ db: {}, api: mock.api, student: { _id: 'student-1' } });
    assert.equal(mock.commits.length, 1);
    assert.deepEqual(Object.keys(mock.operations[0][2]), ['studentSnapshot']);
    assert.equal(mock.operations[0][2].studentSnapshot.studentId, '00001');
    assert.equal(mock.operations[1][2].recordType, 'rosterSnapshot');
    assert.deepEqual(mock.operations[2], ['delete', 'students/student-1']);
});
test('delete fails safely above batch limit or on read/commit failure', async () => {
    const tooMany = deleteApi(499);
    await assert.rejects(studentActions.deleteStudentPreservingResults({ db: {}, api: tooMany.api, student: { _id: 's' } }), /too many/);
    assert.equal(tooMany.operations.length, 0);
    const max = deleteApi(498);
    await studentActions.deleteStudentPreservingResults({ db: {}, api: max.api, student: { _id: 's' } });
    assert.equal(max.operations.length, 500);
    const failed = deleteApi(1, true);
    await assert.rejects(studentActions.deleteStudentPreservingResults({ db: {}, api: failed.api, student: { _id: 's' } }), /commit failed/);
    assert.equal(failed.commits.length, 0);
    failed.api.getDocsFromServer = async () => { throw new Error('offline'); };
    await assert.rejects(studentActions.deleteStudentPreservingResults({ db: {}, api: failed.api, student: { _id: 's' } }), /offline/);
});

test('XLSX retains template styles/widths/headers, dynamic rows and raw formulas with correct caches', async () => {
    const template = await readFile(new URL('../assets/templates/preboard-record.xlsx', import.meta.url));
    const rows = records.buildClassRecord(fixture(125)).rows;
    const bytes = await records.createClassWorkbook({ template, rows, selections, JSZip });
    const original = await JSZip.loadAsync(template), zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const styleXml = await zip.file('xl/styles.xml').async('string');
    const originalStyles = await original.file('xl/styles.xml').async('string');
    assert.equal(styleXml.replace(/<cellXfs[\s\S]*?<\/cellXfs>/, ''), originalStyles.replace(/<cellXfs[\s\S]*?<\/cellXfs>/, ''));
    assert.equal((styleXml.match(/numFmtId="49"/g) || []).length, 2);
    const formatSection = styleXml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
    assert.equal(Number(formatSection[1]), (formatSection[2].match(/<xf\b/g) || []).length);
    assert.equal(await zip.file('xl/theme/theme1.xml').async('string'), await original.file('xl/theme/theme1.xml').async('string'));
    for (const path of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
        const xml = await zip.file(path).async('string'), old = await original.file(path).async('string');
        assert.equal(xml.match(/<cols>[\s\S]*?<\/cols>/)[0], old.match(/<cols>[\s\S]*?<\/cols>/)[0]);
        assert.doesNotMatch(xml, /40\+\(|#REF!|t="shared"|undefined/);
    }
    const roster = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(roster, /ref="A1:G130"/);
    assert.match(roster, /<c r="C6"[^>]* t="inlineStr">[\s\S]*?000001/);
    const originalRoster = await original.file('xl/worksheets/sheet1.xml').async('string');
    assert.equal(roster.match(/<c r="G3"[^>]*>[\s\S]*?<\/c>/)[0], originalRoster.match(/<c r="G3"[^>]*>[\s\S]*?<\/c>/)[0]);
    assert.match(roster, /<c r="G4"[^>]* t="inlineStr"><is><t xml:space="preserve"><\/t><\/is><\/c>/);
    const xml = await zip.file('xl/worksheets/sheet2.xml').async('string');
    assert.match(xml, /ref="A1:K127"/);
    assert.match(xml, /<c r="J3"[^>]*><f>[^<]*0\.25\*E3\+0\.30\*G3\+0\.45\*I3\)<\/f><v>76.25<\/v>/);
    assert.match(xml, /<c r="F4"[^>]*\/>/);
    assert.match(xml, /<c r="D5"[^>]*><v>0<\/v>/);
    assert.match(xml, /IF\(COUNT\(D5\)=0,&quot;&quot;,D5\)/);
    assert.match(xml, /'Name of Students'|&apos;Name of Students&apos;/);
    assert.match(xml, /B130/);
    assert.equal(zip.file('xl/calcChain.xml'), null);
    assert.doesNotMatch(await zip.file('xl/_rels/workbook.xml.rels').async('string'), /calcChain/);
    assert.doesNotMatch(await zip.file('xl/workbook.xml').async('string'), /absPath|USB Drive|Finalized Files/);
    assert.match(xml, /<c r="C3"[^>]*t="str"><f>[^<]*<\/f><v>000001<\/v>/);
});

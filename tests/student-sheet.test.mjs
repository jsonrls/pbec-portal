import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const urlModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const studentActions = urlModule(await read('../js/student-actions.js'));
const classRecord = urlModule((await read('../js/class-record.js'))
    .replace('"./student-actions.js"', JSON.stringify(studentActions))
    .replace('"./exam-data.js"', JSON.stringify(urlModule(await read('../js/exam-data.js')))));
const sheet = await import(urlModule((await read('../js/student-sheet.js'))
    .replace('"./student-actions.js"', JSON.stringify(studentActions))
    .replace('"./class-record.js"', JSON.stringify(classRecord))));

test('sections split by gender in entry order, hide archived, and only show ungendered when present', () => {
    const students = [
        { _id: 'b', name: 'Zed', studentId: '2', gender: 'male', createdAt: { seconds: 1 } },
        { _id: 'a', name: 'Amy', studentId: '1', gender: 'FEMALE', createdAt: { seconds: 2 } },
        { _id: 'c', name: 'Abe', studentId: '3', gender: 'MALE', createdAt: { seconds: 1 } },
        { _id: 'd', name: 'Old', studentId: '4', gender: 'MALE', isArchived: true },
        { _id: 'e', name: 'Pending', studentId: '5', gender: 'MALE', createdAt: null }
    ];
    const sections = sheet.sheetSections(students, { hideArchived: true });
    assert.deepEqual(sections.map(section => section.gender), ['MALE', 'FEMALE']);
    assert.deepEqual(sections[0].students.map(student => student._id), ['c', 'b', 'e']);
    assert.equal(sheet.sheetSections(students).find(section => section.gender === 'MALE').students.length, 4);
    const withBlank = sheet.sheetSections([...students, { _id: 'x', name: 'No gender', studentId: '9' }]);
    assert.deepEqual(withBlank.map(section => section.gender), ['MALE', 'FEMALE', '']);
    assert.equal(sheet.slotCount(3), 50);
    assert.equal(sheet.slotCount(50), 51);
});

test('clipboard grids from Excel keep empty cells and drop the trailing newline', () => {
    assert.deepEqual(sheet.parseClipboardGrid('A\tS1\r\nB\t\tX\r\n'), [['A', 'S1'], ['B', '', 'X']]);
    assert.deepEqual(sheet.parseClipboardGrid('single'), [['single']]);
    assert.equal(sheet.isGridPaste('single'), false);
    assert.equal(sheet.isGridPaste('a\tb'), true);
    assert.equal(sheet.isGridPaste('a\nb'), true);
});

test('row validation requires name and ID and rejects another student with the same ID', () => {
    const students = [{ _id: 'one', name: 'One', studentId: 'S1' }, { _id: 'gone', name: 'Gone', studentId: 'S2', isArchived: true }];
    assert.match(sheet.rowProblem({ name: '', studentId: 'S9' }, students), /name/i);
    assert.match(sheet.rowProblem({ name: 'New', studentId: ' ' }, students), /Student ID/);
    assert.match(sheet.rowProblem({ name: 'New', studentId: 's1' }, students), /S1.*One/);
    assert.match(sheet.rowProblem({ name: 'New', studentId: 'S2' }, students), /archived/);
    assert.equal(sheet.rowProblem({ name: 'One', studentId: 'S1' }, students, 'one'), null);
    assert.equal(sheet.rowProblem({ name: 'New', studentId: 'S3' }, students), null);
});

test('new rows get the same fields the importer and mobile roster read', () => {
    const data = sheet.newStudentRecord({ name: ' Ana ', studentId: ' S7 ', block: 'A', email: '' }, 'FEMALE', 'uid-1',
        { instructor: ' JHON REY ', schoolYear: '2026-2027' });
    assert.deepEqual(data, { name: 'Ana', studentId: 'S7', block: 'A', section: 'A', email: '', gender: 'FEMALE',
        program: 'Bachelor of Science in Electrical Engineering', yearLevel: '4th Year', uploadedByUid: 'uid-1',
        instructor: 'JHON REY', schoolYear: '2026-2027' });
    assert.deepEqual(sheet.rosterUpdate({ block: 'B', email: ' e@x ' }), { block: 'B', section: 'B', email: 'e@x' });
});

test('score override input accepts 0-100, blank clears, anything else is rejected', () => {
    assert.equal(sheet.parseOverride(''), null);
    assert.equal(sheet.parseOverride(' 0 '), 0);
    assert.equal(sheet.parseOverride('87.5'), 87.5);
    for (const bad of ['-1', '101', 'abc', '5%']) assert.equal(sheet.parseOverride(bad), undefined);
});

test('results sheet mirrors roster sections and lists result-only students separately', () => {
    const roster = [{ _id: 'm', name: 'M', studentId: '1', gender: 'MALE' }, { _id: 'f', name: 'F', studentId: '2', gender: 'FEMALE' }];
    const report = { rows: [{ _id: 'm', percentages: [80, 75, 75] }, { _id: 'deleted', name: 'Gone', studentId: '9', percentages: [50, 50, 50] }] };
    const layout = sheet.resultsLayout(sheet.sheetSections(roster), report);
    assert.deepEqual(layout.map(section => section.gender), ['MALE', 'FEMALE', 'OTHER']);
    assert.deepEqual(layout[0].rows[0].result.percentages, [80, 75, 75]);
    assert.equal(layout[1].rows[0].result, null);
    assert.equal(layout[2].rows[0].student.name, 'Gone');
    assert.equal(layout[2].rows[0].editable, false);
});

test('roster header values come from the students, falling back to the signed-in teacher', () => {
    const students = [{ instructor: 'A', schoolYear: '2026-2027' }, { instructor: 'B', schoolYear: '2026-2027' }, { instructor: 'B' }];
    assert.deepEqual(sheet.rosterMeta(students, { name: 'Teacher' }), { instructor: 'B', schoolYear: '2026-2027' });
    assert.deepEqual(sheet.rosterMeta([], { name: 'Teacher', role: 'teacher' }), { instructor: 'Teacher', schoolYear: '' });
    assert.deepEqual(sheet.rosterMeta([], { name: 'Admin', role: 'admin' }), { instructor: '', schoolYear: '' });
});

test('stored results capture each subject, transmuted grade, rating and remark for a cluster', () => {
    const row = { percentages: [80, null, 75], transmuted: [88, null, 85], rating: null, remark: 'INCOMPLETE',
        subjects: [{ source: 'scan' }, null, { source: 'override' }] };
    const stored = sheet.storedResult(row, { id: 7, name: 'Exam 1', schoolYear: '2026-2027' });
    assert.deepEqual(stored, { clusterId: 7, clusterName: 'Exam 1', schoolYear: '2026-2027',
        scores: { Mathematics: 80, ESAS: null, 'Professional EE': 75 },
        transmuted: { Mathematics: 88, ESAS: null, 'Professional EE': 85 },
        rating: null, remark: 'INCOMPLETE', overridden: ['Professional EE'] });
    assert.equal(sheet.sameStoredResult({ ...stored, updatedAt: { seconds: 5 } }, structuredClone(stored)), true);
    assert.equal(sheet.sameStoredResult({ ...stored, rating: 70 }, stored), false);
    assert.equal(sheet.sameStoredResult(undefined, stored), false);
});


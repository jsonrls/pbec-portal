import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/roster-import.js', import.meta.url), 'utf8');
const { parseRoster, importRoster } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Same layout as assets/templates/preboard-record.xlsx: merged title, header found by "Student ID",
// unlabeled Name column, MALE/FEMALE sections, and a RESULTS sheet of formula copies.
const template = [
    { name: 'Name of Students', rows: [
        ['PREBOARD EXAMINATION RECORDS ', '', '', '', '', '', ''],
        [],
        ['', '', '', '', '', 'INSTRUCTOR', 'SCHOOL YEAR'],
        ['NAME OF STUDENTS', '', '', '', '', 'Engr. Cruz', '2026-2027'],
        ['MALE', '', 'Student ID', 'Block', 'Email Address'],
        ['1', 'Santos, Mark A.', 'S000001', 'B', 'mark@example.test'],
        ['2', 'Lim, Paolo B.', '', 'B', ''],
        ['3', '', '', '', ''],
        ['FEMALE', '', 'Student ID', 'Block', 'Email Address'],
        ['1', 'Reyes, Ana C.', 'S000002', 'B', ''],
        ['2', 'Duplicate, Ana', 'S000002', 'B', '']
    ] },
    { name: 'RESULTS', rows: [
        [],
        ['', 'Name of Students', 'Student ID', 'MATHEMATICS'],
        ['1', 'Santos, Mark A.', 'S000001'],
        ['2', '0', '0']
    ] }
];

test('reads the PreBoard record template with gender sections', () => {
    const { students, skipped } = parseRoster(template);
    assert.deepEqual(students.map(s => [s.name, s.studentId, s.gender, s.section]), [
        ['Santos, Mark A.', 'S000001', 'MALE', 'B'],
        ['Reyes, Ana C.', 'S000002', 'FEMALE', 'B']
    ]);
    assert.equal(students[0].email, 'mark@example.test');
    assert.equal(students[0].yearLevel, '4th Year');
    assert.equal(students[0].program, 'Bachelor of Science in Electrical Engineering');
    assert.deepEqual([students[0].instructor, students[0].schoolYear], ['Engr. Cruz', '2026-2027']);
    assert.deepEqual(skipped.map(s => s.reason), ['no Student ID', 'duplicate Student ID S000002']);
    assert.equal(skipped[0].where, 'Name of Students row 7');
});

test('still reads the flat Name, Student ID, Program, Year, Section layout', () => {
    const { students, skipped } = parseRoster([{ name: 'Sheet1', rows: [
        ['Name', 'Student ID', 'Program', 'Year', 'Section'],
        ['Alice Reyes', '2024-1000', 'BSEE', '3rd Year', 'EE-3A']
    ] }]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(students[0], {
        name: 'Alice Reyes', studentId: '2024-1000', block: 'EE-3A', section: 'EE-3A', email: '',
        program: 'BSEE', yearLevel: '3rd Year', gender: '', schoolYear: '', instructor: ''
    });
});

test('import upserts by Student ID within the user\'s own or ownerless students', async () => {
    const existing = [
        { id: 'mine', studentId: 'S000001', uploadedByUid: 'teacher-1' },
        { id: 'other', studentId: 'S000002', uploadedByUid: 'teacher-2' }
    ];
    const writes = [];
    let commits = 0;
    let nextId = 0;
    const api = {
        collection: (_db, name) => name,
        doc: () => ({ id: `new-${nextId++}` }),
        getDocs: async () => ({ docs: existing.map(d => ({ ref: { id: d.id }, data: () => d })) }),
        writeBatch: () => ({ set: (ref, data, options) => writes.push({ id: ref.id, data, options }), commit: async () => { commits++; } }),
        serverTimestamp: () => 'now',
        deleteField: () => 'delete'
    };
    const { students } = parseRoster(template);
    const result = await importRoster({ db: {}, api, students, uid: 'teacher-1', now: 0 });
    assert.deepEqual(result, { created: 1, updated: 1 });
    assert.deepEqual(writes.map(w => w.id), ['mine', 'new-0']);
    assert.equal(writes[0].data.createdAt, undefined);
    assert.equal(writes[1].data.createdAt, 'now');
    assert.equal(writes[1].data.uploadedByUid, 'teacher-1');
    assert.equal(writes[1].data.gender, 'FEMALE');
    assert.equal(writes[0].data.deletedAt, 'delete');
    assert.deepEqual(writes[0].options, { merge: true });
    assert.equal(commits, 1);
});

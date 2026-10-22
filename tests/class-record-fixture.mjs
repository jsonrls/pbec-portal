import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const JSZip = require('../assets/vendor/jszip-3.10.1.min.js');
const urlModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const studentSource = await readFile(new URL('../js/student-actions.js', import.meta.url), 'utf8');
export const studentActions = await import(urlModule(studentSource));
const source = (await readFile(new URL('../js/class-record.js', import.meta.url), 'utf8'))
    .replace('"./student-actions.js"', JSON.stringify(urlModule(studentSource)))
    .replace('"./exam-data.js"', JSON.stringify(urlModule(await readFile(new URL('../js/exam-data.js', import.meta.url), 'utf8'))));
export const records = await import(urlModule(source));
export const user = { role: 'teacher', uid: 'teacher-1', email: 'teacher@example.test', teacherId: 'T001', name: 'Fixture teacher' };
export const selections = records.RECORD_SUBJECTS.map((subject, index) => ({
    _id: `exam-${index}`, id: 100 + index, subject, examName: `${subject} selected round`, uploadedByUid: user.uid
}));
export function fixture(count = 3) {
    const students = Array.from({ length: count }, (_, index) => ({ _id: `student-${index}`,
        name: index === 0 ? `O'Neil <Test> & Student` : `Student ${String(index).padStart(3, '0')}`,
        studentId: String(index + 1).padStart(6, '0'), section: 'EE-4A', email: 'fixture@example.test', isArchived: index === 2 }));
    const portalResults = students.flatMap((student, index) => selections.map((exam, subject) => ({
        _id: `${exam._id}_${student._id}`, examId: exam._id, studentDocId: student._id,
        scoreA: index === 1 && subject === 1 ? null : index === 2 ? 0 : 75,
        scoreB: null, updatedAt: 1000
    })));
    const scanResults = [{ _id: 'scan-best', studentId: '000001', studentName: 'Test student',
        examId: 100, subject: 'Mathematics', score: 40, total: 50, uploadedByUid: user.uid, scannedAt: 2000 }];
    return { students, portalResults, scanResults, selections, exams: selections, user };
}

export async function writeSample(directory = '/private/tmp/pbec-record-artifacts') {
    const report = records.buildClassRecord(fixture(125));
    const bytes = await records.createClassWorkbook({
        template: await readFile(new URL('../assets/templates/preboard-record.xlsx', import.meta.url)),
        rows: report.rows, selections, JSZip, clusterName: 'Fixture unclustered', instructor: user.name
    });
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/sample-class-record.xlsx`, bytes);
    await writeFile(`${directory}/expected-records.json`, JSON.stringify(report, null, 2));
    return `${directory}/sample-class-record.xlsx`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await writeSample(process.argv[2]));

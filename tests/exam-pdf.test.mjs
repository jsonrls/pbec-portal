import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, decodePDFRawStream } from '../assets/vendor/pdf-lib-1.17.1/pdf-lib.esm.min.js';
import { createExamPdf, prepareExamQuestions, splitExamText, normalizeEquation, optionColumns, subjectHeader, INSTRUCTIONS, CLOSING_NOTICE } from '../js/exam-pdf.js';

const questions = Array.from({ length: 45 }, (_, i) => ({ _id: `doc-${i}`, _bankId: 'bank', id: i + 1, subject: 'Mathematics',
    questionText: `Q${String(i + 1).padStart(3, '0')} Select the correct value.`, optionA: 'First', optionB: 'Second', optionC: 'Third', optionD: 'Fourth', correctAnswer: 'B' }));
const exam = { examName: 'Title must stay off paper', subject: 'Mathematics', createdAt: 123456, selectedQuestionBankIds: ['bank'],
    setAQuestionIds: questions.map(q => q.id), setBQuestionIds: questions.map(q => q.id).reverse() };

async function inspect(bytes) {
    const pdf = await PDFDocument.load(bytes);
    let operations = '';
    for (const page of pdf.getPages()) {
        const contents = page.node.Contents();
        for (let i = 0; i < contents.size(); i++) {
            operations += Buffer.from(decodePDFRawStream(pdf.context.lookup(contents.get(i))).decode()).toString();
        }
    }
    const text = [...operations.matchAll(/<([A-F\d]+)> Tj/gi)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join('');
    return { pdf, operations, text };
}

test('A/B export includes every question in selected order across PDF pages', async () => {
    for (const set of ['A', 'B']) {
        const bytes = await createExamPdf({ exam, questions, set });
        if (process.env.PBEC_PDF_ARTIFACTS) {
            fs.mkdirSync(process.env.PBEC_PDF_ARTIFACTS, { recursive: true });
            fs.writeFileSync(`${process.env.PBEC_PDF_ARTIFACTS}/plain-set-${set}.pdf`, bytes);
        }
        const result = await inspect(bytes);
        assert.ok(result.pdf.getPageCount() > 1);
        for (const page of result.pdf.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 936 });
        const markers = [...result.text.matchAll(/Q\d{3}/g)].map(match => match[0]);
        assert.deepEqual(markers, (set === 'A' ? questions : [...questions].reverse()).map(q => q.questionText.slice(0, 4)));
        assert.ok(result.text.replace(/\s/g, '').includes(INSTRUCTIONS.replace(/\s/g, '')));
        assert.ok(result.text.replace(/\s/g, '').includes(CLOSING_NOTICE.replace(/\s/g, '')));
        assert.ok(result.text.includes('Multiple Choice'));
        assert.ok(result.text.includes('*** END ***'));
        assert.equal(/localhost|Title must stay off paper|123456|correctAnswer/.test(result.text), false);
        assert.match(result.operations, /14 Tf/);
        assert.match(result.operations, /10 Tf/);
        assert.equal(/0 [1-9].* rg/.test(result.operations), false);
    }
});

test('answer reveal and answer keys never change student-facing PDF content', async () => {
    const small = { ...exam, setAQuestionIds: [1] };
    const one = await inspect(await createExamPdf({ exam: small, questions, showAnswers: true }));
    const two = await inspect(await createExamPdf({ exam: small, questions: questions.map(q => ({ ...q, correctAnswer: 'D', showAnswers: false })) }));
    assert.equal(one.operations, two.operations);
    assert.deepEqual(Object.keys(prepareExamQuestions(small, questions)[0]), ['text', 'options']);
});

test('missing, ambiguous, wrong-bank, blank and empty questions block export', async () => {
    for (const pool of [questions.slice(1), [...questions, { ...questions[0], _id: 'duplicate' }], questions.map(q => ({ ...q, _bankId: 'other' })), questions.map(q => ({ ...q, questionText: '' })), questions.map(q => ({ ...q, optionC: '' }))]) {
        await assert.rejects(createExamPdf({ exam, questions: pool }));
    }
    await assert.rejects(createExamPdf({ exam: { ...exam, setAQuestionIds: [] }, questions }), /no questions/);
    await assert.rejects(createExamPdf({ exam: { ...exam, setAQuestionIds: [1] }, questions: [{ ...questions[0], questionText: 'Malformed \\(x^2' }] }), /unclosed/);
});

test('legacy doc references and numeric IDs preserve order', () => {
    assert.deepEqual(prepareExamQuestions({ ...exam, setAQuestionIds: ['doc-1', '1'] }, questions).map(q => q.text.slice(0, 4)), ['Q002', 'Q001']);
});

test('equation segmentation preserves roots, fractions, scripts and currency prose', () => {
    const parts = splitExamText('Find \\frac{x + 1}{2} and \\(\\sqrt{9}+x^2\\), sqrt(16), x² and $200 total.');
    assert.deepEqual(parts.filter(p => p.math).map(p => p.source), ['\\frac{x + 1}{2}', '\\sqrt{9}+x^2', 'sqrt(16)', 'x²']);
    assert.match(parts.at(-1).source, /\$200 total\./);
    assert.equal(normalizeEquation('x¹⁰ + √9 + sqrt(16)'), 'x^{10} + \\sqrt{9} + \\sqrt{16}');
    assert.deepEqual([optionColumns([20, 25], 500), optionColumns([180, 120], 500), optionColumns([300, 10], 500)], [4, 2, 1]);
    assert.equal(subjectHeader('ESAS'), 'ENGINEERING SCIENCES AND ALLIED SUBJECTS');
    assert.equal(subjectHeader('Professional EE'), 'PROFESSIONAL ELECTRICAL ENGINEERING SUBJECTS');
});

test('both views use shared export, selected-set order and permission-scoped questions', () => {
    for (const role of ['admin', 'teacher']) {
        const html = fs.readFileSync(new URL(`../${role}/view-exam.html`, import.meta.url), 'utf8');
        assert.match(html, /bindExamPdfControls/);
        assert.match(html, /_bankId:/);
        assert.match(html, /const q = orderedQuestions\[index\]/);
        assert.equal(html.includes('window.print()'), false);
    }
});

test('nested root groups and numeric dollar math stay intact; money stays prose', () => {
    const source = 'sqrt((x+1)^2 + sqrt(4))';
    assert.deepEqual(splitExamText(source), [{ source, math: true }]);
    assert.equal(normalizeEquation(source), '\\sqrt{(x+1)^2 + \\sqrt{4}}');
    assert.equal(normalizeEquation('√((x+1)^2)'), '\\sqrt{(x+1)^2}');
    assert.deepEqual(splitExamText('$2 + x$').filter(p => p.math), [{ source: '2 + x', math: true }]);
    assert.deepEqual(splitExamText('$5 and $10 total.'), [{ source: '$5 and $10 total.', math: false }]);
    assert.deepEqual(splitExamText('Cost \\$5.'), [{ source: 'Cost $5.', math: false }]);
    assert.deepEqual(splitExamText('$\\text{Cost \\$5}+x$').filter(p => p.math), [{ source: '\\text{Cost \\$5}+x', math: true }]);
    assert.deepEqual(splitExamText('\\frac{\\{x\\}}{2}').filter(p => p.math), [{ source: '\\frac{\\{x\\}}{2}', math: true }]);
    assert.throws(() => splitExamText('sqrt((x+1)'), /unclosed/);
});

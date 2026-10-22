const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'js/exam-data.js'), 'utf8').replace(/export /g, '');
const context = vm.createContext({ console, Date, Uint32Array, crypto: require('node:crypto').webcrypto });
vm.runInContext(helper, context);
const plain = value => JSON.parse(JSON.stringify(value));
const pool = [
    { _id: 'doc-a', _bankId: 'bank', id: 41, subject: 'Mathematics', questionText: 'A' },
    { _id: 'doc-b', _bankId: 'bank', id: 72, subject: 'Mathematics', questionText: 'B' }
];
test('legacy doc refs and numeric sets preserve exact A/B order and repeated entries', () => {
    for (const sets of [ { setAQuestionIds: ['doc-b', 'doc-a', 'doc-b'], setBQuestionIds: ['doc-a', 'doc-b'] },
        { setAQuestionIds: [72, 41, 72], setBQuestionIds: [41, 72] } ]) {
        const exam = { subject: 'Mathematics', sessionIds: ['bank'], ...sets };
        assert.deepEqual(plain(context.resolveExamQuestions(exam, pool).map(q => q.id)), [72, 41, 72]);
        assert.deepEqual(plain(context.resolveExamQuestions(exam, pool, 'B').map(q => q.id)), [41, 72]);
    }
    assert.deepEqual(plain(context.examQuestionIds({ questionIds: [41] })), [41]);
    assert.deepEqual(plain(context.examQuestionIds({ questionIds: [41] }, 'B')), []);
});
test('resolution refuses missing, ambiguous, malformed and wrong-bank questions', () => {
    const exam = { subject: 'Mathematics', selectedQuestionBankIds: ['bank'], setAQuestionIds: ['doc-a'] };
    assert.throws(() => context.resolveExamQuestions(exam, []), /missing/);
    assert.throws(() => context.resolveExamQuestions(exam, [...pool, pool[0]]), /ambiguous/);
    assert.throws(() => context.resolveExamQuestions(exam, [{ ...pool[0], _bankId: 'other' }]), /missing/);
    assert.throws(() => context.resolveExamQuestions(exam, [{ ...pool[0], questionText: '' }]), /text is missing/);
    assert.throws(() => context.examQuestionIds({ setAQuestionIds: [null] }), /invalid/);
    assert.throws(() => context.examQuestionIds({ setAQuestionIds: 'doc-a' }), /array/);
});
test('UID ownership overrides matching email and orphan records remain private', () => {
    const user = { uid: 'me', email: 'me@example.test' };
    assert.equal(context.isExamOwner({ uploadedByUid: 'other', createdByEmail: user.email }, user), false);
    assert.equal(context.isExamOwner({ uploadedByUid: 'me' }, user), true);
    assert.equal(context.isExamOwner({ createdBy: user.email }, user), true);
    assert.equal(context.isExamOwner({}, user), false);
});
test('new payload preserves numeric question IDs and writes private owner metadata', () => {
    const payload = context.buildExamPayload({ examName: 'Exam', subject: 'Mathematics',
        setA: pool, setB: [...pool].reverse(), bankIds: ['bank'], user: { uid: 'admin', role: 'admin' }, now: 100, id: 101 });
    assert.deepEqual(plain(payload.setAQuestionIds), [41, 72]);
    assert.deepEqual(plain(payload.setBQuestionIds), [72, 41]);
    assert.equal(payload.id, 101);
    assert.equal(payload.createdAt, 100);
    assert.equal(payload.uploadedByUid, 'admin');
    assert.equal(payload.visibility, 'private');
    assert.throws(() => context.questionId({ id: Number.MAX_SAFE_INTEGER + 1 }), /precision/);
});
test('mobile 63-bit IDs persist exact document strings beside safe numeric IDs in A/B order', () => {
    const docId = '7341234567890123456';
    const roundedId = Number(docId);
    assert.notEqual(BigInt(roundedId).toString(), docId);
    const mobile = { ...pool[0], _id: docId, id: roundedId, questionText: 'Mobile question' };
    const makePayload = question => context.buildExamPayload({ examName: 'Mixed IDs', subject: 'Mathematics',
        setA: [question, pool[1], question], setB: [pool[1], question], bankIds: ['bank'], user: { uid: 'me' }, id: 101 });
    for (const question of [mobile, { ...mobile, _id: undefined, docId }]) {
        const payload = makePayload(question);
        assert.deepEqual(plain(payload.setAQuestionIds), [docId, 72, docId]);
        assert.deepEqual(plain(payload.questionIds), [docId, 72, docId]);
        assert.deepEqual(plain(payload.setBQuestionIds), [72, docId]);
        const questions = [question, pool[1]];
        const resolvedA = context.resolveExamQuestions(payload, questions);
        const resolvedB = context.resolveExamQuestions(payload, questions, 'B');
        assert.deepEqual(Array.from(resolvedA, q => q.questionText), ['Mobile question', 'B', 'Mobile question']);
        assert.deepEqual(Array.from(resolvedB, q => q.questionText), ['B', 'Mobile question']);
    }
    assert.throws(() => makePayload({ ...mobile, _id: undefined }), /original document reference/);
    // A rounded number must not substitute for a missing physical document reference.
    assert.throws(() => context.resolveExamQuestions({ subject: 'Mathematics', selectedQuestionBankIds: ['bank'],
        setAQuestionIds: [String(roundedId)] }, [mobile]), /missing/);
});
test('timestamp normalization accepts Timestamp, epoch and pending values', () => {
    assert.equal(context.timestampMillis({ toMillis: () => 100 }), 100);
    assert.equal(context.timestampMillis({ toDate: () => new Date(200) }), 200);
    assert.equal(context.timestampMillis(300), 300);
    assert.equal(context.timestampMillis(null), 0);
    assert.equal(context.legacyId('Aa'), context.legacyId('BB'));
});

async function portal(role) {
    const elements = new Map(), listeners = new Map(), callbacks = [], notices = [], writes = [];
    const classes = () => ({ add() {}, remove() {}, toggle() {} });
    function element(id) {
        if (!elements.has(id)) {
            const item = { classList: classes(), value: '', dataset: {}, textContent: '',
                addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
                appendChild(child) { if (child.id) elements.set(child.id, child); },
                querySelectorAll() { return []; }, id };
            let html = '';
            Object.defineProperty(item, 'innerHTML', { get: () => html, set(value) {
                html = value;
                if (id === 'exams-container') elements.delete('exams-empty');
            } });
            elements.set(id, item);
        }
        return elements.get(id);
    }
    element('exams-empty');
    const chips = ['all', 'Mathematics', 'ESAS'].map(subject => ({ dataset: { subject }, classList: classes(), addEventListener() {} }));
    let snapshot, listenerError;
    const env = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Date, Uint32Array,
        crypto: require('node:crypto').webcrypto, window: {}, db: {},
        document: { getElementById: id => id === 'exams-empty' ? elements.get(id) || null : element(id),
            querySelectorAll: selector => selector === '.session-cb:checked' ? [{ value: 'bank' }] : selector.includes('chip') ? chips : [] },
        requireAuth: async () => ({ uid: 'me', email: 'me@example.test', name: 'Me', role }),
        renderSidebar: () => '', lucideIcon: () => '', initSidebar() {}, logout() {},
        collection: (...args) => args, query: (...args) => args, where() {}, serverTimestamp() {},
        onSnapshot: (_, success, error) => { snapshot = success; listenerError = error; },
        formatDateTime: () => '', showToast: (...args) => notices.push(args), setButtonLoading() {},
        logActivity: async () => { throw Error('audit unavailable'); },
        getDocs: async () => ({ docs: pool.map(q => ({ id: q._id, data: () => ({ ...q, isDefault: true }) })) }),
        addDoc: async (_, payload) => { writes.push(payload); return { id: 'saved' }; }
    });
    vm.runInContext(helper, env);
    const html = fs.readFileSync(path.join(root, role, 'exams.html'), 'utf8');
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import\s+[\s\S]*?from\s+"[^"]+";/g, '');
    await vm.runInContext(`(async () => {${script}\nglobalThis.setSubject = value => { activeSubject = value; renderExams(); }; })()`, env);
    return { env, elements, element, listeners, notices, writes,
        snapshot: exams => snapshot({ docs: exams.map(e => ({ id: String(e.id), data: () => e })) }), listenerError };
}
for (const role of ['admin', 'teacher']) {
    test(`${role} list survives empty -> one -> two -> empty filter -> back`, async () => {
        const p = await portal(role);
        p.snapshot([]);
        const exam = { id: 1, uploadedByUid: 'me', subject: 'Mathematics', examName: 'One', createdAt: 1 };
        p.snapshot([exam]);
        assert.match(p.element('exams-container').innerHTML, /One/);
        p.snapshot([exam, { ...exam, id: 2, examName: 'Two' }]);
        assert.match(p.element('exams-container').innerHTML, /Two/);
        p.env.setSubject('ESAS');
        assert.ok(p.elements.get('exams-empty'));
        p.env.setSubject('all');
        assert.match(p.element('exams-container').innerHTML, /One/);
        p.listenerError({ code: 'permission-denied' });
        assert.match(p.element('exams-error').textContent, /could not be refreshed/);
    });
    test(`${role} successful generation updates list/filter even when audit fails`, async () => {
        const p = await portal(role);
        p.element('gen-subject').value = 'Mathematics';
        p.element('gen-name').value = 'New Exam';
        p.element('gen-count').value = '25';
        p.element('gen-shuffle').value = 'no';
        // Teacher generation uses the canonical bank ID.
        if (role === 'teacher') p.env.document.querySelectorAll = selector => selector === '.session-cb:checked'
            ? [{ value: 'default_mathematics' }] : [];
        p.env.setSubject('ESAS');
        await p.listeners.get('gen-submit:click')();
        assert.equal(p.writes.length, 1);
        assert.match(p.element('exams-container').innerHTML, /New Exam/);
        assert.equal(p.notices.at(-1)[1], 'success');
    });
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8').replace(/import\s+[\s\S]*?from\s+"[^"]+";/g, '').replace(/export /g, '');
function loginContext(profile = {}, error, uid = 'teacher') {
    const writes = [], sessions = new Map(), calls = [];
    const data = { email: 'teacher@example.test', role: 'teacher', isActive: true, passwordHash: 'stale', ...profile };
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, auth: { currentUser: {} }, db: {},
        collection() {}, query() {}, where() {}, limit() {},
        getDocs: async () => ({ empty: false, docs: [{ id: 'teacher', ref: {}, data: () => data }] }),
        signInWithEmailAndPassword: async (...args) => { calls.push(args); if(error) throw {code: error}; return {user: {uid}}; },
        signOut: async () => calls.push('signOut'), logActivity: async () => {},
        updateDoc: async (_, value) => writes.push(value), serverTimestamp: () => 'timestamp',
        sessionStorage: {setItem: (k,v) => sessions.set(k,v), removeItem: k => sessions.delete(k)}, localStorage: {removeItem() {}} });
    vm.runInContext(source, context);
    return { context, writes, sessions, calls };
}
test('Firebase accepts reset password despite stale or missing legacy hash; preserves password bytes', async () => {
    for (const passwordHash of ['stale', undefined]) {
        const c = loginContext({ passwordHash });
        assert.equal(await c.context.login('TTEST-001', ' password '), 'teacher');
        assert.equal(c.calls[0][2], ' password ');
        assert.equal(c.writes[0].failedLoginAttempts, 0);
        assert.equal('passwordHash' in JSON.parse(c.sessions.get('pbec_session')), false);
    }
});
test('credential failures count and lock fifth attempt', async () => {
    const c = loginContext({failedLoginAttempts: 4}, 'auth/invalid-credential');
    await assert.rejects(c.context.login('TTEST-001', 'wrong'), e => e.code === 'auth/account-locked');
    assert.equal(c.writes[0].failedLoginAttempts, 5);
    assert.ok(c.writes[0].lockedUntil);
    assert.equal(c.sessions.size, 0);
});
test('provider, network and internal errors never count as bad passwords', async () => {
    for (const code of ['auth/operation-not-allowed', 'auth/network-request-failed', 'auth/internal-error']) {
        const c = loginContext({}, code);
        await assert.rejects(c.context.login('TTEST-001', 'password'), e => e.code === code);
        assert.equal(c.writes.length, 0);
    }
});
test('inactive, locked and missing email profiles stop before Firebase sign-in', async () => {
    for(const profile of [{isActive:false}, {status: 'inactive'}, {lockedUntil: new Date(Date.now()+60000)}, {email:''}]) {
        const c = loginContext(profile);
        await assert.rejects(c.context.login('TTEST-001', 'password'));
        assert.equal(c.calls.length, 0);
    }
});
test('UID mismatch signs out and does not persist a session', async () => {
    const c = loginContext({}, null, 'other');
    await assert.rejects(c.context.login('TTEST-001', 'password'), e => e.code === 'auth/profile-mismatch');
    assert.equal(c.calls.at(-1), 'signOut');
    assert.equal(c.sessions.size, 0);
});
const html = fs.readFileSync(path.join(__dirname, '../admin/users.html'), 'utf8');
const resetSource = html.slice(html.indexOf('window.resetPassword ='), html.indexOf('window.clearLoginIssues ='));
test('reset requests email only after confirmation, never writes a profile', async () => {
    for (const scenario of ['success', 'cancel', 'missing', 'error', 'audit-error']) {
        const calls = [], notices = [];
        const c = vm.createContext({window:{}, auth:{}, allUsers:[{_id:'teacher', email:scenario === 'missing' ? '' : 'teacher@example.test'}],
            showConfirm:async () => scenario !== 'cancel', showToast:(...v) => notices.push(v),
            sendPasswordResetEmail:async (_, email) => {calls.push(email); if(scenario === 'error') throw Error('network');},
            logAdminAction:async action => {calls.push(action); if(scenario === 'audit-error') throw Error('audit');},
            updateDoc:async () => assert.fail('Reset must not mutate profile')});
        vm.runInContext(resetSource, c);
        await c.window.resetPassword('teacher');
        if(['cancel','missing'].includes(scenario)) assert.equal(calls.length, 0);
        else assert.equal(calls[0], 'teacher@example.test');
        if(scenario === 'success') assert.equal(calls[1], 'REQUEST_PASSWORD_RESET_EMAIL');
        if(scenario === 'error') assert.equal(notices.at(-1)[1], 'error');
        if(scenario === 'audit-error') assert.equal(notices.at(-1)[1], 'warning');
    }
});

test('missing Teacher ID and instructor ID profiles reject before password verification', async () => {
    const c = loginContext();
    const fields = [];
    c.context.where = field => { fields.push(field); };
    c.context.getDocs = async () => ({ empty: true, docs: [] });
    await assert.rejects(c.context.login('TTEST-001', 'password'), e => e.code === 'auth/user-not-found');
    assert.deepEqual(fields, ['teacherId', 'instructorId']);
    assert.equal(c.calls.length, 0);
    assert.equal(c.writes.length, 0);
    assert.equal(c.sessions.size, 0);
});
test('legacy instructor ID lookup signs in with the matching stable UID', async () => {
    const c = loginContext({ instructorId: 'TTEST-001' });
    const getProfile = c.context.getDocs;
    const fields = [];
    c.context.where = field => { fields.push(field); };
    c.context.getDocs = async () => fields.at(-1) === 'teacherId'
        ? { empty: true, docs: [] } : getProfile();
    assert.equal(await c.context.login(' ttest-001 ', 'password'), 'teacher');
    assert.deepEqual(fields, ['teacherId', 'instructorId']);
    const session = JSON.parse(c.sessions.get('pbec_session'));
    assert.equal(session.teacherId, 'TTEST-001');
    assert.equal(session.uid, 'teacher');
});

// Run: node web/tests/class-record-browser.cjs [artifact-directory]. Uses local mocks only.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PBEC_PLAYWRIGHT || '/Users/jaysonreales/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || '/private/tmp/pbec-record-browser';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
(async () => {
    await fs.mkdir(output, { recursive: true });
    const server = http.createServer(async (request, response) => {
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
        if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
        try { response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(await fs.readFile(file)); }
        catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/tests/class-record-browser.html`;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.PBEC_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.waitForFunction(() => window.fixture?.ready);
        assert.equal(await page.locator('#btn-export').isDisabled(), true);
        assert.equal(await page.locator('#record-exam-0 option[value="other-owner"]').count(), 0);
        await page.locator('#delete-fixture').click();
        await page.locator('dialog').waitFor({ state: 'visible' });
        assert.match(await page.locator('#student-action-description').textContent(), /O'Neil <Test> & Student.*000001/);
        assert.equal(await page.locator('dialog img').count(), 0);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await page.evaluate(() => window.fixture.deleteCount), 0);
        await page.locator('#delete-fixture').click();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('#delete-status').textContent === 'Deletion cancelled.');
        assert.equal(await page.evaluate(() => window.fixture.deleteCount), 0);
        await page.locator('#delete-fixture').click();
        await page.getByRole('button', { name: 'Delete student', exact: true }).click();
        await page.waitForFunction(() => window.fixture.deleteCount === 1);
        assert.equal(await page.evaluate(() => window.fixture.deleteCount), 1);
        for (let i = 0; i < 3; i++) await page.locator(`#record-exam-${i}`).selectOption(`exam-${i}`);
        await page.waitForFunction(() => !document.querySelector('#record-group').disabled);
        assert.equal(await page.locator('#btn-export').isDisabled(), true);
        await page.locator('#record-group').selectOption('unclustered');
        await page.locator('#record-school-year').fill('2026-2027');
        const downloadEvent = page.waitForEvent('download');
        await page.locator('#btn-export').click();
        const download = await downloadEvent;
        await download.saveAs(path.join(output, 'browser-class-record.xlsx'));
        await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('Exported 3 students'));
        await page.screenshot({ path: path.join(output, 'record-desktop.png'), fullPage: true });
        await page.locator('#record-group').selectOption('cluster:7');
        const clusterEvent = page.waitForEvent('download');
        await page.locator('#btn-export').click();
        await (await clusterEvent).saveAs(path.join(output, 'browser-cluster-record.xlsx'));
        await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('Exported 1 students'));
        await page.evaluate(() => { window.fixture.failRecords = true; });
        await page.locator('#btn-export').click();
        await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('Fixture records error'));
        assert.equal(await page.locator('#btn-export').isDisabled(), false);
        await page.evaluate(() => { window.fixture.failRecords = false; window.fixture.empty = true; });
        await page.locator('#btn-export').click();
        await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('No results match'));
        await page.evaluate(() => { window.fixture.empty = false; });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#record-group').selectOption('unclustered');
        assert.equal(await page.locator('#btn-export').isVisible(), true);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false);
        await page.screenshot({ path: path.join(output, 'record-mobile.png'), fullPage: true });
        await page.locator('#delete-fixture').click();
        const dialogStyle = await page.locator('dialog').evaluate(async dialog => {
            await Promise.all(dialog.getAnimations().map(animation => animation.finished));
            const style = getComputedStyle(dialog);
            return { opacity: style.opacity, background: style.backgroundColor };
        });
        assert.equal(dialogStyle.opacity, '1');
        assert.notEqual(dialogStyle.background, 'rgba(0, 0, 0, 0)');
        assert.match(dialogStyle.background, /^rgb\(|^rgba\([^)]*, 1\)$/);
        await fs.writeFile(path.join(output, 'dialog-style.json'), JSON.stringify(dialogStyle, null, 2));
        await page.screenshot({ path: path.join(output, 'delete-mobile.png'), fullPage: true });
        await page.keyboard.press('Escape');
        // Exercise the real teacher page, with Firestore/auth replaced by local mocks.
        const js = body => ({ contentType: 'text/javascript', body });
        await page.route('**/js/auth.js', route => route.fulfill(js(`
            export async function requireAuth() { document.body.classList.add('loaded'); return {role:'teacher',uid:'teacher-1',name:'Teacher',email:'teacher@example.test'}; }
            export function logout() {}`)));
        await page.route('**/js/sidebar.js', route => route.fulfill(js(`export function renderSidebar() { return '<span id="user-email-display"></span><span id="user-avatar"></span><button id="logout-btn">Logout</button>'; }`)));
        await page.route('**/js/firebase-config.js', route => route.fulfill(js('export const db = {};')));
        await page.route('**/js/audit.js', route => route.fulfill(js('export async function logActivity() {}')));
        await page.route('**/firebase-firestore.js', route => route.fulfill(js(`
            const rows = [{_id:'numeric',name:'Numeric Student',studentId:123,yearLevel:'4th Year'}, {_id:'named',name:'Name Search',studentId:'0007'}];
            const listeners=[]; window.teacherFixture={writes:[]};
            const snap=()=>({docs:rows.map(row=>({id:row._id,data:()=>({...row})}))});
            export function collection(_,name){return name;}
            export function doc(_,collection,id){return {collection,id};}
            export function query(...args){return args;}
            export function serverTimestamp(){return 1000;}
            export function onSnapshot(q,cb){listeners.push(cb);queueMicrotask(()=>cb(snap()));return ()=>{};}
            export async function updateDoc(ref,data){Object.assign(rows.find(row=>row._id===ref.id),data);window.teacherFixture.writes.push({ref,data});listeners.forEach(cb=>cb(snap()));}
            export async function getDocs(){return snap();}
            export async function addDoc(){return {id:'added'};}
            export function writeBatch(){return {set(){},async commit(){}};}
        `)));
        await page.route('https://cdn.sheetjs.com/**', route => route.fulfill(js('')));
        await page.goto(url.replace('/tests/class-record-browser.html', '/teacher/students.html'));
        await page.locator('#search-input').fill('Name Search');
        await page.waitForFunction(() => document.querySelector('#student-count').textContent === '1 student');
        assert.match(await page.locator('#students-tbody').textContent(), /Name Search/);
        await page.locator('#search-input').fill('123');
        await page.waitForFunction(() => document.querySelector('#students-tbody').textContent.includes('Numeric Student'));
        assert.equal(await page.locator('#students-tbody tr').count(), 1);
        await page.locator('button[data-action="archive"]').click();
        await page.getByRole('button', {name:'Cancel',exact:true}).click();
        await page.waitForFunction(() => !document.querySelector('button[data-action="archive"]').disabled);
        assert.equal(await page.evaluate(() => window.teacherFixture.writes.length), 0);
        await page.locator('button[data-action="archive"]').click();
        await page.getByRole('button', {name:'Archive student',exact:true}).click();
        await page.waitForFunction(() => window.teacherFixture.writes.length === 1);
        await page.waitForFunction(() => document.querySelector('#student-count').textContent === '0 students');
        assert.equal(await page.evaluate(() => window.teacherFixture.writes[0].data.isArchived), true);
        await page.locator('#search-input').fill('Name Search');
        await page.waitForFunction(() => document.querySelector('#student-count').textContent === '1 student');
        assert.equal(await page.locator('button[data-action="archive"]').isEnabled(), true);
        await page.screenshot({ path: path.join(output, 'teacher-search-archive.png'), fullPage: true });
        assert.deepEqual(errors, []);
        await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ status: 'passed',
            checks: ['UID precedence', 'escaped name/ID', 'Cancel', 'Escape', 'confirm', 'explicit exams and group', 'unclustered export', 'cluster export', 'export error recovery', 'empty group', 'mobile export visible', 'mobile no overflow', 'settled opaque dialog', 'actual teacher page name search', 'actual teacher page numeric ID search', 'archive cancel releases pending state', 'archive confirm with active search'],
            pageErrors: errors }, null, 2));
        console.log(`PASS: browser fixtures; screenshots, workbooks and checks.json in ${output}`);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

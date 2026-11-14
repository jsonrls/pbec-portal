// Run: node web/tests/student-sheet-browser.cjs [artifact-directory]. Uses local mocks only.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PBEC_PLAYWRIGHT || '/Users/jaysonreales/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || '/private/tmp/pbec-student-sheet';
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
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.PBEC_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/student-sheet-browser.html`);
        await page.waitForFunction(() => window.fixture?.ready && document.querySelector('.xl-in'));
        const cell = (pos) => page.locator(`input[data-pos="${pos}"]`);
        const status = () => page.locator('.xl-status').textContent();

        // Template layout: title, both gender blocks with 50 slots, existing rows in entry order.
        assert.equal(await page.locator('.xl-title').textContent(), 'PREBOARD EXAMINATION RECORDS');
        assert.equal(await cell('MALE|0|name').inputValue(), 'REALES, Jayson N.');
        assert.equal(await cell('FEMALE|0|studentId').inputValue(), 'S180048');
        assert.equal(await page.locator('input[data-pos^="MALE|"][data-field="name"]').count(), 50);
        // Inside the app shell the sheet scrolls in its frame; the page, topbar button and row controls stay in view.
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        const importBox = await page.locator('#btn-import-students').boundingBox();
        assert.ok(importBox.x + importBox.width <= 1440);
        const removeBox = await page.locator('button[data-act="remove"]').first().boundingBox();
        assert.ok(removeBox.x + removeBox.width <= 1440);
        assert.equal(await page.locator('.xl-btn .lucide').first().evaluate(icon => getComputedStyle(icon).fill), 'none');
        await page.screenshot({ path: `${output}/roster.png` });

        // Header INSTRUCTOR / SCHOOL YEAR is editable and saved on every roster row.
        assert.equal(await cell('META|0|instructor').inputValue(), 'Fixture teacher');
        await cell('META|0|schoolYear').fill('2026-2027');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => [...window.fixture.db.students.values()].every(s => s.schoolYear === '2026-2027'));
        await cell('META|0|instructor').fill('JHON REY A. EBONES');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => [...window.fixture.db.students.values()].every(s => s.instructor === 'JHON REY A. EBONES'));

        // Edit an existing cell, Enter moves down.
        await cell('MALE|1|block').click();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type('B');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.fixture.db.students.get('m2').block === 'B');
        assert.equal(await page.evaluate(() => window.fixture.db.students.get('m2').section), 'B');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.pos), 'MALE|2|block');

        // Type a new student: incomplete stays a draft, Tab keeps focus moving, complete row saves.
        await cell('MALE|2|name').click();
        await page.keyboard.type('NEW, Student');
        await page.keyboard.press('Tab');
        await page.waitForSelector('tr.xl-draft');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.pos), 'MALE|2|studentId');
        await page.keyboard.type('S190001');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => [...window.fixture.db.students.values()].some(s => s.studentId === 'S190001'));
        await page.waitForFunction(() => !document.querySelector('tr.xl-draft'));
        assert.equal(await page.evaluate(() => document.activeElement.dataset.pos), 'MALE|2|block');
        assert.equal(await cell('MALE|2|name').inputValue(), 'NEW, Student');
        const created = await page.evaluate(() => [...window.fixture.db.students.values()].find(s => s.studentId === 'S190001'));
        assert.equal(created.gender, 'MALE');
        assert.equal(created.uploadedByUid, 'teacher-1');
        assert.equal(created.schoolYear, '2026-2027');
        assert.equal(created.instructor, 'JHON REY A. EBONES');

        // Duplicate ID is refused and the original value restored.
        await cell('MALE|1|studentId').fill('S180047');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.querySelector('.xl-status').classList.contains('xl-error'));
        assert.match(await status(), /already used by REALES/);
        assert.equal(await page.evaluate(() => window.fixture.db.students.get('m2').studentId), 'S180049');

        // Paste two rows from Excel into the female block: one batch write.
        await cell('FEMALE|1|name').click();
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.setData('text/plain', 'PASTE, One\tP001\tC\tone@example.test\r\nPASTE, Two\tP002\tC\t\r\n');
            document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        await page.waitForFunction(() => [...window.fixture.db.students.values()].filter(s => s.studentId?.startsWith('P00')).length === 2);
        assert.equal(await page.evaluate(() => window.fixture.batches >= 2), true);
        assert.equal(await cell('FEMALE|2|name').inputValue(), 'PASTE, Two');

        // RESULTS: cluster scores, transmuted rating, remarks, then a typed override.
        await page.getByRole('tab', { name: 'RESULTS' }).click();
        await page.locator('#xl-cluster').selectOption('7');
        await page.waitForFunction(() => document.querySelector('[data-act="export"]') && !document.querySelector('[data-act="export"]').disabled);
        const maleRow = page.locator('tr', { has: page.locator('td', { hasText: 'REALES, Jayson N.' }) });
        assert.equal(await maleRow.locator('input[data-field="Mathematics"]').inputValue(), '80');
        // Computed RESULTS rows are saved on each student under results.<clusterId>.
        await page.waitForFunction(() => window.fixture.db.students.get('m1').results?.['7']?.rating === 89.8);
        const stored = await page.evaluate(() => window.fixture.db.students.get('m1').results['7']);
        assert.deepEqual(stored.scores, { Mathematics: 80, ESAS: 75, 'Professional EE': 90 });
        assert.equal(stored.remark, 'PASSED');
        assert.equal(stored.clusterName, 'Exam 1');
        const texts = await maleRow.locator('td').allTextContents();
        assert.deepEqual(texts.slice(4, 6), ['88.00', '']);   // transmuted Math; ESAS raw is an input
        assert.match(texts.join('|'), /85\.00\|.*94\.00\|89\.80\|PASSED/);
        const femaleRow = page.locator('tr', { has: page.locator('td', { hasText: 'AGRIPA, Cali Rose A.' }) });
        assert.equal(await femaleRow.locator('td.xl-failed').textContent(), 'FAILED');
        await femaleRow.locator('input[data-field="Mathematics"]').fill('55');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => window.fixture.db.students.get('f1').scoreOverrides?.['7']?.Mathematics === 55);
        await page.waitForFunction(() => [...document.querySelectorAll('td')].some(td => td.textContent === 'PASSED' &&
            td.closest('tr').textContent.includes('AGRIPA')));
        assert.equal(await femaleRow.locator('td.xl-override').count(), 1);
        await page.waitForFunction(() => window.fixture.db.students.get('f1').results?.['7']?.remark === 'PASSED');
        assert.deepEqual(await page.evaluate(() => window.fixture.db.students.get('f1').results['7'].overridden), ['Mathematics']);
        await page.screenshot({ path: `${output}/results.png` });
        await femaleRow.locator('input[data-field="Mathematics"]').fill('');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => window.fixture.db.students.get('f1').scoreOverrides['7'].Mathematics === undefined);
        const invalid = femaleRow.locator('input[data-field="ESAS"]');
        await invalid.fill('120');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => /0 to 100/.test(document.querySelector('.xl-status').textContent));

        // Export uses the record template.
        const download = page.waitForEvent('download');
        await page.locator('[data-act="export"]').click();
        assert.match((await download).suggestedFilename(), /^PreBoard_Examination_Record_Exam_1\.xlsx$/);

        // Phone width: page itself does not scroll sideways.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('tab', { name: 'Name of Students' }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await page.screenshot({ path: `${output}/phone.png` });
        assert.deepEqual(errors, []);
        console.log(`Student sheet browser checks passed. Screenshots: ${output}`);
    } finally {
        await browser?.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

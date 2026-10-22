// Run: node web/tests/exam-pdf-browser.cjs /private/tmp/pbec-exam-pdf
// Uses installed Brave + bundled Playwright/PDF.js. All app network data is mocked.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const dependencies = process.env.PBEC_NODE_MODULES || '/Users/jaysonreales/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(path.join(dependencies, 'playwright'));
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || '/private/tmp/pbec-exam-pdf';
const questions = Array.from({ length: 42 }, (_, i) => ({ _id: `doc-${i}`, _bankId: 'default_mathematics', id: i + 1,
    subject: 'Mathematics', isDefault: true, questionText: `Q${String(i + 1).padStart(3, '0')} ${i === 0 ? 'Evaluate \\(\\frac{1+\\sqrt{9}}{2}+x^{2}\\) and √16 with x².' : 'Select the correct value for this representative exam question.'}`,
    optionA: i === 0 ? '\\(\\frac{1}{2}\\)' : '12', optionB: i === 0 ? '\\(\\sqrt{16}\\)' : '24',
    optionC: i === 1 ? 'A medium length answer choice requiring two columns' : '36',
    optionD: i === 2 ? 'A very long answer choice that should occupy a full width option row to preserve its natural readable font size without reducing the question text.' : '48', correctAnswer: 'B' }));
const exam = { examName: 'PRIVATE TITLE DO NOT PRINT', subject: 'Mathematics', createdAt: 123456, setAQuestionIds: questions.map(q => q.id),
    setBQuestionIds: questions.map(q => q.id).reverse(), selectedQuestionBankIds: ['default_mathematics'] };
const js = body => ({ contentType: 'text/javascript', body });
(async () => {
    await fs.mkdir(output, { recursive: true });
    const server = http.createServer(async (request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const base = pathname.startsWith('/__pdfjs/') ? path.join(dependencies, 'pdfjs-dist/build') : root;
        const relative = pathname.startsWith('/__pdfjs/') ? pathname.slice('/__pdfjs/'.length) : '.' + pathname;
        const file = path.resolve(base, relative);
        if (!file.startsWith(base + path.sep)) return response.writeHead(403).end();
        try { response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); response.end(await fs.readFile(file)); }
        catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.PBEC_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Prevent any accidental external calls, including Firebase writes and credentials.
        await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        await page.goto(origin + '/tests/exam-pdf-browser.html');
        await page.waitForFunction(() => window.pdfFixture);
        const summary = [];
        for (const set of ['A', 'B']) {
            const result = await page.evaluate(async ({ exam, questions, set }) => {
                const bytes = await window.pdfFixture.createExamPdf({ exam, questions, set, showAnswers: true });
                const pdfjs = await import('/__pdfjs/pdf.mjs');
                pdfjs.GlobalWorkerOptions.workerSrc = '/__pdfjs/pdf.worker.mjs';
                const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
                let text = '', dimensions = [], fragments = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i), content = await page.getTextContent();
                    text += content.items.map(item => item.str).join(' ') + '\n';
                    dimensions.push(page.view);
                    fragments.push(...content.items.filter(item => item.str.trim()).map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width })));
                    if (i === 1) {
                        const canvas = document.createElement('canvas'), viewport = page.getViewport({ scale: 2 });
                        canvas.width = viewport.width; canvas.height = viewport.height;
                        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                        window.pdfPreview = canvas.toDataURL('image/png');
                    }
                }
                return { bytes: Array.from(bytes), text, pages: pdf.numPages, dimensions, fragments, png: window.pdfPreview };
            }, { exam, questions, set });
            assert.ok(result.pages > 1);
            assert.deepEqual(result.dimensions, result.dimensions.map(() => [0, 0, 612, 936]));
            const markers = [...result.text.matchAll(/Q\d{3}/g)].map(match => match[0]);
            assert.deepEqual(markers, (set === 'A' ? questions : [...questions].reverse()).map(q => q.questionText.slice(0, 4)));
            assert.equal(/localhost|PRIVATE TITLE|123456/.test(result.text), false);
            assert.match(result.text, /Multiple Choice/);
            assert.match(result.text, /END/);
            assert.match(result.text, /DISCIPLINARY ACTION/);
            assert.equal(result.fragments.some(f => f.x < 27.9 || f.x + f.width > 584.2 || f.y < 27.9 || f.y > 908.1), false);
            await fs.writeFile(path.join(output, `exam-set-${set}.pdf`), Buffer.from(result.bytes));
            await fs.writeFile(path.join(output, `exam-set-${set}-page-1.png`), Buffer.from(result.png.split(',')[1], 'base64'));
            summary.push({ set, pages: result.pages, dimensions: result.dimensions, markers, text: result.text });
        }
        await page.route('**/js/auth.js', route => route.fulfill(js(`export async function requireAuth(){document.body.classList.add('loaded');return {uid:'teacher',email:'fixture@example.test',name:'Fixture'};} export function logout(){}`)));
        await page.route('**/js/sidebar.js', route => route.fulfill(js(`export function renderSidebar(){return '<span id="user-email-display"></span><span id="user-avatar"></span><button id="logout-btn">Logout</button>';}`)));
        await page.route('**/js/firebase-config.js', route => route.fulfill(js('export const db = {};')));
        await page.route('**/js/ui.js', route => route.fulfill(js('export function initSidebar(){} export function showToast(){} export function formatDateTime(){return "Fixture date";}')));
        await page.route('**/firebase-firestore.js', route => route.fulfill(js(`
            const exam=${JSON.stringify(exam)},rows=${JSON.stringify(questions)};
            const params=new URLSearchParams(location.search),bankCase=params.get('bankCase');
            const custom=[
                {...rows[1],_id:'custom-own',_bankId:'custom_math',id:101,isDefault:false,uploadedByUid:'teacher',questionText:'CUSTOM_OWN Accessible owned question.'},
                {...rows[1],_id:'custom-default',_bankId:'custom_math',id:102,isDefault:true,uploadedByUid:'other',questionText:'CUSTOM_DEFAULT Accessible default question.'},
                {...rows[1],_id:'foreign-private',_bankId:'custom_math',id:103,isDefault:false,uploadedByUid:'other',questionText:'FOREIGN_PRIVATE Must never be read.'},
                {...rows[1],_id:'outside-bank',_bankId:'unselected_math',id:104,isDefault:true,questionText:'OUTSIDE_BANK Must never be selected.'}
            ];
            let selectedExam=exam;
            if(bankCase){
                const banks=bankCase==='mixed'?['default_mathematics','custom_math']:['custom_math'];
                const ids=bankCase==='mixed'?[1,101,102]:bankCase==='foreign-reference'?[101,103]:[101,102];
                selectedExam={...exam,selectedQuestionBankIds:banks,setAQuestionIds:ids,setBQuestionIds:[...ids].reverse()};
                if(bankCase==='legacy'){delete selectedExam.selectedQuestionBankIds;selectedExam.setAQuestionIds=[1];selectedExam.setBQuestionIds=[1];}
                if(bankCase==='session'){delete selectedExam.selectedQuestionBankIds;selectedExam.sessionIds=['custom_math'];}
                if(bankCase==='invalid')selectedExam.selectedQuestionBankIds=['custom_math/invalid'];
            }
            window.bankFixture={queries:[],returned:[]};
            export function collection(_,collection,bankId,child){return {collection,bankId,child};}
            export function collectionGroup(){return {group:true};}
            export function doc(...args){return args;}
            export function query(collection,...filters){return {...collection,filters};}
            export function where(field,operator,value){return {field,operator,value};}
            export async function getDoc(){return {exists:()=>true,data:()=>selectedExam};}
            export async function getDocs(request){
                let pool=params.has('missing')?rows.slice(1):[...rows,...custom];
                if(!request.group){
                    const filters=request.filters||[];
                    const permitted=filters.length===1&&filters[0].operator==='=='&&
                        ((filters[0].field==='isDefault'&&filters[0].value===true)||(filters[0].field==='uploadedByUid'&&filters[0].value==='teacher'));
                    if(!permitted)throw Error('Fixture rejected an unscoped teacher read');
                    window.bankFixture.queries.push(request);
                    pool=pool.filter(row=>row._bankId===request.bankId&&filters.every(filter=>row[filter.field]===filter.value));
                }
                window.bankFixture.returned.push(...pool.map(row=>row._id));
                return {docs:pool.map(row=>({id:row._id,data:()=>row,ref:{parent:{parent:{id:row._bankId}}}}))};
            }
        `)));
        for (const role of ['admin', 'teacher']) {
            await page.goto(`${origin}/${role}/view-exam.html?id=fixture`);
            await page.waitForFunction(() => !document.querySelector('#btn-download-pdf').disabled);
            assert.equal(await page.locator('.option-box.correct').count(), 42);
            await page.locator('#btn-next').click();
            assert.match(await page.locator('#page-display').textContent(), /Page 2/);
            const downloadEvent = page.waitForEvent('download');
            await page.locator('#btn-download-pdf').click();
            await (await downloadEvent).saveAs(path.join(output, `${role}-page-2-all-questions.pdf`));
            await page.waitForFunction(() => document.querySelector('#pdf-export-status').textContent.includes('downloaded'));
            await page.locator('#exam-set').selectOption('B');
            assert.match(await page.locator('.question-text').first().textContent(), /Q042/);
            const bDownload = page.waitForEvent('download');
            await page.locator('#btn-download-pdf').click();
            await (await bDownload).saveAs(path.join(output, `${role}-set-B.pdf`));
            await page.waitForFunction(() => document.querySelector('#pdf-export-status').textContent.includes('downloaded'));
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await page.locator('#btn-download-pdf').isVisible(), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
            // Establish a start point, then use real keyboard navigation to enter :focus-visible.
            // The preceding mouse click can leave the already-focused button outside that state.
            await page.locator('#exam-set').focus();
            await page.keyboard.press('Tab');
            const focus = await page.locator('#btn-download-pdf').evaluate(el => {
                const style = getComputedStyle(el);
                return { active: document.activeElement === el, visible: el.matches(':focus-visible'),
                    outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor };
            });
            assert.equal(focus.active, true, 'Tab must reach the PDF download button from the set selector');
            assert.equal(focus.visible, true, 'Keyboard navigation must activate :focus-visible');
            assert.notEqual(focus.outlineStyle, 'none', 'Keyboard focus must have a visible outline');
            assert.ok(focus.outlineWidth >= 2, 'Keyboard focus outline must be at least 2px');
            await fs.writeFile(path.join(output, `${role}-keyboard-focus.json`), JSON.stringify(focus, null, 2));
            await page.screenshot({ path: path.join(output, `${role}-mobile.png`), fullPage: true });
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.goto(`${origin}/${role}/view-exam.html?id=fixture&missing=1`);
            await page.waitForFunction(() => document.querySelector('#pdf-export-status').textContent.includes('missing'));
            assert.equal(await page.locator('#btn-download-pdf').isDisabled(), true);
            await page.screenshot({ path: path.join(output, `${role}-missing-blocked.png`), fullPage: true });
        }
        const bankEvidence = [];
        for (const bankCase of ['custom', 'mixed', 'session', 'legacy', 'foreign-reference', 'invalid']) {
            await page.goto(`${origin}/teacher/view-exam.html?id=fixture&bankCase=${bankCase}`);
            const blocked = bankCase === 'foreign-reference' || bankCase === 'invalid';
            await page.waitForFunction(blocked
                ? () => /missing|Invalid exam question bank IDs/.test(document.querySelector('#pdf-export-status').textContent)
                : () => !document.querySelector('#btn-download-pdf').disabled);
            const evidence = await page.evaluate(() => ({ ...window.bankFixture,
                text: document.querySelector('#questions-list').textContent, status: document.querySelector('#pdf-export-status').textContent }));
            const expectedBanks = bankCase === 'invalid' ? [] : bankCase === 'mixed' ? ['default_mathematics', 'custom_math'] : bankCase === 'legacy' ? ['default_mathematics'] : ['custom_math'];
            assert.deepEqual([...new Set(evidence.queries.map(query => query.bankId))], expectedBanks);
            assert.equal(evidence.queries.length, expectedBanks.length * 2);
            assert.equal(evidence.returned.includes('foreign-private'), false, 'Foreign private questions must never be returned by teacher queries');
            assert.equal(evidence.returned.includes('outside-bank'), false, 'Unselected bank questions must never be read');
            assert.equal(evidence.text.includes('FOREIGN_PRIVATE'), false);
            assert.equal(await page.locator('#btn-download-pdf').isDisabled(), blocked);
            if (!blocked) {
                const expected = bankCase === 'mixed' ? ['Q001', 'CUSTOM_OWN', 'CUSTOM_DEFAULT'] : bankCase === 'legacy' ? ['Q001'] : ['CUSTOM_OWN', 'CUSTOM_DEFAULT'];
                assert.deepEqual(await page.locator('.question-text').evaluateAll(items => items.map(item => item.textContent.split(' ')[0])), expected);
                const event = page.waitForEvent('download');
                await page.locator('#btn-download-pdf').click();
                await (await event).saveAs(path.join(output, `teacher-${bankCase}-banks.pdf`));
                await page.waitForFunction(() => document.querySelector('#pdf-export-status').textContent.includes('downloaded'));
                await page.locator('#exam-set').selectOption('B');
                assert.deepEqual(await page.locator('.question-text').evaluateAll(items => items.map(item => item.textContent.split(' ')[0])), [...expected].reverse());
            }
            bankEvidence.push({ bankCase, ...evidence });
        }
        await fs.writeFile(path.join(output, 'teacher-selected-bank-checks.json'), JSON.stringify(bankEvidence, null, 2));
        assert.deepEqual(errors, []);
        await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ status: 'passed', summary, pageErrors: errors,
            checks: ['real math PDF A/B', 'all 42 questions selected order', '612x936 pages', '28pt text bounds', 'no private title/date/URL', 'real views reveal on + page 2 download', 'B screen order and download', 'mobile export visible', 'mobile overflow', 'keyboard focus', 'missing questions block both real views', 'teacher noncanonical banks', 'teacher mixed banks', 'legacy session bank IDs', 'canonical fallback', 'foreign private questions excluded', 'invalid bank metadata blocked'] }, null, 2));
        console.log(`PASS: PDF/browser evidence in ${output}`);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

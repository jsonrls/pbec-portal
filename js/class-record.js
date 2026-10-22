import { normalizeStudent, studentSnapshot } from "./student-actions.js";
import { isExamOwner, examSubject } from "./exam-data.js";

export const RECORD_SUBJECTS = ["Mathematics", "ESAS", "Professional EE"];
export const ATTEMPT_POLICY = "Highest valid percentage across scans and portal Set A/B; ties use newest time, then source and document ID. Missing subjects stay blank.";

export async function loadClassRecordData({ db, api, selections, user }) {
    const { collection, query, where, getDocsFromServer } = api;
    const requests = [];
    for (const name of ["examResults", "scan_results"]) {
        for (const exam of selections) {
            const ids = new Set([String(exam._id)]);
            if (exam.id != null && String(exam.id).trim()) {
                ids.add(String(exam.id));
                if (Number.isSafeInteger(Number(exam.id))) ids.add(Number(exam.id));
            }
            requests.push(getDocsFromServer(query(collection(db, name), where("examId", "in", [...ids])))
                .then(snapshot => ({ name, docs: snapshot.docs.map(doc => ({ ...doc.data(), _id: doc.id })) })));
        }
    }
    const ownerUids = [...new Set(selections.map(exam => exam.uploadedByUid || exam.createdByUid).filter(Boolean))];
    const ownerLookup = user?.role === "admin" && ownerUids.length
        ? getDocsFromServer(query(collection(db, "users"), where("__name__", "in", ownerUids)))
        : Promise.resolve({ docs: [] });
    const [batches, students, snapshots, owners] = await Promise.all([
        Promise.all(requests), getDocsFromServer(collection(db, "students")),
        getDocsFromServer(query(collection(db, "examResults"), where("recordType", "==", "rosterSnapshot"))), ownerLookup
    ]);
    const unique = name => [...new Map(batches.filter(batch => batch.name === name).flatMap(batch => batch.docs).map(doc => [doc._id, doc])).values()];
    return { students: students.docs.map(doc => ({ ...doc.data(), _id: doc.id })),
        ownerProfiles: owners.docs.map(doc => ({ uid: doc.id, email: doc.data().email || "" })),
        snapshots: snapshots.docs.map(doc => ({ ...doc.data(), _id: doc.id })),
        portalResults: unique("examResults"), scanResults: unique("scan_results") };
}

const key = value => value == null ? "" : String(value).trim();
const ownerFields = ["createdByUid", "uploadedByUid", "createdBy", "createdByEmail", "uploadedByTeacherId", "uploaderEmail", "teacherEmail", "teacherId", "ownerUid"];
export const ownerKeys = record => ownerFields.map(field => key(record[field])).filter(Boolean);
export function canReadExam(exam, user) {
    if (user.role === "admin") return true;
    return isExamOwner(exam, user);
}

export function timestamp(value) {
    if (value?.toMillis) return value.toMillis();
    if (value?.seconds != null) return value.seconds * 1000;
    const result = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(result) ? result : 0;
}

export function percentage(value) {
    if (value == null || value === "" || typeof value === "boolean") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

export function portalPercentages(record) {
    const raw = ["raw", "count", "rawCount"].includes(record.scoreType);
    const total = Number(record.total ?? record.totalQuestions ?? record.totalItems);
    return [record.scoreA, record.scoreB].map(value => {
        if (!raw) return percentage(value);
        if (!(total > 0) || value == null || value === "" || typeof value === "boolean") return null;
        return percentage(Number(value) / total * 100);
    });
}

export function matchesExam(record, exam, exams, user, ownerProfiles = []) {
    if (!canReadExam(exam, user) || record.deletedAt != null || record.recordType === "rosterSnapshot") return false;
    const recordId = key(record.examId);
    const direct = recordId === key(exam._id);
    if (!direct && (!key(exam.id) || recordId !== key(exam.id))) return false;
    if (record.subject && record.subject !== exam.subject) return false;
    const owners = ownerKeys(record);
    const examOwners = ownerKeys(exam);
    const recordUids = [record.uploadedByUid, record.createdByUid, record.ownerUid].map(key).filter(Boolean);
    const examUids = [exam.uploadedByUid, exam.createdByUid, exam.ownerUid].map(key).filter(Boolean);
    if (recordUids.length && examUids.length && recordUids.some(uid => !examUids.includes(uid))) return false;
    // Old portal writers stored only teacherEmail. Bridge it only for an exact
    // document reference and an email verified against the exam owner's UID.
    const ownerEmailVerified = (!!user.uid && examUids.includes(key(user.uid)) &&
        !!user.email && record.teacherEmail === user.email) ||
        (user.role === "admin" && ownerProfiles.some(profile =>
            examUids.includes(key(profile.uid)) && !!profile.email && record.teacherEmail === profile.email));
    const legacyPortalOwner = direct && !recordUids.length && !!record.studentDocId &&
        ownerEmailVerified;
    // Ownerless portal rows are safe only with an exact Firestore document key.
    if (owners.length && !owners.some(value => examOwners.includes(value)) && !legacyPortalOwner) return false;
    if (!direct && !owners.length) return false;
    if (user.role !== "admin" && owners.length && !canReadExam({ ...record, createdByEmail: record.createdByEmail || record.teacherEmail }, user)) return false;
    if (direct) return true;
    const candidates = exams.filter(candidate => key(candidate._id) === recordId || (key(candidate.id) && key(candidate.id) === recordId))
        .filter(candidate => !owners.length || ownerKeys(candidate).some(value => owners.includes(value)));
    return candidates.length === 1 && candidates[0]._id === exam._id;
}

function betterAttempt(a, b) {
    return b.percentage - a.percentage || b.time - a.time || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
}

export function buildClassRecord({ students = [], portalResults = [], scanResults = [], snapshots = [], ownerProfiles = [], selections, exams = selections, user, clusterId = null }) {
    if (!Array.isArray(selections) || selections.length !== 3 ||
        !RECORD_SUBJECTS.every((subject, index) => selections[index]?.subject === subject)) {
        throw new Error("Choose one exam for each of the three subjects.");
    }
    if (selections.some(exam => !canReadExam(exam, user))) throw new Error("An exam is outside your report access.");
    const identities = new Map();
    for (const item of [...snapshots, ...portalResults]) {
        if (item.studentSnapshot && item.studentDocId) identities.set(key(item.studentDocId), normalizeStudent({ ...item.studentSnapshot, _id: key(item.studentDocId), rosterDeleted: true }));
    }
    for (const item of students) identities.set(key(item._id), normalizeStudent(item));
    const byStudentId = new Map();
    for (const student of identities.values()) {
        if (!student.studentId) continue;
        const matches = byStudentId.get(student.studentId) || [];
        matches.push(student);
        byStudentId.set(student.studentId, matches);
    }
    const rows = new Map();
    const warnings = new Set();
    function resolveIdentity(record, source) {
        const docId = key(record.studentDocId);
        if (docId) {
            return identities.get(docId) || normalizeStudent({ ...record.studentSnapshot,
                _id: docId, name: record.studentSnapshot?.name || record.studentName || `Former student (${docId})`,
                studentId: record.studentSnapshot?.studentId || record.studentId || "", rosterDeleted: true });
        }
        const sid = key(record.studentId);
        if (!sid) { warnings.add("Some results without a student identifier were excluded."); return null; }
        const matches = byStudentId.get(sid) || [];
        if (matches.length > 1) { warnings.add(`Student ID ${sid} is duplicated in the roster; ambiguous scans were excluded.`); return null; }
        return matches[0] || normalizeStudent({ ...record, _id: `student:${sid}`, rosterDeleted: true });
    }
    selections.forEach((exam, subjectIndex) => {
        for (const [source, records] of [["portal", portalResults], ["scan", scanResults]]) {
            for (const record of records) {
                if (!matchesExam(record, exam, exams, user, ownerProfiles) || key(record.clusterId) !== key(clusterId)) continue;
                const student = resolveIdentity(record, source);
                if (!student) continue;
                const rowKey = student._id;
                if (!rows.has(rowKey)) rows.set(rowKey, { ...studentSnapshot(student), _id: rowKey,
                    rosterDeleted: !!student.rosterDeleted, isArchived: !!student.isArchived, subjects: [null, null, null] });
                const values = source === "portal" ? portalPercentages(record) :
                    [record.total > 0 && record.score != null && record.score !== "" ? percentage(Number(record.score) / Number(record.total) * 100) : null];
                const valid = values.filter(value => value !== null);
                if (!valid.length) continue;
                const attempt = { percentage: Math.max(...valid), source, id: key(record._id),
                    time: timestamp(record.scannedAt || record.updatedAt || record.createdAt) };
                const existing = rows.get(rowKey).subjects[subjectIndex];
                if (!existing || betterAttempt(attempt, existing) < 0) rows.get(rowKey).subjects[subjectIndex] = attempt;
            }
        }
    });
    const output = [...rows.values()].map(row => {
        const percentages = row.subjects.map(attempt => attempt?.percentage ?? null);
        const complete = percentages.every(value => value !== null);
        const rating = complete ? percentages[0] * .25 + percentages[1] * .30 + percentages[2] * .45 : null;
        return { ...row, percentages, rating, remark: complete ? (rating >= 70 && percentages.every(value => value >= 50) ? "PASSED" : "FAILED") : "INCOMPLETE" };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId) || a._id.localeCompare(b._id));
    return { rows: output, warnings: [...warnings] };
}

function xmlEscape(value) {
    return String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[&<>"']/g,
        char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}
function cell(ref, style, value, formula = null) {
    const attributes = `r="${ref}" s="${style}"`;
    if (formula !== null) return `<c ${attributes}${typeof value === "string" || value === null ? ' t="str"' : ""}><f>${xmlEscape(formula)}</f><v>${xmlEscape(value)}</v></c>`;
    if (value === null || value === undefined) return `<c ${attributes}/>`;
    if (typeof value === "number") return `<c ${attributes}><v>${value}</v></c>`;
    return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function templateRow(xml, number) {
    const match = xml.match(new RegExp(`<row\\b[^>]*\\br="${number}"[^>]*>[\\s\\S]*?<\\/row>`));
    if (!match) throw new Error(`Workbook template is missing row ${number}.`);
    return match[0];
}
function stylesOf(row) {
    return Object.fromEntries([...row.matchAll(/<c\b[^>]*r="([A-Z]+)\d+"[^>]*s="(\d+)"/g)].map(match => [match[1], match[2]]));
}
function replaceRows(xml, rows, lastColumn, lastRow, keepBefore, merges) {
    const headerRows = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)]
        .filter(match => Number(match[1]) < keepBefore).map(match => match[0]).join("");
    return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${headerRows}${rows}</sheetData>`)
        .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${lastColumn}${lastRow}"/>`)
        .replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/, `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`);
}

export async function createClassWorkbook({ template, rows, selections, clusterName = "Unclustered", instructor = "", schoolYear = "", JSZip = globalThis.JSZip }) {
    if (!JSZip) throw new Error("The Excel library could not be loaded. Reload and try again.");
    if (!rows.length) throw new Error("No results match these exams and record group.");
    if (rows.length > 1048570) throw new Error("Too many students for one workbook.");
    const zip = await JSZip.loadAsync(template);
    let roster = await zip.file("xl/worksheets/sheet1.xml").async("string");
    let results = await zip.file("xl/worksheets/sheet2.xml").async("string");
    const rosterStyle = stylesOf(templateRow(roster, 7));
    const resultStyle = stylesOf(templateRow(results, 3));
    const headerStyle = stylesOf(templateRow(roster, 5));
    const stylesXml = await zip.file("xl/styles.xml").async("string");
    const xfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    const styles = [...xfs[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(match => match[0]);
    const textStyles = [rosterStyle.C, resultStyle.C].map(index => styles[Number(index)]
        .replace(/numFmtId="\d+"/, 'numFmtId="49"')
        .replace(/\sapplyNumberFormat="[^"]*"/, "").replace("<xf ", '<xf applyNumberFormat="1" '));
    rosterStyle.C = String(styles.length);
    resultStyle.C = String(styles.length + 1);
    zip.file("xl/styles.xml", stylesXml.replace(xfs[0], `<cellXfs count="${styles.length + 2}">${styles.join("")}${textStyles.join("")}</cellXfs>`));
    let rosterRows = `<row r="5" ht="16.2" customHeight="1">${cell("A5", headerStyle.A, "STUDENTS")}${cell("B5", headerStyle.B, null)}${cell("C5", headerStyle.C, "Student ID")}${cell("D5", headerStyle.D, "Block")}${cell("E5", headerStyle.E, "Email Address")}</row>`;
    let resultRows = "";
    rows.forEach((row, index) => {
        const rr = index + 6, r = index + 3;
        rosterRows += `<row r="${rr}" ht="15.6" customHeight="1">` +
            [index + 1, row.name, String(row.studentId), row.section, row.email].map((value, i) => cell(`${"ABCDE"[i]}${rr}`, rosterStyle["ABCDE"[i]], value)).join("") + "</row>";
        resultRows += `<row r="${r}" ht="15.6" customHeight="1">` +
            [index + 1, row.name, String(row.studentId)].map((value, i) => cell(`${"ABC"[i]}${r}`, resultStyle["ABC"[i]], value, `'Name of Students'!${"ABC"[i]}${rr}`)).join("");
        row.percentages.forEach((value, i) => {
            const raw = "DFH"[i], pct = "EGI"[i];
            resultRows += cell(`${raw}${r}`, resultStyle[raw], value) + cell(`${pct}${r}`, resultStyle[pct], value, `IF(COUNT(${raw}${r})=0,"",${raw}${r})`);
        });
        resultRows += cell(`J${r}`, resultStyle.J, row.rating, `IF(COUNT(E${r},G${r},I${r})<3,"",0.25*E${r}+0.30*G${r}+0.45*I${r})`) +
            cell(`K${r}`, resultStyle.K, row.remark, `IF(COUNT(D${r},F${r},H${r})<3,"INCOMPLETE",IF(AND(J${r}>=70,MIN(D${r},F${r},H${r})>=50),"PASSED","FAILED"))`) + "</row>";
    });
    roster = replaceRows(roster, rosterRows, "G", rows.length + 5, 5, ["A1:G2", "A3:B3", "A4:B4", "A5:B5"]);
    roster = roster.replace(/<c\b[^>]*r="F4"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, cell("F4", 6, instructor))
        .replace(/<c\b[^>]*r="G4"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, cell("G4", 8, schoolYear));
    results = replaceRows(results, resultRows, "K", rows.length + 2, 3, ["D2:E2", "F2:G2", "H2:I2"]);
    zip.file("xl/worksheets/sheet1.xml", roster);
    zip.file("xl/worksheets/sheet2.xml", results);
    // Scope lives in document properties and the filename, leaving the institutional header layout intact.
    const properties = await zip.file("docProps/core.xml").async("string");
    const description = `<dc:description>${xmlEscape(`${clusterName}; ${selections.map(exam => `${exam.subject}: ${exam.examName || exam.name || exam._id} [${exam._id}]`).join("; ")}; ${ATTEMPT_POLICY}`)}</dc:description>`;
    zip.file("docProps/core.xml", properties.replace(/<dc:description>[\s\S]*?<\/dc:description>/, "")
        .replace("</cp:coreProperties>", `${description}</cp:coreProperties>`));
    // Excel rebuilds dependency information for the dynamically sized rows.
    zip.remove("xl/calcChain.xml");
    for (const path of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) {
        const xml = await zip.file(path).async("string");
        zip.file(path, xml.replace(/<(?:Relationship|Override)\b[^>]*(?:calcChain)[^>]*\/>/g, ""));
    }
    zip.file("xl/workbook.xml", (await zip.file("xl/workbook.xml").async("string"))
        .replace(/<mc:AlternateContent\b[^>]*>[\s\S]*?<\/mc:AlternateContent>/g, block => block.includes(":absPath") ? "" : block)
        .replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>'));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function mountClassRecord({ mount, exportButton, user, loadExams, loadRecords, templateUrl, logActivity, showToast }) {
    mount.innerHTML = `<div class="card mb-24" style="margin-bottom:24px;"><div class="card-body">
        <h2 style="margin-bottom:12px;">Excel class record</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px;">
        ${RECORD_SUBJECTS.map((subject, index) => `<div class="form-group"><label for="record-exam-${index}">${subject}</label><select class="form-control" id="record-exam-${index}" disabled><option value="">Loading exams…</option></select></div>`).join("")}
        <div class="form-group"><label for="record-group">Record group</label><select class="form-control" id="record-group" disabled><option value="">Choose three exams first</option></select></div></div>
        <div class="form-group" style="max-width:320px;"><label for="record-school-year">School year (optional)</label><input class="form-control" id="record-school-year" placeholder="Enter the school year" /></div>
        <p class="text-sm">Raw percentages: Mathematics 25%, ESAS 30%, Professional EE 45%. Pass: overall at least 70, each subject at least 50, all subjects present.</p>
        <p class="text-sm">${ATTEMPT_POLICY} Export includes students with a result for the selected exams and record group, including archived and deleted students. Groups are kept separate; unclustered portal grades are included only in Unclustered records.</p>
        <p id="record-status" role="status" aria-live="polite" class="text-sm">Loading available exams…</p>
        <button type="button" id="record-retry" class="btn btn-secondary hidden">Retry loading exams</button>
        </div></div>`;
    const selects = RECORD_SUBJECTS.map((_, index) => mount.querySelector(`#record-exam-${index}`));
    const group = mount.querySelector("#record-group");
    const status = mount.querySelector("#record-status");
    const retry = mount.querySelector("#record-retry");
    mount.querySelector(".card-body").appendChild(exportButton);
    let exams = [], generation = 0, busy = false;
    const selections = () => selects.map(select => exams.find(exam => exam._id === select.value));
    function updateExportButton() {
        exportButton.disabled = busy || !group.value || selections().some(exam => !exam);
    }
    function option(select, value, label) { select.add(new Option(label, value)); }
    async function loadOptions() {
        retry.classList.add("hidden");
        status.textContent = "Loading available exams…";
        try {
            exams = (await loadExams()).map(exam => ({ ...exam, subject: examSubject(exam) }))
                .filter(exam => canReadExam(exam, user) && exam.deletedAt == null && !exam.isArchived);
            exams.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a._id.localeCompare(b._id));
            selects.forEach((select, index) => {
                select.replaceChildren();
                const choices = exams.filter(exam => exam.subject === RECORD_SUBJECTS[index]);
                option(select, "", choices.length ? "Choose an exam" : "No exams available");
                for (const exam of choices) option(select, exam._id, `${exam.examName || exam.name || exam._id} [${exam._id}]`);
                select.disabled = choices.length === 0;
            });
            status.textContent = "Choose one exam for each subject, then choose the record group. No exams are selected automatically.";
        } catch (error) {
            status.textContent = `Could not load exams: ${error.message}`;
            retry.classList.remove("hidden");
        }
        updateExportButton();
    }
    async function loadGroups() {
        const request = ++generation;
        group.replaceChildren();
        option(group, "", "Choose three exams first");
        group.disabled = true;
        updateExportButton();
        if (selections().some(exam => !exam)) return;
        status.textContent = "Loading record groups…";
        try {
            const selected = selections();
            const data = await loadRecords(selected);
            if (request !== generation) return;
            const matching = [...data.portalResults, ...data.scanResults].filter(record =>
                selected.some(exam => matchesExam(record, exam, exams, user, data.ownerProfiles)));
            const groups = new Map();
            for (const record of matching) {
                if (key(record.clusterId)) groups.set(key(record.clusterId), record.clusterName || `Cluster ${record.clusterId}`);
            }
            group.replaceChildren();
            option(group, "", "Choose a record group");
            option(group, "unclustered", "Unclustered records (portal / legacy scans)");
            for (const [id, name] of [...groups].sort(([a], [b]) => a.localeCompare(b))) option(group, `cluster:${id}`, `${name} [${id}]`);
            group.disabled = false;
            status.textContent = matching.length ? "Choose a record group, then export the Excel class record." : "No results found for these exams. Choose another exam or record scores before exporting.";
        } catch (error) {
            if (request !== generation) return;
            option(group, "", "Could not load records");
            status.textContent = `Could not load record groups: ${error.message}. Change an exam to retry.`;
        }
        updateExportButton();
    }
    selects.forEach(select => select.addEventListener("change", loadGroups));
    group.addEventListener("change", () => {
        status.textContent = group.value ? "Ready to export the selected exams and record group." : "Choose a record group.";
        updateExportButton();
    });
    retry.addEventListener("click", loadOptions);
    exportButton.addEventListener("click", async () => {
        if (busy || exportButton.disabled) return;
        const selected = selections(), clusterId = group.value.startsWith("cluster:") ? group.value.slice(8) : null;
        const clusterName = group.selectedOptions[0].textContent;
        busy = true;
        updateExportButton();
        for (const select of [...selects, group]) select.disabled = true;
        exportButton.textContent = "Creating Excel…";
        status.textContent = "Loading current results and creating the workbook…";
        try {
            const data = await loadRecords(selected);
            const report = buildClassRecord({ ...data, selections: selected, exams, user, clusterId });
            if (!report.rows.length) throw new Error("No results match these exams and record group.");
            const response = await fetch(templateUrl);
            if (!response.ok) throw new Error("Workbook template could not be loaded.");
            const bytes = await createClassWorkbook({ template: await response.arrayBuffer(), rows: report.rows,
                selections: selected, clusterName, instructor: user.name || user.email,
                schoolYear: mount.querySelector("#record-school-year").value.trim() });
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `preboard_class_record_${selected.map(exam => exam._id).join("_")}_${clusterName}`.replace(/[^a-z0-9_-]/gi, "_").slice(0, 180) + ".xlsx";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            status.textContent = `Exported ${report.rows.length} students. ${report.warnings.join(" ")}`;
            await logActivity(user, "EXPORT_CLASS_RECORD", "Exported Excel class record", {
                operation: "READ", entityType: "examResult", examIds: selected.map(exam => exam._id), clusterId, studentCount: report.rows.length
            });
        } catch (error) {
            status.textContent = `Export failed: ${error.message}`;
            // showToast renders HTML; keep variable error text in the live status above.
            showToast("Class record could not be exported. See the report status for details.", "error");
        } finally {
            busy = false;
            for (const select of [...selects, group]) select.disabled = false;
            exportButton.textContent = "Export Excel class record";
            updateExportButton();
        }
    });
    await loadOptions();
}

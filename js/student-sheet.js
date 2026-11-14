// Students page rendered as the "PreBoard Examination Record" workbook: an editable
// "Name of Students" sheet backed by the students collection, and a RESULTS sheet whose
// scores come from scans for one exam cluster, with typed overrides per student.
import { normalizeStudent, escapeHtml } from "./student-actions.js";
import { RECORD_SUBJECTS, timestamp, buildClassRecord, loadClassRecordData, createClassWorkbook } from "./class-record.js";

export const MIN_SLOTS = 50;                       // the template prints 50 rows per gender block
export const ROSTER_FIELDS = ["name", "studentId", "block", "email"];
const DEFAULT_PROGRAM = "Bachelor of Science in Electrical Engineering";
const DEFAULT_YEAR_LEVEL = "4th Year";
const FIELD_LABELS = { name: "Name", studentId: "Student ID", block: "Block", email: "Email Address" };
const RESULT_HEADERS = ["MATHEMATICS", "ENGINEERING SCIENCE AND ALLIED SUBJECTS ", "PROFESSIONAL SUBJECTS"];
// Excel column widths (character units) from the template, converted to pixels.
const px = width => Math.round(width * 7 + 5);
const ROSTER_WIDTHS = [5.5, 41, 15.75, 15.75, 31.38, 35.88, 35.75].map(px);
const RESULT_WIDTHS = [4.63, 35.13, 18.75, 13.38, 13.38, 13.38, 13.38, 13.38, 12.5, 14.75, 15.13].map(px);

const text = value => String(value ?? "").trim();
const key = value => value == null ? "" : String(value).trim();
const fixed = value => value == null ? "" : Number(value).toFixed(2);
const plain = value => value == null ? "" : String(Math.round(value * 100) / 100);

export function genderOf(student) {
    const gender = text(student.gender).toUpperCase();
    return gender === "MALE" || gender === "FEMALE" ? gender : "";
}

// Rows stay in entry order like the paper record; a pending server timestamp sorts last.
const entryTime = student => student.createdAt === null ? Infinity : timestamp(student.createdAt);
const entryOrder = (a, b) => (entryTime(a) - entryTime(b)) || a.name.localeCompare(b.name) || a._id.localeCompare(b._id);

export function sheetSections(students, { hideArchived = false } = {}) {
    const groups = { MALE: [], FEMALE: [], "": [] };
    for (const raw of students) {
        if (raw.deletedAt != null || (hideArchived && raw.isArchived)) continue;
        const student = normalizeStudent(raw);
        groups[genderOf(student)].push(student);
    }
    return ["MALE", "FEMALE", ""].filter(gender => gender || groups[""].length)
        .map(gender => ({ gender, label: gender || "NO GENDER SET", students: groups[gender].sort(entryOrder) }));
}

export const slotCount = filled => Math.max(MIN_SLOTS, filled + 1);

export const isGridPaste = value => /[\t\r\n]/.test(value.replace(/\r?\n$/, ""));
export const parseClipboardGrid = value => value.replace(/\r?\n$/, "").split(/\r?\n/).map(line => line.split("\t"));

export function rowProblem(values, students, selfId = null) {
    const studentId = text(values.studentId);
    if (!text(values.name)) return "Enter the student's name.";
    if (!studentId) return "Enter the Student ID.";
    const clash = students.find(student => student._id !== selfId && student.deletedAt == null &&
        text(normalizeStudent(student).studentId).toLowerCase() === studentId.toLowerCase());
    if (!clash) return null;
    const other = normalizeStudent(clash);
    return `Student ID ${other.studentId} is already used by ${other.name}${clash.isArchived ? " (archived)" : ""}.`;
}

export function rosterUpdate(values) {
    const update = {};
    for (const [field, value] of Object.entries(values)) {
        if (!ROSTER_FIELDS.includes(field)) continue;
        update[field] = text(value);
        // The mobile roster reads block; older web rows read section.
        if (field === "block") update.section = update.block;
    }
    return update;
}

export function newStudentRecord(values, gender, uid, meta = {}) {
    return { ...rosterUpdate({ name: "", studentId: "", block: "", email: "", ...values }),
        gender, program: DEFAULT_PROGRAM, yearLevel: DEFAULT_YEAR_LEVEL, uploadedByUid: uid,
        instructor: text(meta.instructor), schoolYear: text(meta.schoolYear) };
}

/** INSTRUCTOR / SCHOOL YEAR header: stored on every roster row, shown as the most common value. */
export function rosterMeta(students, user) {
    return { instructor: mostCommon(students.map(student => student.instructor)) ||
            (user.role === "admin" ? "" : text(user.name || user.email)),
        schoolYear: mostCommon(students.map(student => student.schoolYear)) };
}

/** RESULTS row as saved on the student document under results.<clusterId>. */
export function storedResult(row, cluster) {
    const bySubject = values => Object.fromEntries(RECORD_SUBJECTS.map((subject, index) => [subject, values?.[index] ?? null]));
    return { clusterId: cluster.id, clusterName: text(cluster.name), schoolYear: text(cluster.schoolYear),
        scores: bySubject(row.percentages), transmuted: bySubject(row.transmuted), rating: row.rating ?? null,
        remark: row.remark || "", overridden: RECORD_SUBJECTS.filter((_, index) => row.subjects?.[index]?.source === "override") };
}

const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${stableJson(value[name])}`).join(",")}}`
        : JSON.stringify(value ?? null);

export function sameStoredResult(stored, wanted) {
    if (!stored || typeof stored !== "object") return false;
    const { updatedAt, ...rest } = stored;
    return stableJson(rest) === stableJson(wanted);
}

/** Typed raw score: null clears the override, undefined is invalid input. */
export function parseOverride(input) {
    const value = text(input);
    if (!value) return null;
    if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
    const number = Number(value);
    return number <= 100 ? number : undefined;
}

export function resultsLayout(sections, report) {
    const byId = new Map(report.rows.map(row => [row._id, row]));
    const layout = sections.map(section => ({ gender: section.gender, label: section.label,
        rows: section.students.map(student => ({ student, result: byId.get(student._id) || null, editable: true })) }));
    const listed = new Set(sections.flatMap(section => section.students.map(student => student._id)));
    const others = report.rows.filter(row => !listed.has(row._id));
    if (others.length) layout.push({ gender: "OTHER", label: "NOT IN ROSTER (deleted or archived)",
        rows: others.map(row => ({ student: row, result: row, editable: false })) });
    return layout;
}

/** RESULTS row has at least one subject score (scanned, portal or typed) for the cluster. */
export const hasScores = row => !!row?.result?.percentages?.some(value => value != null);

function mostCommon(values) {
    const counts = new Map();
    for (const value of values.map(text).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export function mountStudentSheet({ mount, user, db, api, removeStudent, removeLabel, removeIcon, logActivity, showToast, templateUrl }) {
    const { collection, doc, query, where, onSnapshot, updateDoc, writeBatch, serverTimestamp, deleteField, getDocs, getDocsFromServer } = api;
    const hideArchived = user.role !== "admin";
    let students = [], loaded = false, tab = "roster", rendering = false;
    const drafts = { MALE: [], FEMALE: [] };
    const metaDraft = {};   // header typed before any roster row exists to store it on
    const pending = new Set();
    let syncing = false, syncAgain = false;
    let clusters = null, exams = null, clusterId = "", selections = null, recordData = null, resultsBusy = false;
    // "Hide empty rows", remembered per browser like a spreadsheet view setting.
    const HIDE_KEY = "pbec.studentSheet.hideEmpty";
    let hideEmpty = false;
    let hidden = 0, gap = false;   // rows skipped in the last render; next shown row follows a hidden run
    try { hideEmpty = localStorage.getItem(HIDE_KEY) === "1"; } catch { /* storage blocked */ }
    const hideButton = `<button type="button" class="btn btn-secondary btn-sm" data-act="toggle-empty" aria-pressed="false">Hide empty rows</button>`;

    mount.innerHTML = `<div class="xl-book">
        <div class="xl-toolbar" data-sheet="roster">${hideButton}<span class="text-sm text-muted">Type in a cell to edit. A row saves once it has a name and Student ID. You can paste rows copied from Excel.</span></div>
        <div class="xl-toolbar hidden" data-sheet="results">
            <label class="text-sm fw-600" for="xl-cluster">Exam cluster</label>
            <select class="form-control xl-cluster" id="xl-cluster"><option value="">Loading clusters…</option></select>
            <button type="button" class="btn btn-secondary btn-sm" data-act="reload">Reload scores</button>
            <button type="button" class="btn btn-primary btn-sm" data-act="export" disabled>Export to Excel</button>
            ${hideButton}
            <span class="text-sm text-muted">Scores come from scans. Type a raw score to override it; clear the cell to use the scan again.</span>
        </div>
        <p class="xl-status text-sm" role="status" aria-live="polite">Loading students…</p>
        <div class="xl-scroll"><table class="xl-grid"></table></div>
        <div class="xl-tabs" role="tablist" aria-label="Sheets">
            <button type="button" role="tab" data-tab="roster" aria-selected="true">Name of Students</button>
            <button type="button" role="tab" data-tab="results" aria-selected="false">RESULTS</button>
        </div></div>`;
    const grid = mount.querySelector(".xl-grid");
    const statusLine = mount.querySelector(".xl-status");
    const clusterSelect = mount.querySelector(".xl-cluster");
    const exportButton = mount.querySelector('[data-act="export"]');
    const setStatus = (message, isError = false) => {
        statusLine.textContent = message;
        statusLine.classList.toggle("xl-error", isError);
    };

    // ─── Rendering ────────────────────────────────────────────────
    const sections = () => sheetSections(students, { hideArchived });
    const colgroup = widths => `<colgroup><col style="width:44px">${widths.map(width => `<col style="width:${width}px">`).join("")}<col style="width:84px"></colgroup>`;
    const letters = count => `<thead><tr><th class="xl-corner"></th>${[..."ABCDEFGHIJK"].slice(0, count)
        .map(letter => `<th scope="col">${letter}</th>`).join("")}<th class="xl-act-head"></th></tr></thead>`;
    const input = (pos, rowKey, field, value, label, extra = "") =>
        `<input class="xl-in" data-pos="${escapeHtml(pos)}" data-key="${escapeHtml(rowKey)}" data-field="${field}" ` +
        `data-orig="${escapeHtml(value)}" value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" spellcheck="false" ${extra}>`;

    function rosterHtml() {
        const visible = sections();
        const meta = headerMeta();
        let n = 0;
        hidden = 0; gap = false;
        const rn = () => { const mark = gap ? " xl-gap" : ""; gap = false; return `<th class="xl-rn${mark}" scope="row">${++n}</th>`; };
        let html = colgroup(ROSTER_WIDTHS) + letters(7) + "<tbody>" +
            `<tr class="xl-tall">${rn()}<td colspan="7" rowspan="2" class="xl-title">PREBOARD EXAMINATION RECORDS</td><td class="xl-act"></td></tr>` +
            `<tr>${rn()}<td class="xl-act"></td></tr>` +
            `<tr>${rn()}<td colspan="2" class="xl-box"></td><td></td><td></td><td></td><td class="xl-head">INSTRUCTOR</td><td class="xl-head">SCHOOL YEAR</td><td class="xl-act"></td></tr>` +
            `<tr>${rn()}<td colspan="2" class="xl-band">NAME OF STUDENTS</td><td></td><td></td><td></td>` +
            `<td class="xl-cell xl-meta">${input("META|0|instructor", "meta", "instructor", meta.instructor, "Instructor")}</td>` +
            `<td class="xl-cell xl-meta">${input("META|0|schoolYear", "meta", "schoolYear", meta.schoolYear, "School year")}</td><td class="xl-act"></td></tr>`;
        for (const section of visible) {
            html += `<tr>${rn()}<td colspan="2" class="xl-sec">${escapeHtml(section.label)}</td><td class="xl-sec">Student ID</td>` +
                `<td class="xl-sec">Block</td><td class="xl-sec">Email Address</td><td></td><td></td><td class="xl-act"></td></tr>`;
            const sectionDrafts = drafts[section.gender] || [];
            const total = section.gender ? slotCount(section.students.length + sectionDrafts.length) : section.students.length;
            for (let index = 0; index < total; index++) {
                const student = section.students[index];
                const draftIndex = index - section.students.length;
                const draft = student ? null : sectionDrafts[draftIndex];
                // Keep the first blank row so a student can still be added while empty rows are hidden.
                if (hideEmpty && !student && !draft && draftIndex > sectionDrafts.length) { n++; hidden++; gap = true; continue; }
                const rowKey = student ? `id:${student._id}` : draft ? `draft:${section.gender}:${draftIndex}` : `new:${section.gender}`;
                const values = student || draft || {};
                const classes = [student?.isArchived && "xl-archived", draft && "xl-draft", draft?.problem && "xl-bad"].filter(Boolean).join(" ");
                const title = draft?.problem || (draft ? "Not saved yet: needs a name and Student ID." : student?.isArchived ? "Archived" : "");
                html += `<tr class="${classes}"${title ? ` title="${escapeHtml(title)}"` : ""}>${rn()}<td class="xl-num">${index + 1}</td>` +
                    ROSTER_FIELDS.map(field => `<td class="xl-cell${field === "name" ? " xl-left" : ""}">` +
                        input(`${section.gender}|${index}|${field}`, rowKey, field, text(field === "block" ? values.block || values.section : values[field]),
                            `${section.label} row ${index + 1} ${FIELD_LABELS[field]}`) + "</td>").join("") +
                    `<td></td><td></td><td class="xl-act">${rowActions(student, draft, section.gender, draftIndex)}</td></tr>`;
            }
        }
        return html + "</tbody>";
    }

    function rowActions(student, draft, gender, draftIndex) {
        if (draft) return `<button type="button" class="xl-btn" data-act="discard" data-gender="${gender}" data-index="${draftIndex}" title="Discard this unsaved row" aria-label="Discard unsaved row">✕</button>`;
        if (!student) return "";
        const id = escapeHtml(student._id);
        const options = ["MALE", "FEMALE", ...(genderOf(student) ? [] : [""])]
            .map(value => `<option value="${value}"${genderOf(student) === value ? " selected" : ""}>${value ? value[0] : "?"}</option>`).join("");
        return `<select class="xl-gender" data-id="${id}" title="Move to the male or female list" aria-label="Gender for ${escapeHtml(student.name)}">${options}</select>` +
            `<button type="button" class="xl-btn xl-danger" data-act="remove" data-id="${id}" ${pending.has(student._id) ? "disabled" : ""} title="${escapeHtml(removeLabel)} student" aria-label="${escapeHtml(removeLabel)} ${escapeHtml(student.name)}">${removeIcon}</button>`;
    }

    function report() {
        if (!recordData || !selections) return null;
        return buildClassRecord({ ...recordData, students, selections, exams: selections, user, clusterId: key(clusterId) });
    }

    function resultsHtml() {
        let n = 0;
        hidden = 0; gap = false;
        const rn = () => { const mark = gap ? " xl-gap" : ""; gap = false; return `<th class="xl-rn${mark}" scope="row">${++n}</th>`; };
        let html = colgroup(RESULT_WIDTHS) + letters(11) + "<tbody>" + `<tr>${rn()}${"<td></td>".repeat(11)}<td class="xl-act"></td></tr>` +
            `<tr class="xl-tall">${rn()}<td class="xl-rhead"></td><td class="xl-rhead xl-bold">Name of Students</td><td class="xl-rhead xl-bold">Student ID</td>` +
            RESULT_HEADERS.map(label => `<td colspan="2" class="xl-rhead">${escapeHtml(label)}</td>`).join("") +
            `<td class="xl-rhead">RATING</td><td class="xl-rhead">REMARKS</td><td class="xl-act"></td></tr>`;
        let built = null;
        try { built = report(); } catch (error) { setStatus(error.message, true); }
        const layout = resultsLayout(sections(), built || { rows: [] });
        layout.forEach((section, sectionIndex) => {
            if (sectionIndex > 0 || section.gender === "OTHER") html += `<tr>${rn()}<td colspan="11" class="xl-sep">${section.gender === "OTHER" ? escapeHtml(section.label) : ""}</td><td class="xl-act"></td></tr>`;
            const total = section.gender && section.gender !== "OTHER" ? slotCount(section.rows.length) : section.rows.length;
            for (let index = 0; index < total; index++) {
                const row = section.rows[index];
                if (hideEmpty && !hasScores(row)) { n++; hidden++; gap = true; continue; }
                const result = row?.result;
                html += `<tr>${rn()}<td class="xl-green xl-num">${row ? index + 1 : ""}</td><td class="xl-green xl-left">${escapeHtml(row?.student.name || "")}</td>` +
                    `<td class="xl-green">${escapeHtml(row?.student.studentId || "")}</td>`;
                RECORD_SUBJECTS.forEach((subject, subjectIndex) => {
                    const attempt = result?.subjects?.[subjectIndex];
                    const raw = result?.percentages?.[subjectIndex] ?? null;
                    const overridden = attempt?.source === "override";
                    const hint = overridden ? `Typed score (scan: ${attempt.scanned == null ? "none" : plain(attempt.scanned)})` : attempt ? `From ${attempt.source === "scan" ? "a scan" : "the portal"}` : "";
                    const editable = row?.editable && selections && !resultsBusy;
                    html += `<td class="xl-cell xl-score${overridden ? " xl-override" : ""}"${hint ? ` title="${escapeHtml(hint)}"` : ""}>` +
                        (editable ? input(`R|${section.gender}|${index}|${subject}`, `score:${row.student._id}`, subject, plain(raw),
                            `${row.student.name} ${subject} raw score`, 'inputmode="decimal"') : plain(raw)) + "</td>" +
                        `<td class="xl-green xl-right">${fixed(result?.transmuted?.[subjectIndex])}</td>`;
                });
                const remark = result?.remark === "INCOMPLETE" ? "" : result?.remark || "";
                html += `<td class="xl-right">${fixed(result?.rating)}</td><td class="${remark === "FAILED" ? "xl-failed" : ""}">${remark}</td><td class="xl-act"></td></tr>`;
            }
        });
        return html + "</tbody>";
    }

    function render() {
        mount.querySelectorAll('[data-act="toggle-empty"]').forEach(button => {
            button.textContent = hideEmpty ? "Show all rows" : "Hide empty rows";
            button.setAttribute("aria-pressed", String(hideEmpty));
        });
        const active = document.activeElement;
        const focus = active && grid.contains(active) && active.dataset.pos ? { pos: active.dataset.pos, value: active.value,
            edited: active.value !== active.dataset.orig, start: active.selectionStart, end: active.selectionEnd } : null;
        rendering = true;
        grid.innerHTML = tab === "roster" ? rosterHtml() : resultsHtml();
        rendering = false;
        if (focus) {
            const target = grid.querySelector(`[data-pos="${CSS.escape(focus.pos)}"]`);
            if (target) {
                if (focus.edited) target.value = focus.value;
                target.focus();
                try { target.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
            }
        }
        if (tab === "roster" && loaded) {
            const count = sections().reduce((sum, section) => sum + section.students.length, 0);
            const unsaved = drafts.MALE.length + drafts.FEMALE.length;
            if (!statusLine.classList.contains("xl-error")) setStatus(`${count} student${count === 1 ? "" : "s"}${unsaved ? ` · ${unsaved} unsaved row${unsaved === 1 ? "" : "s"}` : ""}` +
                (hidden ? ` · ${hidden} empty row${hidden === 1 ? "" : "s"} hidden` : ""));
        }
    }

    // ─── Roster writes ────────────────────────────────────────────
    const byId = id => students.find(student => student._id === id);
    // Teachers write only their own (or ownerless) rows; admins manage every roster row.
    const writable = student => user.role === "admin" || !text(student.uploadedByUid) || student.uploadedByUid === user.uid;
    const ownRoster = () => sections().flatMap(section => section.students).filter(writable);
    const headerMeta = () => ({ ...rosterMeta(ownRoster(), user), ...metaDraft });

    async function commitBatches(updates) {
        for (let start = 0; start < updates.length; start += 450) {
            const batch = writeBatch(db);
            for (const [id, ...fields] of updates.slice(start, start + 450)) batch.update(doc(db, "students", id), ...fields);
            await batch.commit();
        }
    }

    async function commitMeta(cell) {
        if (cell.value === cell.dataset.orig) return;
        const field = cell.dataset.field, value = text(cell.value);
        const label = field === "instructor" ? "Instructor" : "School year";
        const targets = ownRoster().filter(student => text(student[field]) !== value);
        statusLine.classList.remove("xl-error");
        metaDraft[field] = value;
        try {
            await commitBatches(targets.map(student => [student._id, { [field]: value, updatedAt: serverTimestamp() }]));
            if (ownRoster().length) delete metaDraft[field];
            setStatus(targets.length ? `${label} saved for ${targets.length} student${targets.length === 1 ? "" : "s"}.` : `${label} will be saved with the students you add.`);
            if (targets.length) await logActivity(user, "UPDATE_ROSTER_HEADER", `Set roster ${label.toLowerCase()} to ${value}`, { entityType: "student", field, count: targets.length });
        } catch (error) {
            setStatus(`Could not save the ${label.toLowerCase()}: ${error.message}`, true);
        }
        render();
    }

    // Keeps results.<clusterId> on each roster row equal to what the RESULTS sheet shows.
    async function syncStoredResults() {
        const cluster = clusters?.find(item => key(item.id) === clusterId);
        let built = null;
        try { built = report(); } catch { return; }
        if (!cluster || !built || resultsBusy) return;
        if (syncing) { syncAgain = true; return; }
        syncing = true;
        try {
            const rows = new Map(built.rows.map(row => [row._id, row]));
            const path = `results.${key(cluster.id)}`;
            const updates = [];
            for (const student of students) {
                if (student.deletedAt != null || !writable(student)) continue;
                const row = rows.get(student._id);
                const stored = student.results?.[key(cluster.id)];
                if (row) {
                    const wanted = storedResult(row, cluster);
                    if (!sameStoredResult(stored, wanted)) updates.push([student._id, path, { ...wanted, updatedAt: serverTimestamp() }]);
                } else if (stored) updates.push([student._id, path, deleteField()]);
            }
            await commitBatches(updates);
            if (updates.length && !statusLine.classList.contains("xl-error")) setStatus(`Scores for ${cluster.name} saved to ${updates.length} student record${updates.length === 1 ? "" : "s"}.`);
        } catch (error) {
            setStatus(`Could not save scores to the roster: ${error.message}`, true);
        } finally {
            syncing = false;
            if (syncAgain) { syncAgain = false; syncStoredResults(); }
        }
    }
    const rowOf = element => [...element.closest("tr").querySelectorAll("input.xl-in")]
        .reduce((values, cell) => ({ ...values, [cell.dataset.field]: cell.value }), {});

    async function saveExisting(id, values) {
        const student = byId(id);
        if (!student) return;
        const merged = { ...student, ...values };
        const problem = rowProblem(merged, students, id);
        if (problem) { setStatus(problem, true); render(); return; }
        try {
            await updateDoc(doc(db, "students", id), { ...rosterUpdate(values), updatedAt: serverTimestamp() });
            setStatus("Saved.");
            await logActivity(user, "UPDATE_STUDENT", `Updated student: ${text(merged.name)}`, { entityType: "student", entityId: id, studentId: text(merged.studentId) });
        } catch (error) {
            setStatus(`Could not save ${text(merged.name)}: ${error.message}`, true);
            render();
        }
    }

    // Saves every complete draft in one batch; incomplete or conflicting drafts stay on screen.
    async function flushDrafts(gender) {
        const ready = [];
        for (const draft of drafts[gender]) {
            const complete = text(draft.name) && text(draft.studentId);
            draft.problem = complete ? rowProblem(draft, [...students, ...ready.map(item => item.draft)], null) : null;
            if (complete && !draft.problem) ready.push({ draft, data: newStudentRecord(draft, gender, user.uid, headerMeta()) });
        }
        drafts[gender] = drafts[gender].filter(draft => !ready.some(item => item.draft === draft));
        if (!ready.length) { render(); return; }
        try {
            for (let start = 0; start < ready.length; start += 450) {
                const batch = writeBatch(db);
                for (const { data } of ready.slice(start, start + 450)) {
                    batch.set(doc(collection(db, "students")), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
                }
                await batch.commit();
            }
            setStatus(`Added ${ready.length} student${ready.length === 1 ? "" : "s"}.`);
            await logActivity(user, "CREATE_STUDENT", ready.length === 1 ? `Added student: ${ready[0].data.name}` : `Added ${ready.length} students`, {
                entityType: "student", count: ready.length });
        } catch (error) {
            drafts[gender].unshift(...ready.map(item => item.draft));
            setStatus(`Could not add students: ${error.message}`, true);
        }
        render();
    }

    function editDraft(gender, index, values) {
        const list = drafts[gender];
        const slot = Math.min(index, list.length);
        if (!list[slot]) list[slot] = {};
        Object.assign(list[slot], values);
        if (ROSTER_FIELDS.every(field => !text(list[slot][field]))) list.splice(slot, 1);
    }

    async function commitRosterCell(cell) {
        if (cell.value === cell.dataset.orig) return;
        const [gender, index] = cell.dataset.pos.split("|");
        const rowKey = cell.dataset.key;
        statusLine.classList.remove("xl-error");
        if (rowKey.startsWith("id:")) return saveExisting(rowKey.slice(3), { [cell.dataset.field]: cell.value });
        editDraft(gender, Number(index) - sections().find(section => section.gender === gender).students.length, rowOf(cell));
        await flushDrafts(gender);
    }

    async function pasteRoster(cell, rows) {
        const [gender, startText, field] = cell.dataset.pos.split("|");
        const section = sections().find(item => item.gender === gender);
        const firstColumn = ROSTER_FIELDS.indexOf(field);
        const updates = [];
        rows.forEach((cells, offset) => {
            const values = Object.fromEntries(cells.slice(0, ROSTER_FIELDS.length - firstColumn)
                .map((value, column) => [ROSTER_FIELDS[firstColumn + column], value]));
            const index = Number(startText) + offset;
            const student = section.students[index];
            if (student) updates.push({ id: student._id, values });
            else if (gender) editDraft(gender, index - section.students.length, values);
        });
        statusLine.classList.remove("xl-error");
        for (const { id, values } of updates) await saveExisting(id, values);
        if (gender) await flushDrafts(gender); else render();
    }

    async function commitScoreCell(cell) {
        if (cell.value === cell.dataset.orig) return;
        const value = parseOverride(cell.value);
        if (value === undefined) { setStatus("Type a raw score from 0 to 100, or clear the cell.", true); cell.value = cell.dataset.orig; return; }
        const id = cell.dataset.key.slice("score:".length);
        const student = byId(id);
        if (!student) return;
        statusLine.classList.remove("xl-error");
        try {
            await updateDoc(doc(db, "students", id), `scoreOverrides.${key(clusterId)}.${cell.dataset.field}`,
                value === null ? deleteField() : value, "updatedAt", serverTimestamp());
            setStatus(value === null ? "Override cleared; the scanned score applies." : "Score saved.");
            await logActivity(user, "UPDATE_SCORE_OVERRIDE", `Set ${cell.dataset.field} score for ${student.name}`, {
                entityType: "student", entityId: id, clusterId: key(clusterId), subject: cell.dataset.field, score: value });
        } catch (error) {
            setStatus(`Could not save the score: ${error.message}`, true);
            render();
        }
    }

    // ─── Results data ─────────────────────────────────────────────
    async function loadClusters() {
        try {
            const source = user.role === "admin" ? collection(db, "exam_clusters")
                : query(collection(db, "exam_clusters"), where("uploadedByUid", "==", user.uid));
            clusters = (await getDocs(source)).docs.map(item => ({ ...item.data(), _id: item.id }))
                .filter(cluster => cluster.id != null && cluster.examIdsBySubject)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            clusterSelect.replaceChildren(new Option(clusters.length ? "Choose an exam cluster" : "No exam clusters yet", ""));
            for (const cluster of clusters) {
                clusterSelect.add(new Option(`${cluster.name}${cluster.schoolYear ? ` · SY ${cluster.schoolYear}` : ""}`, key(cluster.id)));
            }
            setStatus(clusters.length ? "Choose an exam cluster to fill in scores." : "Create an exam cluster in the mobile app to see results here.");
        } catch (error) {
            clusters = null;
            clusterSelect.replaceChildren(new Option("Could not load clusters", ""));
            setStatus(`Could not load exam clusters: ${error.message}`, true);
        }
    }

    async function loadResults() {
        const cluster = clusters?.find(item => key(item.id) === clusterId);
        recordData = null; selections = null;
        exportButton.disabled = true;
        if (!cluster) { render(); return; }
        resultsBusy = true;
        setStatus("Loading scores…");
        render();
        try {
            exams ??= (await getDocsFromServer(collection(db, "exams"))).docs.map(item => ({ ...item.data(), _id: item.id }))
                .filter(exam => exam.deletedAt == null);
            const owner = key(cluster.uploadedByUid);
            const chosen = RECORD_SUBJECTS.map(subject => {
                const wanted = key(cluster.examIdsBySubject[subject]);
                const matches = exams.filter(exam => (key(exam.id) === wanted || exam._id === wanted) &&
                    (!owner || [exam.uploadedByUid, exam.createdByUid].map(key).includes(owner)));
                if (matches.length !== 1) throw new Error(`The ${subject} exam in this cluster is missing or was deleted.`);
                return { ...matches[0], subject };
            });
            const data = await loadClassRecordData({ db, selections: chosen, user, api: { collection, query, where, getDocsFromServer } });
            if (clusterId !== key(cluster.id)) return;
            selections = chosen; recordData = data;
            exportButton.disabled = false;
            setStatus(`Scores for ${cluster.name}. ${report()?.warnings.join(" ") || ""}`.trim());
        } catch (error) {
            setStatus(`Could not load scores: ${error.message}`, true);
        } finally {
            resultsBusy = false;
            render();
        }
        syncStoredResults();
    }

    async function exportWorkbook() {
        const cluster = clusters?.find(item => key(item.id) === clusterId);
        const built = report();
        if (!cluster || !built) return;
        exportButton.disabled = true;
        try {
            if (!built.rows.length) throw new Error("No scores yet for this cluster.");
            const response = await fetch(templateUrl);
            if (!response.ok) throw new Error("The workbook template could not be loaded.");
            const bytes = await createClassWorkbook({ template: await response.arrayBuffer(), rows: built.rows, selections,
                clusterName: cluster.name, instructor: user.name || user.email, schoolYear: text(cluster.schoolYear) });
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const link = Object.assign(document.createElement("a"), { href: url,
                download: `PreBoard_Examination_Record_${cluster.name}`.replace(/[^a-z0-9_-]/gi, "_").slice(0, 150) + ".xlsx" });
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setStatus(`Exported ${built.rows.length} students.`);
            await logActivity(user, "EXPORT_CLASS_RECORD", "Exported Excel class record from Students", {
                operation: "READ", entityType: "examResult", clusterId: key(cluster.id), studentCount: built.rows.length });
        } catch (error) {
            setStatus(`Export failed: ${error.message}`, true);
        } finally {
            exportButton.disabled = false;
        }
    }

    // ─── Events ───────────────────────────────────────────────────
    function move(cell, rowStep, columnStep) {
        let target = null;
        if (rowStep) {
            const column = [...grid.querySelectorAll(`input.xl-in[data-field="${CSS.escape(cell.dataset.field)}"]`)];
            target = column[column.indexOf(cell) + rowStep];
        } else {
            const row = [...cell.closest("tr").querySelectorAll("input.xl-in")];
            target = row[row.indexOf(cell) + columnStep];
        }
        if (!target) return false;
        target.focus();
        target.select();
        return true;
    }

    grid.addEventListener("focusout", event => {
        const cell = event.target;
        if (rendering || !cell.matches?.("input.xl-in")) return;
        // Wait until focus has landed on the next cell so the re-render can restore it there.
        setTimeout(() => (cell.dataset.key.startsWith("score:") ? commitScoreCell(cell)
            : cell.dataset.key === "meta" ? commitMeta(cell) : commitRosterCell(cell)));
    });
    grid.addEventListener("keydown", event => {
        const cell = event.target;
        if (!cell.matches?.("input.xl-in")) return;
        const atStart = cell.selectionStart === 0 && cell.selectionEnd === 0;
        const atEnd = cell.selectionStart === cell.value.length;
        if (event.key === "Escape") { cell.value = cell.dataset.orig; cell.select(); }
        else if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (move(cell, event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1, 0)) event.preventDefault();
        } else if ((event.key === "ArrowLeft" && atStart) || (event.key === "ArrowRight" && atEnd)) {
            if (move(cell, 0, event.key === "ArrowLeft" ? -1 : 1)) event.preventDefault();
        }
    });
    grid.addEventListener("paste", event => {
        const cell = event.target;
        const pasted = event.clipboardData?.getData("text/plain") || "";
        if (tab !== "roster" || !cell.matches?.("input.xl-in") || !isGridPaste(pasted)) return;
        event.preventDefault();
        cell.value = cell.dataset.orig;   // the grid paste below replaces this cell too
        pasteRoster(cell, parseClipboardGrid(pasted));
    });
    grid.addEventListener("change", async event => {
        const select = event.target;
        if (!select.matches?.("select.xl-gender")) return;
        try {
            await updateDoc(doc(db, "students", select.dataset.id), { gender: select.value, updatedAt: serverTimestamp() });
            setStatus(`Moved to the ${select.value === "MALE" ? "male" : "female"} list.`);
        } catch (error) {
            setStatus(`Could not move the student: ${error.message}`, true);
            render();
        }
    });
    grid.addEventListener("click", async event => {
        const button = event.target.closest("button[data-act]");
        if (!button || button.disabled) return;
        if (button.dataset.act === "discard") {
            drafts[button.dataset.gender].splice(Number(button.dataset.index), 1);
            render();
            return;
        }
        const student = byId(button.dataset.id);
        if (!student || pending.has(student._id)) return;
        pending.add(student._id);
        render();
        try { await removeStudent(student); } finally { pending.delete(student._id); render(); }
    });
    mount.querySelector(".xl-tabs").addEventListener("click", event => {
        const button = event.target.closest("[data-tab]");
        if (!button || button.dataset.tab === tab) return;
        tab = button.dataset.tab;
        mount.querySelectorAll("[data-tab]").forEach(item => item.setAttribute("aria-selected", String(item === button)));
        mount.querySelectorAll(".xl-toolbar").forEach(item => item.classList.toggle("hidden", item.dataset.sheet !== tab));
        statusLine.classList.remove("xl-error");
        if (tab === "results" && clusters === null) loadClusters();
        else if (tab === "results") setStatus(clusterId ? "" : "Choose an exam cluster to fill in scores.");
        render();
    });
    // Live scores: re-read the cluster's results whenever the mobile app syncs a scan for it, so a
    // saved scan shows on the sheet (and is copied to the roster's results) without a reload.
    let stopScanWatch = null, scanReloadTimer = null;
    function watchClusterScans() {
        stopScanWatch?.();
        stopScanWatch = null;
        const cluster = clusters?.find(item => key(item.id) === clusterId);
        const owner = key(cluster?.uploadedByUid);
        if (!cluster || !owner) return;
        // By uploader, not clusterId: mobile cluster ids exceed 2^53 and can't be matched in a
        // web query (see loadClassRecordData). Filter to this cluster client-side instead.
        let initial = true;
        stopScanWatch = onSnapshot(query(collection(db, "scan_results"), where("uploadedByUid", "==", owner)), snapshot => {
            if (initial) { initial = false; return; }   // loadResults already read this state
            if (!(snapshot.docChanges?.() || []).some(change => key(change.doc.data().clusterId) === clusterId)) return;
            clearTimeout(scanReloadTimer);
            scanReloadTimer = setTimeout(loadResults, 800);   // one reload per burst of synced scans
        }, error => setStatus(`Live score updates stopped: ${error.message}. Use Reload scores.`, true));
    }
    mount.querySelectorAll('[data-act="toggle-empty"]').forEach(button => button.addEventListener("click", () => {
        hideEmpty = !hideEmpty;
        try { localStorage.setItem(HIDE_KEY, hideEmpty ? "1" : "0"); } catch { /* storage blocked */ }
        render();
        if (tab === "results" && !statusLine.classList.contains("xl-error")) {
            setStatus(hideEmpty ? `${hidden} row${hidden === 1 ? "" : "s"} without scores hidden.` : "Showing all rows.");
        }
    }));
    clusterSelect.addEventListener("change", () => { clusterId = clusterSelect.value; watchClusterScans(); loadResults(); });
    mount.querySelector('[data-act="reload"]').addEventListener("click", () => loadResults());
    exportButton.addEventListener("click", exportWorkbook);
    window.addEventListener("beforeunload", event => {
        if (drafts.MALE.length || drafts.FEMALE.length) event.preventDefault();
    });

    onSnapshot(collection(db, "students"), snapshot => {
        students = snapshot.docs.map(item => normalizeStudent({ ...item.data(), _id: item.id }));
        loaded = true;
        render();
        syncStoredResults();
    }, error => {
        setStatus(`Students could not be loaded: ${error.message}. Reload to retry.`, true);
        showToast("Students could not be loaded.", "error");
    });
    render();
}

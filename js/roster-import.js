// Student roster import shared by the admin and teacher Students pages.
// Mirrors the mobile RosterExcelParser and importRoster so both apps read the same files
// and write the same student fields.

const DEFAULT_PROGRAM = "Bachelor of Science in Electrical Engineering";
// Preboard students are 4th year; a Year column in the file overrides this.
const DEFAULT_YEAR_LEVEL = "4th Year";
const HEADER_SEARCH_ROWS = 20;

const text = value => String(value ?? "").trim();
const label = value => text(value).toLowerCase();

const isIdHeader = h => h === "id" || /student\s*(id|no|number)|id\s*(no|number)/.test(h);
const isNameHeader = h => h.includes("name");
const isBlockHeader = h => h.includes("block") || h.includes("sect");
const isEmailHeader = h => h.includes("email") || h.includes("e-mail");
const isProgramHeader = h => h.includes("program") || h.includes("course");
const isYearHeader = h => h.includes("year") && !h.includes("school");

/** Converts a SheetJS workbook to [{ name, rows }] with cell text as Excel displays it. */
export function workbookSheets(XLSX, workbook) {
    return workbook.SheetNames.map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" })
    }));
}

/**
 * Reads students from either layout:
 * - the PreBoard record template: title block, header row found by its "Student ID" cell,
 *   Name in the unlabeled column left of it, and MALE / FEMALE section rows;
 * - a flat sheet whose first row is Name, Student ID, Program, Year, Section headers.
 * RESULTS sheets are skipped: their rows are formulas copied from the roster sheet.
 */
export function parseRoster(sheets) {
    const students = [];
    const skipped = [];
    const seenIds = new Set();
    for (const sheet of sheets) {
        if (label(sheet.name).includes("result")) continue;
        const header = findHeader(sheet.rows);
        if (!header) continue;
        const meta = findMetadata(sheet.rows, header.rowIndex);
        let gender = sectionGender(sheet.rows[header.rowIndex]) || "";
        for (let r = header.rowIndex + 1; r < sheet.rows.length; r++) {
            const row = sheet.rows[r] || [];
            const section = sectionGender(row);
            if (section) { gender = section; continue; }
            const name = text(row[header.name]);
            const studentId = text(row[header.id]);
            if (!name && !studentId) continue;
            if (isNameHeader(label(name)) || isIdHeader(label(studentId))) continue;
            const where = `${sheet.name} row ${r + 1}`;
            if (!name || !studentId) {
                skipped.push({ name: name || studentId, where, reason: name ? "no Student ID" : "no name" });
                continue;
            }
            if (seenIds.has(studentId)) {
                skipped.push({ name, where, reason: `duplicate Student ID ${studentId}` });
                continue;
            }
            seenIds.add(studentId);
            const block = header.block >= 0 ? text(row[header.block]) : "";
            students.push({
                name,
                studentId,
                block,
                section: block,
                email: header.email >= 0 ? text(row[header.email]) : "",
                program: (header.program >= 0 && text(row[header.program])) || meta.program || DEFAULT_PROGRAM,
                yearLevel: (header.year >= 0 && text(row[header.year])) || DEFAULT_YEAR_LEVEL,
                gender,
                schoolYear: meta.schoolYear,
                instructor: meta.instructor
            });
        }
    }
    return { students, skipped };
}

function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, HEADER_SEARCH_ROWS); r++) {
        const labels = (rows[r] || []).map(label);
        const id = labels.findIndex(isIdHeader);
        if (id < 0) continue;
        const name = labels.findIndex(isNameHeader);
        return {
            rowIndex: r,
            id,
            // The template's Name column has no header; its cell holds the MALE/FEMALE label.
            name: name >= 0 ? name : Math.max(id - 1, 0),
            block: labels.findIndex(isBlockHeader),
            email: labels.findIndex(isEmailHeader),
            program: labels.findIndex(isProgramHeader),
            year: labels.findIndex(isYearHeader)
        };
    }
    return null;
}

// Program, Instructor and School Year are single cells directly below their labels, above the header row.
function findMetadata(rows, headerRowIndex) {
    const meta = { program: "", instructor: "", schoolYear: "" };
    for (let r = 0; r < headerRowIndex; r++) {
        (rows[r] || []).forEach((cell, c) => {
            const h = label(cell);
            const below = text(rows[r + 1]?.[c]);
            if (!meta.program && isProgramHeader(h)) meta.program = below;
            else if (!meta.instructor && h.includes("instructor")) meta.instructor = below;
            else if (!meta.schoolYear && (h.includes("school year") || h === "sy")) meta.schoolYear = below;
        });
    }
    return meta;
}

function sectionGender(row = []) {
    for (const cell of row) {
        const value = text(cell).toUpperCase();
        if (value === "MALE" || value === "FEMALE") return value;
    }
    return null;
}

/**
 * Upserts parsed students by Student ID, so re-importing a corrected file updates rows instead
 * of duplicating them. Matches only students this user uploaded or that have no owner.
 */
export async function importRoster({ db, api, students, uid, now = Date.now() }) {
    const { collection, doc, getDocs, writeBatch, serverTimestamp, deleteField } = api;
    const existing = await getDocs(collection(db, "students"));
    const byStudentId = new Map(existing.docs
        .filter(snapshot => { const owner = snapshot.data().uploadedByUid || ""; return !owner || owner === uid; })
        .map(snapshot => [text(snapshot.data().studentId), snapshot.ref]));

    const first = students[0] || {};
    const stamp = new Date(now).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    const importLabel = [first.program, first.schoolYear && `SY ${first.schoolYear}`].filter(Boolean).join(" · ") || "Roster";

    let created = 0;
    let updated = 0;
    let batch = writeBatch(db);
    let pending = 0;
    for (const student of students) {
        const existingRef = byStudentId.get(student.studentId);
        const ref = existingRef || doc(collection(db, "students"));
        const data = {
            ...student,
            uploadedByUid: uid,
            importId: now,
            importLabel: `${importLabel} · ${stamp}`,
            // Re-importing a trashed student restores them.
            deletedAt: deleteField(),
            updatedAt: serverTimestamp()
        };
        if (existingRef) updated++;
        else { created++; data.createdAt = serverTimestamp(); }
        batch.set(ref, data, { merge: true });
        // Firestore caps a batch at 500 writes.
        if (++pending >= 450) { await batch.commit(); batch = writeBatch(db); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    return { created, updated };
}

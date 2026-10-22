export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
}

export function normalizeStudent(student = {}) {
    return {
        ...student,
        name: String(student.name || student.studentName || student.fullName ||
            [student.firstName, student.lastName].filter(Boolean).join(" ") || ""),
        studentId: String(student.studentId ?? student.idNumber ?? ""),
        section: String(student.section || student.studentBlock || student.block || ""),
        yearLevel: String(student.yearLevel || student.studentYearLevel || ""),
        program: String(student.program || student.studentProgram || ""),
        email: String(student.email || "")
    };
}

export function filterStudents(students, search = "", year = "", hideArchived = false) {
    const term = String(search).trim().toLocaleLowerCase();
    return students.map(normalizeStudent).filter(student =>
        (!hideArchived || !student.isArchived) && (!year || student.yearLevel === year) &&
        (!term || student.name.toLocaleLowerCase().includes(term) || student.studentId.toLocaleLowerCase().includes(term))
    );
}

export function studentSnapshot(student) {
    const normalized = normalizeStudent(student);
    return Object.fromEntries(["name", "studentId", "section", "yearLevel", "program", "email"]
        .map(key => [key, normalized[key]]));
}

export function confirmStudentAction(student, action = "delete") {
    const previousFocus = document.activeElement;
    const deleting = action === "delete";
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.style.cssText = "padding:0;border:1px solid var(--border);color:var(--text-primary);max-width:440px;width:calc(100% - 32px);";
    dialog.setAttribute("aria-labelledby", "student-action-title");
    dialog.setAttribute("aria-describedby", "student-action-description");
    dialog.innerHTML = `<div class="modal-header"><h3 id="student-action-title"></h3></div>
        <div class="modal-body"><p id="student-action-description" style="overflow-wrap:anywhere;"></p></div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" autofocus>Cancel</button>
        <button type="button" class="btn ${deleting ? "btn-danger" : "btn-primary"}"></button></div>`;
    dialog.querySelector("h3").textContent = deleting ? "Delete student?" : "Archive student?";
    const details = normalizeStudent(student);
    dialog.querySelector("p").textContent = `${details.name || "Unnamed student"} (Student ID: ${details.studentId || student._id}). ` +
        (deleting ? "Remove this student from the roster? Saved results and their identity will be retained. This cannot be undone." :
            "Hide this student from the list and keep their records in the system.");
    const [cancel, confirm] = dialog.querySelectorAll("button");
    confirm.textContent = deleting ? "Delete student" : "Archive student";
    document.body.appendChild(dialog);
    return new Promise(resolve => {
        let confirmed = false;
        cancel.addEventListener("click", () => dialog.close());
        confirm.addEventListener("click", () => { confirmed = true; dialog.close(); });
        dialog.addEventListener("close", () => {
            dialog.remove();
            previousFocus?.focus();
            resolve(confirmed);
        }, { once: true });
        dialog.showModal();
        cancel.focus();
    });
}

export async function deleteStudentPreservingResults({ db, api, student }) {
    const { collection, doc, query, where, getDocFromServer, getDocsFromServer, writeBatch, serverTimestamp } = api;
    const studentRef = doc(db, "students", student._id);
    const current = await getDocFromServer(studentRef);
    if (!current.exists()) throw new Error("This student is no longer in the roster. Refresh the list.");
    const snapshot = studentSnapshot(current.data());
    const results = await getDocsFromServer(query(collection(db, "examResults"), where("studentDocId", "==", student._id)));
    const scoreDocs = results.docs.filter(result => result.data().recordType !== "rosterSnapshot");
    // Reserve two writes for the immutable identity record and roster deletion. Never split this batch.
    if (scoreDocs.length + 2 > 500) throw new Error("Student has too many results for a safe atomic deletion. No records were changed.");
    const batch = writeBatch(db);
    for (const result of scoreDocs) batch.update(result.ref, { studentSnapshot: snapshot });
    // A concurrent or offline score arriving after this query can still resolve its studentDocId.
    batch.set(doc(db, "examResults", `__student_snapshot__${student._id}`), {
        recordType: "rosterSnapshot", studentDocId: student._id,
        studentSnapshot: snapshot, rosterDeletedAt: serverTimestamp()
    });
    batch.delete(studentRef);
    await batch.commit();
    return snapshot;
}

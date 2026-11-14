// Firestore document IDs remain distinct from the numeric IDs used by Android.
export function legacyId(docId) {
    if (typeof docId !== "string" || !docId) throw new Error("Missing document ID.");
    let hash = 0;
    for (let i = 0; i < docId.length; i++) hash = (Math.imul(hash, 31) + docId.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

export function timestampMillis(value) {
    if (value == null) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function examSubject(exam) {
    if (exam.subject) return exam.subject;
    const name = (exam.examName || "").toLowerCase();
    if (name.includes("math")) return "Mathematics";
    if (name.includes("esas")) return "ESAS";
    if (name.includes("prof") || name.includes("ee")) return "Professional EE";
    return "Other";
}

export function isExamOwner(exam, user) {
    // UID metadata takes precedence over mutable email/Teacher-ID profile fields.
    const uid = exam.uploadedByUid || exam.createdByUid;
    if (uid) return Boolean(user.uid && uid === user.uid);
    return Boolean(user.email && [exam.createdByEmail, exam.createdBy, exam.uploaderEmail].includes(user.email));
}

export function examQuestionIds(exam, set = "A") {
    const ids = String(set).toUpperCase() === "B"
        ? (exam.setBQuestionIds ?? []) : (exam.setAQuestionIds ?? exam.questionIds ?? []);
    if (!Array.isArray(ids)) throw new Error(`Set ${set} question IDs must be an array.`);
    for (const id of ids) {
        if (!(typeof id === "string" && id.trim()) && !(typeof id === "number" && Number.isSafeInteger(id))) {
            throw new Error(`Set ${set} contains an invalid question reference.`);
        }
    }
    return ids;
}

export function questionId(question) {
    const raw = question.id ?? question._id ?? question.docId;
    if (typeof raw === "number" || (typeof raw === "string" && /^-?\d+$/.test(raw))) {
        const number = Number(raw);
        if (!Number.isSafeInteger(number)) throw new Error("Question ID exceeds browser integer precision; use its original document reference.");
        return number;
    }
    return legacyId(question._id || question.docId);
}

function questionReference(question) {
    const raw = question.id ?? question._id ?? question.docId;
    const numeric = typeof raw === "number" || (typeof raw === "string" && /^-?\d+$/.test(raw));
    if (numeric && Number.isInteger(Number(raw)) && !Number.isSafeInteger(Number(raw))) {
        // Android Long IDs cannot pass through a JavaScript number without losing precision.
        const docId = question._id || question.docId;
        if (typeof docId !== "string" || !docId.trim() || docId.includes("/")) {
            throw new Error("Question ID exceeds browser integer precision; its original document reference is required.");
        }
        return docId;
    }
    return questionId(question);
}

export function examBankIds(exam) {
    const ids = exam.selectedQuestionBankIds ?? exam.sessionIds ?? [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id || id.includes("/"))) {
        throw new Error("Invalid exam question bank IDs.");
    }
    return [...new Set(ids)];
}

export function resolveExamQuestions(exam, questions, set = "A") {
    const banks = examBankIds(exam);
    const pool = questions.filter(q => (!exam.subject || q.subject === exam.subject) &&
        (!banks.length || banks.includes(q._bankId || q.questionBankId)));
    return examQuestionIds(exam, set).map((id, index) => {
        // Legacy strings refer to exact Firestore document IDs before numeric fields.
        let matches = typeof id === "string"
            ? pool.filter(q => (q._id || q.docId) === id) : [];
        if (!matches.length) matches = pool.filter(q => {
            if (q.id != null && (typeof q.id !== "number" || Number.isSafeInteger(q.id)) && String(q.id) === String(id)) return true;
            try { return String(questionId(q)) === String(id); } catch { return false; }
        });
        if (matches.length !== 1) throw new Error(`Set ${set}, question ${index + 1}: ${matches.length ? "ambiguous" : "missing"} question reference ${id}.`);
        const question = matches[0];
        if (typeof question.questionText !== "string" || !question.questionText.trim()) {
            throw new Error(`Set ${set}, question ${index + 1}: question text is missing.`);
        }
        return question;
    });
}

export function buildExamPayload({ examName, subject, setA, setB, bankIds, user, now = Date.now(), id }) {
    if (!user.uid) throw new Error("Sign in before generating an exam.");
    const generatedId = id ?? now * 1024 + globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1024;
    if (!Number.isSafeInteger(generatedId) || generatedId <= 0) throw new Error("Invalid numeric exam ID.");
    // A question without an A–D key can never be scored, so it must not reach a saved exam.
    const unkeyed = [...setA, ...setB].find(question => !hasAnswerKey(question));
    if (unkeyed) {
        throw new Error(`${unkeyed.subject || subject} question ${unkeyed.questionNumber ?? questionId(unkeyed)} has no A, B, C or D answer key. ` +
            "Fix it in the Question Bank, then generate again.");
    }
    const a = setA.map(questionReference), b = setB.map(questionReference);
    const payload = {
        id: generatedId, examName, subject, setAQuestionIds: a, setBQuestionIds: b, questionIds: a,
        selectedQuestionBankIds: [...bankIds], sessionIds: [...bankIds], createdAt: now,
        uploadedByUid: user.uid, uploadedByTeacherId: user.teacherId || user.instructorId || "",
        createdByEmail: user.email || "", visibility: "private", questionCount: a.length
    };
    // Validate scope, collisions and both printed orders before persisting anything.
    const pool = [...new Map([...setA, ...setB].map(q => [`${q._bankId || q.questionBankId}/${q._id || q.docId || q.id}`, q])).values()];
    resolveExamQuestions(payload, pool, "A");
    resolveExamQuestions(payload, pool, "B");
    return payload;
}

const ANSWER_LETTER = /^(?:(?:OPTION|CHOICE|LETTER|ANSWER|ANS|KEY)\s*[:.\-]?\s*)?\(?([A-D])\)?[.:\-]?(?:\s.*)?$/s;

/**
 * Reads an answer key as A–D. Spreadsheets and older imports store it as "a", "A.", "(B)",
 * "Option C", "Answer: D", 1–4, or the option's own text; all mean the same letter.
 * Returns null when the value names no option. Must match ExamData.normalizeAnswer on mobile.
 */
export function normalizeAnswerKey(raw, options = []) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const byText = options.slice(0, 4).findIndex(option =>
        String(option ?? "").trim() && String(option).trim().toLowerCase() === value.toLowerCase());
    if (byText >= 0) return "ABCD"[byText];
    const letter = value.toUpperCase().match(ANSWER_LETTER);
    if (letter) return letter[1];
    return /^[1-4]$/.test(value) ? "ABCD"[Number(value) - 1] : null;
}

/** True when the question's stored key reads as one of the four answer-sheet bubbles. */
export function hasAnswerKey(question) {
    return normalizeAnswerKey(question?.correctAnswer,
        [question?.optionA, question?.optionB, question?.optionC, question?.optionD]) !== null;
}

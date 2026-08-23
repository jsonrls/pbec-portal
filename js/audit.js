// audit.js — Centralized transaction and activity logging
import { db } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const AUDIT_SESSION_KEY = "pbec_audit_session_id";
const SENSITIVE_KEYS = /password|passwordhash|token|secret|apikey|authorization|credential/i;

function getAuditSessionId() {
    let sessionId = sessionStorage.getItem(AUDIT_SESSION_KEY);
    if (!sessionId) {
        sessionId = crypto.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(AUDIT_SESSION_KEY, sessionId);
    }
    return sessionId;
}

function inferOperation(action) {
    const normalized = String(action || "").toUpperCase();
    if (normalized.includes("LOGIN") || normalized.includes("LOGOUT")) return "AUTH";
    if (/^(ADD|CREATE|GENERATE|IMPORT|UPLOAD|REGISTER)/.test(normalized)) return "CREATE";
    if (/^(DELETE|REMOVE|PURGE)/.test(normalized)) return "DELETE";
    if (/^(VIEW|READ|OPEN|EXPORT|DOWNLOAD)/.test(normalized)) return "READ";
    if (/^(UPDATE|EDIT|RENAME|APPROVE|ACTIVATE|DEACTIVATE|RESET|RESTORE|ARCHIVE)/.test(normalized)) return "UPDATE";
    return "OTHER";
}

function inferEntityType(action) {
    const normalized = String(action || "").toUpperCase();
    if (normalized.includes("STUDENT")) return "student";
    if (normalized.includes("QUESTION")) return "questionBank";
    if (normalized.includes("HANDOUT")) return "handout";
    if (normalized.includes("RESULT") || normalized.includes("SCORE")) return "examResult";
    if (normalized.includes("EXAM")) return "exam";
    if (normalized.includes("SETTING")) return "settings";
    if (normalized.includes("USER") || normalized.includes("ACCOUNT") || normalized.includes("PASSWORD")) return "user";
    if (normalized.includes("LOGIN") || normalized.includes("LOGOUT")) return "session";
    if (normalized.includes("PAGE")) return "page";
    return "system";
}

function sanitizeMetadata(value, depth = 0) {
    if (depth > 4 || value == null) return value ?? null;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeMetadata(item, depth + 1));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "function" || typeof value === "symbol") return null;
    if (typeof value !== "object") return value;
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (Object.getPrototypeOf(value) !== Object.prototype) return String(value);

    const clean = {};
    Object.entries(value).forEach(([key, item]) => {
        if (SENSITIVE_KEYS.test(key) || item === undefined) return;
        clean[key] = sanitizeMetadata(item, depth + 1);
    });
    return clean;
}

/**
 * Logs a system activity/audit event
 * @param {Object} user Current user object {uid, email, name, role}
 * @param {string} action Category/Action name (e.g. "UPLOAD_QUESTIONS")
 * @param {string} description Human readable details
 * @param {Object} metadata Optional extra data. Reserved fields:
 * operation, entityType, entityId, outcome.
 */
export async function logActivity(user, action, description, metadata = {}) {
    try {
        const {
            operation = inferOperation(action),
            entityType = inferEntityType(action),
            entityId = metadata.id || null,
            outcome = "success",
            ...details
        } = metadata;

        await addDoc(collection(db, "audit_logs"), {
            userId: user?.uid || user?.id || "unknown",
            userName: user?.name || user?.email || "Unknown user",
            userEmail: user?.email || null,
            userRole: user?.role || "unknown",
            action: String(action || "UNKNOWN"),
            operation,
            entityType,
            entityId,
            outcome,
            description: String(description || ""),
            metadata: sanitizeMetadata(details),
            sessionId: getAuditSessionId(),
            page: window.location.pathname,
            clientTimestamp: new Date().toISOString(),
            timestamp: serverTimestamp()
        });
    } catch (err) {
        console.error("Audit logging failed:", err);
    }
}

export function logPageView(user) {
    const pageName = document.title || window.location.pathname;
    return logActivity(user, "VIEW_PAGE", `Viewed ${pageName}`, {
        operation: "READ",
        entityType: "page",
        entityId: window.location.pathname
    });
}

export function clearAuditSession() {
    sessionStorage.removeItem(AUDIT_SESSION_KEY);
}

// audit.js — Activity logging utility
import { db } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/**
 * Logs a system activity/audit event
 * @param {Object} user Current user object {uid, email, name, role}
 * @param {string} action Category/Action name (e.g. "UPLOAD_QUESTIONS")
 * @param {string} description Human readable details
 * @param {Object} metadata Optional extra data (ids, names, counts)
 */
export async function logActivity(user, action, description, metadata = {}) {
    try {
        await addDoc(collection(db, "audit_logs"), {
            userId: user.uid || user.id,
            userName: user.name || user.email,
            userRole: user.role,
            action: action,
            description: description,
            metadata: metadata,
            timestamp: serverTimestamp()
        });
    } catch (err) {
        console.error("Audit logging failed:", err);
    }
}

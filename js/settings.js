// settings.js — Global system settings
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const DEFAULT_SETTINGS = {
    passingScore: 70,
    institutionName: "CATCI",
    schoolYear: "2025-2026"
};

export async function getSettings() {
    try {
        const snap = await getDoc(doc(db, "system", "settings"));
        if (snap.exists()) {
            return { ...DEFAULT_SETTINGS, ...snap.data() };
        }
        return DEFAULT_SETTINGS;
    } catch (err) {
        console.error("Failed to load settings:", err);
        return DEFAULT_SETTINGS;
    }
}

export async function updateSettings(newSettings) {
    try {
        await setDoc(doc(db, "system", "settings"), newSettings, { merge: true });
        return true;
    } catch (err) {
        console.error("Failed to update settings:", err);
        throw err;
    }
}

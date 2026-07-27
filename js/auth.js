// auth.js — Authentication logic
import { auth, db } from "./firebase-config.js";
import {
    signInWithEmailAndPassword,
    signInAnonymously,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { 
    doc, getDoc, setDoc, updateDoc, 
    serverTimestamp, collection, query, where, getDocs, limit 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const SESSION_KEY = "pbec_session";

function getLoginPath() {
    const pathPrefix = window.location.pathname.includes('/admin/') || window.location.pathname.includes('/teacher/') ? "../" : "";
    return pathPrefix + "index.html";
}

function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY); // Clear legacy persistent sessions.
}

function getStoredIdSession() {
    const session = sessionStorage.getItem(SESSION_KEY);
    if (!session) return null;

    try {
        const sessionData = JSON.parse(session);
        if (!sessionData?.isIdSession || !sessionData?.role) return null;
        return sessionData;
    } catch (e) {
        console.warn("Invalid stored session, clearing it.");
        clearSession();
        return null;
    }
}

function redirectToLogin() {
    clearSession();
    window.location.replace(getLoginPath());
}

// Security Helper: SHA-256 Hashing (matches mobile app implementation)
async function hashPassword(password) {
    const msgBuffer = new TextEncoder().encode(password.trim());
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function findUserByTeacherIdentifier(identifier) {
    const usersRef = collection(db, "users");
    const teacherIdQuery = query(usersRef, where("teacherId", "==", identifier), limit(1));
    const teacherIdSnap = await getDocs(teacherIdQuery);

    if (!teacherIdSnap.empty) {
        return teacherIdSnap.docs[0];
    }

    // Backward compatibility for mobile-created records that used instructorId.
    const instructorIdQuery = query(usersRef, where("instructorId", "==", identifier), limit(1));
    const instructorIdSnap = await getDocs(instructorIdQuery);
    return instructorIdSnap.empty ? null : instructorIdSnap.docs[0];
}

// Fetch user data/role
async function fetchUserRole(user) {
    if (!user) return null;
    console.log("Fetching role for user:", user.uid, "Anonymous:", user.isAnonymous);
    
    try {
        // 1. Teacher ID sessions use anonymous Firebase auth plus tab-scoped session data.
        if (user.isAnonymous) {
            const sessionData = getStoredIdSession();
            if (sessionData) {
                console.log("Found Teacher ID session:", sessionData.role);
                return sessionData;
            }
            console.warn("Anonymous Firebase user has no valid app session.");
            return null;
        }

        // 2. Try Firestore by UID (Standard Auth or Mobile-Registered with same session)
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (userDoc.exists()) {
            const data = userDoc.data();
            console.log("Found Firestore record by UID:", data.role);
            if (!data.email && user.email) {
                await updateDoc(doc(db, "users", user.uid), { email: user.email });
            }
            return { ...data, uid: user.uid };
        } 
        
        // 3. Auto-signup for new validated Email users (Admins or similar)
        if (!user.isAnonymous && user.email) {
            console.log("No record found, creating default teacher role for email user");
            const newData = {
                email: user.email,
                role: "teacher",
                status: "active",
                isActive: true,
                createdAt: serverTimestamp()
            };
            await setDoc(doc(db, "users", user.uid), newData);
            return { ...newData, uid: user.uid };
        }
        
        console.warn("No role found for user");
        return null;
    } catch (e) {
        console.error("Error fetching user role:", e);
        return null; 
    }
}

// Guard: redirect to login if not authenticated
export function requireAuth(expectedRole = null) {
    return new Promise((resolve) => {
        onAuthStateChanged(auth, async (user) => {
            console.log("Auth State Changed:", user ? "User present" : "No user");
            
            if (!user) {
                console.warn("No user, redirecting to login");
                redirectToLogin();
            } else {
                const userData = await fetchUserRole(user);
                
                if (!userData || !userData.role) {
                    console.warn("No user data/role, redirecting to login");
                    await signOut(auth).catch(() => {});
                    redirectToLogin();
                    return;
                }

                console.log("User role authenticated:", userData.role, "Expected:", expectedRole);

                // Authorization check
                if (expectedRole && userData.role !== expectedRole && userData.role !== "admin") {
                    console.warn("Unauthorized role, redirecting to appropriate dashboard");
                    const targetDashboard = userData.role === "admin" ? "../admin/dashboard.html" : "../teacher/dashboard.html";
                    window.location.replace(targetDashboard);
                    return;
                }

                document.body.classList.add('loaded');
                resolve(userData);
            }
        });
    });
}

// Guard: redirect for login page
export function redirectIfAuth() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userData = await fetchUserRole(user);
            if (userData && userData.role) {
                console.log("User already authenticated, redirecting to dashboard");
                // Ensure we use the correct relative path from the login page
                window.location.replace(`${userData.role}/dashboard.html`);
                return;
            }
        }
        document.body.classList.add('loaded');
    });
}

/**
 * Login function supporting both Email and Teacher ID
 */
export async function login(identifier, password) {
    const isEmail = identifier.includes("@");
    console.log("Login attempt with:", identifier, "IsEmail:", isEmail);
    
    if (isEmail) {
        // Standard Firebase Email Login
        const cred = await signInWithEmailAndPassword(auth, identifier, password);
        const userData = await fetchUserRole(cred.user);
        if (!userData) throw new Error("User record not found.");
        if (userData.status === "inactive" || userData.isActive === false) throw { code: "auth/account-inactive" };
        
        // Clear Teacher ID session to avoid conflicts
        clearSession();
        return userData.role || "teacher";
    } else {
        // Teacher ID Login
        console.log("Attempting Teacher ID lookup...");
        
        // We must have a session to query
        if (!auth.currentUser) {
            console.log("Starting anonymous session...");
            await signInAnonymously(auth);
        }

        const tid = identifier.trim().toUpperCase();
        const userDoc = await findUserByTeacherIdentifier(tid);
        
        if (!userDoc) {
            console.error("No user found with Teacher ID:", tid);
            throw { code: "auth/user-not-found" };
        }
        
        const userData = userDoc.data();
        console.log("Teacher record found:", userData.name);
        
        if (userData.status === "inactive" || userData.isActive === false) {
            throw { code: "auth/account-inactive" };
        }

        const inputHash = await hashPassword(password);
        if (!userData.passwordHash || userData.passwordHash.toLowerCase() !== inputHash.toLowerCase()) {
            console.error("Password mismatch");
            throw { code: "auth/wrong-password" };
        }
        
        // Persist session before returning
        const sessionPayload = { 
            ...userData, 
            uid: userDoc.id, 
            teacherId: userData.teacherId || userData.instructorId || tid,
            role: userData.role || "teacher", // Ensure role exists
            isIdSession: true 
        };
        console.log("Setting Teacher ID session payload...");
        clearSession();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionPayload));

        return sessionPayload.role;
    }
}

// Logout
export async function logout() {
    console.log("Logging out...");
    clearSession();
    await signOut(auth).catch((err) => console.warn("Firebase sign-out failed:", err));
    window.location.replace(getLoginPath());
}

export function getCurrentUser() {
    return auth.currentUser;
}

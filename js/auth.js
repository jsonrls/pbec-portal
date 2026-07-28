// auth.js — Authentication logic
import { auth, db } from "./firebase-config.js";
import { logActivity, logPageView, clearAuditSession } from "./audit.js";
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
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
let logoutDialogPromise = null;
let logoutFlowPromise = null;

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

function requestLogoutConfirmation() {
    if (logoutDialogPromise) return logoutDialogPromise;

    logoutDialogPromise = new Promise((resolve) => {
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const overlay = document.createElement("div");
        overlay.className = "logout-dialog-overlay";
        overlay.innerHTML = `
            <section class="logout-dialog" role="dialog" aria-modal="true"
                aria-labelledby="logout-dialog-title" aria-describedby="logout-dialog-description">
                <div class="logout-dialog-accent" aria-hidden="true"></div>
                <div class="logout-dialog-content">
                    <div class="logout-dialog-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path d="M10 17l5-5-5-5"></path>
                            <path d="M15 12H3"></path>
                            <path d="M21 4v16"></path>
                        </svg>
                    </div>
                    <div class="logout-dialog-copy">
                        <span class="logout-dialog-eyebrow">Secure session</span>
                        <h2 id="logout-dialog-title">Log out of PBEC?</h2>
                        <p id="logout-dialog-description">
                            You’ll need to sign in again to continue managing the workspace.
                        </p>
                    </div>
                </div>
                <div class="logout-dialog-actions">
                    <button class="btn btn-secondary" type="button" data-logout-cancel>
                        Stay signed in
                    </button>
                    <button class="btn btn-danger" type="button" data-logout-confirm>
                        <svg class="lucide" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M10 17l5-5-5-5"></path>
                            <path d="M15 12H3"></path>
                            <path d="M21 4v16"></path>
                        </svg>
                        Log out
                    </button>
                </div>
            </section>
        `;

        const cancelButton = overlay.querySelector("[data-logout-cancel]");
        const confirmButton = overlay.querySelector("[data-logout-confirm]");
        let isClosing = false;

        const finish = (confirmed) => {
            if (isClosing) return;
            isClosing = true;
            overlay.classList.add("is-closing");
            document.removeEventListener("keydown", handleKeydown);

            window.setTimeout(() => {
                overlay.remove();
                logoutDialogPromise = null;
                if (!confirmed && previouslyFocused?.isConnected) previouslyFocused.focus();
                resolve(confirmed);
            }, 160);
        };

        const handleKeydown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                finish(false);
                return;
            }

            if (event.key !== "Tab") return;
            const buttons = [cancelButton, confirmButton];
            const firstButton = buttons[0];
            const lastButton = buttons[buttons.length - 1];

            if (event.shiftKey && document.activeElement === firstButton) {
                event.preventDefault();
                lastButton.focus();
            } else if (!event.shiftKey && document.activeElement === lastButton) {
                event.preventDefault();
                firstButton.focus();
            }
        };

        cancelButton.addEventListener("click", () => finish(false));
        confirmButton.addEventListener("click", () => finish(true));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) finish(false);
        });
        document.addEventListener("keydown", handleKeydown);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            overlay.classList.add("is-visible");
            cancelButton.focus();
        });
    });

    return logoutDialogPromise;
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
                await logActivity({ ...data, uid: user.uid, email: user.email }, "UPDATE_USER_PROFILE", "Added the authenticated email to the user profile", {
                    entityType: "user",
                    entityId: user.uid
                });
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
            await logActivity({ ...newData, uid: user.uid }, "CREATE_USER_PROFILE", "Created a default portal user profile", {
                entityType: "user",
                entityId: user.uid
            });
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
                logPageView(userData);
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
        await logActivity(userData, "LOGIN_SUCCESS", "Signed in with email and password", {
            operation: "AUTH",
            entityType: "session",
            authMethod: "email"
        });
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
            await logActivity(
                { uid: auth.currentUser?.uid, name: tid, role: "unknown" },
                "LOGIN_FAILED",
                "Sign-in failed: Teacher ID not found",
                { operation: "AUTH", entityType: "session", outcome: "failed", authMethod: "teacherId" }
            );
            throw { code: "auth/user-not-found" };
        }
        
        const userData = userDoc.data();
        console.log("Teacher record found:", userData.name);
        
        if (userData.status === "inactive" || userData.isActive === false) {
            await logActivity(
                { ...userData, uid: userDoc.id },
                "LOGIN_FAILED",
                "Sign-in blocked: account inactive",
                { operation: "AUTH", entityType: "session", outcome: "blocked", authMethod: "teacherId" }
            );
            throw { code: "auth/account-inactive" };
        }

        const lockedUntil = userData.lockedUntil?.toMillis
            ? userData.lockedUntil.toMillis()
            : (userData.lockedUntil ? new Date(userData.lockedUntil).getTime() : 0);
        if (lockedUntil > Date.now()) {
            await logActivity(
                { ...userData, uid: userDoc.id },
                "LOGIN_FAILED",
                "Sign-in blocked: account temporarily locked",
                { operation: "AUTH", entityType: "session", outcome: "blocked", authMethod: "teacherId" }
            );
            throw { code: "auth/account-locked" };
        }

        const inputHash = await hashPassword(password);
        if (!userData.passwordHash || userData.passwordHash.toLowerCase() !== inputHash.toLowerCase()) {
            const failedLoginAttempts = Number(userData.failedLoginAttempts || 0) + 1;
            const failedUpdate = {
                failedLoginAttempts,
                lastFailedLoginAt: serverTimestamp()
            };
            if (failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
                failedUpdate.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
            }
            await updateDoc(userDoc.ref, failedUpdate).catch((err) => {
                console.warn("Could not record failed login:", err);
            });
            await logActivity(
                { ...userData, uid: userDoc.id },
                "LOGIN_FAILED",
                `Sign-in failed: incorrect password (${failedLoginAttempts}/${MAX_FAILED_ATTEMPTS})`,
                {
                    operation: "AUTH",
                    entityType: "session",
                    outcome: failedLoginAttempts >= MAX_FAILED_ATTEMPTS ? "blocked" : "failed",
                    authMethod: "teacherId",
                    failedLoginAttempts
                }
            );
            console.error("Password mismatch");
            throw { code: failedLoginAttempts >= MAX_FAILED_ATTEMPTS ? "auth/account-locked" : "auth/wrong-password" };
        }

        await updateDoc(userDoc.ref, {
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: serverTimestamp()
        }).catch((err) => console.warn("Could not update login status:", err));
        
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
        await logActivity(sessionPayload, "LOGIN_SUCCESS", "Signed in with Teacher ID", {
            operation: "AUTH",
            entityType: "session",
            authMethod: "teacherId"
        });

        return sessionPayload.role;
    }
}

// Logout
export function logout(options = {}) {
    if (logoutFlowPromise) return logoutFlowPromise;

    logoutFlowPromise = (async () => {
        const skipConfirmation = options?.skipConfirmation === true;
        if (!skipConfirmation && !(await requestLogoutConfirmation())) return false;

        console.log("Logging out...");
        const idSession = getStoredIdSession();
        let auditUser = idSession;
        if (!auditUser && auth.currentUser) {
            const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid)).catch(() => null);
            auditUser = userSnap?.exists()
                ? { ...userSnap.data(), uid: auth.currentUser.uid, email: auth.currentUser.email }
                : { uid: auth.currentUser.uid, email: auth.currentUser.email, role: "unknown" };
        }
        if (auditUser) {
            await logActivity(auditUser, "LOGOUT", "Signed out of the portal", {
                operation: "AUTH",
                entityType: "session"
            });
        }
        clearSession();
        clearAuditSession();
        await signOut(auth).catch((err) => console.warn("Firebase sign-out failed:", err));
        window.location.replace(getLoginPath());
        return true;
    })().finally(() => {
        logoutFlowPromise = null;
    });

    return logoutFlowPromise;
}

export function getCurrentUser() {
    return auth.currentUser;
}

// firebase-config.js — Firebase Web SDK initialization
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAVwY5T2OD5XaTu0ynNxgwZDrjPkJVL3rw",
  projectId: "boardexam-checker",
  storageBucket: "boardexam-checker.firebasestorage.app",
  messagingSenderId: "753372682881",
  appId: "1:753372682881:android:826fd8458bb11a58d68b80",
  authDomain: "boardexam-checker.firebaseapp.com"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Firebase's default upload retry window is long enough to look frozen when the
// bucket, billing plan, rules, or network is unavailable. Fail in a bounded time
// so the handout UI can explain the problem and let the admin retry.
storage.maxUploadRetryTime = 15_000;
storage.maxOperationRetryTime = 10_000;

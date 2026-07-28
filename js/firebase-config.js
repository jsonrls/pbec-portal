// firebase-config.js — Firebase Web SDK initialization
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

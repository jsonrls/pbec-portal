
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBwaLoDfISxU3JQvXSsako4F2fyVaGwCrY",
  authDomain: "preboardexam-checker.firebaseapp.com",
  projectId: "preboardexam-checker",
  storageBucket: "preboardexam-checker.firebasestorage.app",
  messagingSenderId: "239567967479",
  appId: "1:239567967479:android:2abbc4c3c6f141ebe5aff2"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function checkUsers() {
  const querySnapshot = await getDocs(collection(db, "users"));
  querySnapshot.forEach((doc) => {
    console.log(`${doc.id} => ${JSON.stringify(doc.data())}`);
  });
}

checkUsers();

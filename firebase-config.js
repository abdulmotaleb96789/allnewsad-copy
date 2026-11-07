/* =====================================================================
   All News BD – Firebase কনফিগারেশন
   ---------------------------------------------------------------------
   ১) নিচের firebaseConfig-এর মানগুলো আপনার Firebase প্রজেক্টের Web App থেকে নিয়ে বসান
      (Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration)।
   ২) এই মানগুলো (apiKey সহ) গোপন নয়, ব্রাউজারে থাকাই নিয়ম। আসল সুরক্ষা Firestore Security Rules ও
      Authentication-এ। Service Account Key বা Admin SDK-এর গোপন কী এখানে কখনো রাখবেন না।
   ৩) অ্যাপের বাকি সব কোড Firebase SDK এই ফাইল থেকেই নেয়, তাই SDK-এর ভার্সন শুধু এখানে বদলালেই হবে।
   ===================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-functions.js';

export const firebas

/* Cloud Functions যে Region-এ ডিপ্লয় হবে (functions/index.js-এর REGION-এর সঙ্গে মিলতে হবে) */
export const FUNCTIONS_REGION = 'us-central1';

/* কনফিগ বসানো হয়েছে কি না (প্লেসহোল্ডার থাকলে লগইন পেজ আগেই জানিয়ে দেবে) */
export const isConfigured = !Object.values(firebaseConfig).some((v) => String(v).includes('YOUR_'));

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, FUNCTIONS_REGION);

/* পেজ রিফ্রেশ বা ব্রাউজার বন্ধ করলেও লগইন সেশন থাকবে */
export const persistenceReady = setPersistence(auth, browserLocalPersistence).catch((e) => {
  console.warn('Auth persistence সেট করা যায়নি:', e);
});

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  query, where, orderBy, limit, serverTimestamp, Timestamp,
  httpsCallable,
};

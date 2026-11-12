import React, { useEffect, useState } from 'react';
import {
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider } from '../services/firebase';
import { AuthContext } from './auth-context';

/**
 * Asks the server whether this account is on the allowlist (GET /api/me). The server marks an
 * allowed account's sign-in token; the database and file rules require that mark, so the token is
 * refreshed when the mark is new.
 */
async function checkAccess(currentUser) {
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 403) return 'denied';
    if (!response.ok) throw new Error(`Access check failed: ${response.status}`);
    const data = await response.json();
    if (data.refresh_token) await currentUser.getIdToken(true);
    return 'allowed';
  } catch (err) {
    console.error('Could not check access:', err);
    // Offline or the server is restarting: an account already marked as allowed keeps working.
    try {
      const { claims } = await currentUser.getIdTokenResult();
      if (claims.allowed === true) return 'allowed';
    } catch {
      // fall through
    }
    return 'error';
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // 'allowed' | 'denied' (not on the allowlist) | 'error' (could not check). Only meaningful with a user.
  const [access, setAccess] = useState('allowed');
  const [checkCount, setCheckCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        setUser(null);
        setLoading(false);
        return;
      }
      // Nothing of the app is shown until the server has said whether this account may use it.
      setLoading(true);
      const result = await checkAccess(currentUser);
      if (cancelled || auth.currentUser?.uid !== currentUser.uid) return;
      setAccess(result);
      setUser(currentUser);
      setLoading(false);
      if (result !== 'allowed') return;
      // Ensure user document exists in Firestore
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        const snap = await getDoc(userDocRef);
        if (!snap.exists()) {
          await setDoc(userDocRef, {
            uid: currentUser.uid,
            email: currentUser.email || '',
            displayName: currentUser.displayName || 'User',
            photoURL: currentUser.photoURL || '',
            createdAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.warn('Could not sync user profile to Firestore:', err);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // checkCount: "Try again" on the could-not-check screen runs the check again.
  }, [checkCount]);

  const retryAccessCheck = () => setCheckCount((n) => n + 1);

  const signInWithGoogle = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      return result.user;
    } catch (error) {
      console.error('Google sign-in error:', error);
      throw error;
    }
  };

  const signOut = async () => {
    try {
      await fbSignOut(auth);
    } catch (error) {
      console.error('Sign-out error:', error);
      throw error;
    }
  };

  const value = {
    user,
    loading,
    access,
    retryAccessCheck,
    signInWithGoogle,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export default AuthProvider;

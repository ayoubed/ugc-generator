import { useContext } from 'react';
import { AuthContext } from '../context/auth-context';
import { AuthProvider } from '../context/AuthContext';

/**
 * Custom hook wrapping Firebase Auth state and methods
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export { AuthProvider };
export default useAuth;

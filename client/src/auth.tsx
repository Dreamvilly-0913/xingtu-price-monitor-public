import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, TOKEN_KEY } from './api';
import type { User } from './types';

interface AuthState { token: string | null; user: User | null; loading: boolean; login: (username: string, password: string) => Promise<User>; renewSession: (session: { token: string; user: User }) => void; logout: () => void }
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(null); setUser(null); setLoading(false); }
  function renewSession(session: { token: string; user: User }) { localStorage.setItem(TOKEN_KEY, session.token); setUser(session.user); setToken(session.token); setLoading(false); }
  useEffect(() => {
    window.addEventListener('xingtu-auth-expired', logout);
    return () => window.removeEventListener('xingtu-auth-expired', logout);
  }, []);
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    api<User>('/auth/me').then(account => { if (active) setUser(account); }).catch(() => { /* API 401 会通过统一事件清理会话。 */ }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);
  async function login(username: string, password: string) {
    const result = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    renewSession(result);
    return result.user;
  }
  return <AuthContext.Provider value={{ token, user, loading, login, renewSession, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const auth = useContext(AuthContext); if (!auth) throw new Error('会话上下文缺失'); return auth; }

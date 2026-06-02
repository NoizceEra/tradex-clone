import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import * as api from '../lib/api.js';

const AuthCtx = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthCtx);
}

export function AuthProvider({ children }) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // restore an existing session on load
  useEffect(() => {
    if (api.hasSession()) {
      api.authMe().then(setUser).catch(() => api.clearTokens());
    }
  }, []);

  const login = useCallback(async () => {
    if (!publicKey || !signMessage) throw new Error('Connect a wallet first');
    setLoading(true);
    setError(null);
    try {
      const pubkey = publicKey.toBase58();
      const { message } = await api.authNonce(pubkey);
      const sig = await signMessage(new TextEncoder().encode(message));
      const data = await api.authVerify({ pubkey, message, signature: bs58.encode(sig) });
      setUser(data.user);
      return data.user;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [publicKey, signMessage]);

  const logout = useCallback(async () => {
    await api.authLogout();
    setUser(null);
    try {
      await disconnect();
    } catch {
      /* noop */
    }
  }, [disconnect]);

  return (
    <AuthCtx.Provider
      value={{ user, login, logout, loading, error, walletConnected: connected, pubkey: publicKey?.toBase58() ?? null }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

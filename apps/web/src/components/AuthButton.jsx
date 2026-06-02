import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useAuth } from '../auth/AuthContext';

export function AuthButton() {
  const { user, login, logout, loading, walletConnected, pubkey } = useAuth();

  if (!walletConnected) return <WalletMultiButton />;

  if (!user) {
    return (
      <button className="btn-primary" disabled={loading} onClick={() => login().catch(() => {})}>
        {loading ? 'Signing…' : 'Sign In'}
      </button>
    );
  }

  return (
    <div className="auth-pill">
      <span className="auth-addr">
        {pubkey.slice(0, 4)}…{pubkey.slice(-4)}
      </span>
      <button className="btn-ghost" onClick={() => logout()}>
        Logout
      </button>
    </div>
  );
}

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { shortenPubkey } from '@pokex/pricing';
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
      <span className="auth-addr">{shortenPubkey(pubkey)}</span>
      <button className="btn-ghost" onClick={() => logout()}>
        Logout
      </button>
    </div>
  );
}

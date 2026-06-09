import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { shortenPubkey } from '@pokex/pricing';
import { useAuth } from '../auth/AuthContext';

export function AuthButton() {
  const { user, login, logout, loading, error, walletConnected, pubkey } = useAuth();

  if (!walletConnected) return <WalletMultiButton />;

  if (!user) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
        <button className="btn-primary" disabled={loading} onClick={() => login().catch(() => {})}>
          {loading ? 'Signing…' : 'Sign In'}
        </button>
        {error && (
          <div style={{ fontSize: '12px', color: '#ff6b6b', maxWidth: '200px', textAlign: 'right' }}>
            {error}
          </div>
        )}
      </div>
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

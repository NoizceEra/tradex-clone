import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';

export function FaucetButton({ onFunded, className = 'btn-ghost' }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.faucet(10_000);
          onFunded?.();
        } catch (e) {
          alert(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : '+ $10k Faucet'}
    </button>
  );
}

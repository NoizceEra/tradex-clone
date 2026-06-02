import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { subscribe, onMessage } from '../lib/ws';

export function Toasts() {
  const { user } = useAuth();
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!user) return;
    subscribe([`liquidations:${user.id}`, `orders:${user.id}`]);
    const push = (text, kind) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    };
    return onMessage((msg) => {
      if (msg.type === 'liquidation') push('⚠ Position liquidated', 'down');
    });
  }, [user]);

  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

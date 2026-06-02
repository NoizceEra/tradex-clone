import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { subscribe, unsubscribe, onMessage, authenticate } from '../lib/ws';

export function Toasts() {
  const { user } = useAuth();
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!user) return;
    const chans = [`liquidations:${user.id}`]; // (no 'orders:' channel is ever published)
    authenticate(); // make sure the socket is auth'd for this user's private channel
    subscribe(chans);
    const push = (text, kind) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    };
    const off = onMessage((msg) => {
      if (msg.type === 'liquidation') push('⚠ Position liquidated', 'down');
    });
    return () => {
      off();
      unsubscribe(chans); // drop the prior user's channel on logout / account switch
    };
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

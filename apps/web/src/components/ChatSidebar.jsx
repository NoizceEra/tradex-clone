import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useChat } from '../store/chat';

const PALETTE = ['#f0c040', '#3fb950', '#58a6ff', '#e74c3c', '#bc8cff', '#f78166', '#39d3bb'];
function colorFor(handle) {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ChatSidebar({ open, onToggle }) {
  const { user } = useAuth();
  const messages = useChat((s) => s.messages);
  const markRead = useChat((s) => s.markRead);
  const send = useChat((s) => s.send);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  // while the rail is open, keep unread cleared (incl. for messages arriving live)
  useEffect(() => {
    if (open) markRead();
  }, [open, messages, markRead]);

  // pin to the latest message
  useEffect(() => {
    const el = listRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const onSend = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await send(body);
      setText('');
    } catch {
      /* keep it simple; surfaced via disabled state */
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null; // the navbar "Chat" button is the reopen control

  return (
    <aside className="chat-sidebar">
      <div className="chat-header">
        <span className="chat-title">▣ Live Chat</span>
        <button className="chat-collapse" onClick={onToggle} title="Hide chat" aria-label="Hide chat">◀</button>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">No messages yet.<br />Say hi 👋</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-msg">
              <span className="chat-avatar" style={{ background: colorFor(m.handle) }}>{m.handle[0]?.toUpperCase()}</span>
              <div className="chat-msg-main">
                <div className="chat-msg-head">
                  <span className="chat-handle" style={{ color: colorFor(m.handle) }}>{m.handle}</span>
                  <span className="chat-time">{fmtTime(m.createdAt)}</span>
                </div>
                <div className="chat-text">{m.body}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat-input">
        {user ? (
          <>
            <input
              type="text"
              value={text}
              maxLength={280}
              placeholder="Message…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
            />
            <button className="btn-primary sm" disabled={busy || !text.trim()} onClick={onSend}>{busy ? '…' : 'Send'}</button>
          </>
        ) : (
          <div className="chat-signin">Connect &amp; sign in to chat.</div>
        )}
      </div>
    </aside>
  );
}

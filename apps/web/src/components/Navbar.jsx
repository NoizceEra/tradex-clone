import { AuthButton } from './AuthButton';
import { useChat } from '../store/chat';

const NAV = [
  ['trade', 'Exchange'],
  ['markets', 'Markets'],
  ['pool', 'Pool'],
  ['leaderboard', 'Leaderboard'],
  ['portfolio', 'Portfolio'],
];

export function Navbar({ activeView, setActiveView, chatOpen, onToggleChat }) {
  const unread = useChat((s) => s.unread);
  return (
    <nav className="navbar">
      <div className="nav-left">
        <div className="nav-brand">
          <img src="/pokeball.png" alt="" style={{ width: 22, height: 22 }} />
          <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>PokeX</span>
        </div>
        <button
          className={`chat-toggle ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          title={chatOpen ? 'Hide chat' : 'Open chat'}
        >
          💬 Chat
          {!chatOpen && unread > 0 && <span className="chat-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </div>

      <div className="nav-links">
        {NAV.map(([v, label]) => (
          <button key={v} className={`nav-link ${activeView === v ? 'active' : ''}`} onClick={() => setActiveView(v)}>
            {label}
          </button>
        ))}
      </div>

      <div className="nav-actions">
        <AuthButton />
      </div>
    </nav>
  );
}

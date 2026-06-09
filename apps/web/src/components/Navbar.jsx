import { AuthButton } from './AuthButton';
import { ThemePicker } from './ThemePicker';
import { useChat } from '../store/chat';

const NAV = [
  ['trade', 'Exchange'],
  ['markets', 'Markets'],
  ['pool', 'Pool'],
  ['leaderboard', 'Leaderboard'],
  ['portfolio', 'Portfolio'],
  ['debug', '🔧 Debug'],
];

export function Navbar({ activeView, setActiveView, chatOpen, onToggleChat }) {
  const unread = useChat((s) => s.unread);
  return (
    <nav className="navbar">
      <div className="nav-left">
        <div className="nav-brand">
          <img src="/GachaDexPFP2.png" alt="" />
          <img className="nav-wordmark" src="/GachaDexWords.png" alt="Gachadex" />
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
        <a
          href="https://x.com/gachadexcards"
          target="_blank"
          rel="noopener noreferrer"
          title="Follow on Twitter/X"
          className="nav-social-link"
          style={{ fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          𝕏
        </a>
        <ThemePicker />
        <AuthButton />
      </div>
    </nav>
  );
}

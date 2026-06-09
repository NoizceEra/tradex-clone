import { AuthButton } from './AuthButton';
import { ThemePicker } from './ThemePicker';
import { NetworkIndicator } from './NetworkIndicator';
import { useChat } from '../store/chat';

const NAV = [
  ['home', 'Home'],
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
        <button type="button" className="nav-brand" onClick={() => setActiveView('home')} title="Back to home">
          <img src="/GachaDexPFP2.png" alt="" />
          <img className="nav-wordmark" src="/GachaDexWords.png" alt="Gachadex" />
        </button>
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
        <NetworkIndicator />
        <ThemePicker />
        <AuthButton />
      </div>
    </nav>
  );
}

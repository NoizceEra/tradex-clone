import { AuthButton } from './AuthButton';

const NAV = [
  ['trade', 'Exchange'],
  ['markets', 'Markets'],
  ['portfolio', 'Portfolio'],
  ['pool', 'Pool'],
  ['leaderboard', 'Leaderboard'],
];

export function Navbar({ activeView, setActiveView }) {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <img src="/pokeball.png" alt="" style={{ width: 22, height: 22 }} />
        <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>PokeX</span>
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

import { useNavigate } from 'react-router-dom';
import { ThemePicker } from '../components/ThemePicker';
import { AuthButton } from '../components/AuthButton';
import '../styles/landing.css';

export function Landing() {
  const navigate = useNavigate();

  return (
    <div className="landing-container">
      <nav className="landing-navbar">
        <div className="nav-left">
          <div className="nav-brand">
            <img src="/GachaDexPFP2.png" alt="" />
            <img className="nav-wordmark" src="/GachaDexWords.png" alt="Gachadex" />
          </div>
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

      <main className="landing-main">
        <section className="hero-section">
          <div className="hero-content">
            <h1 className="hero-title">Welcome to GachaDex</h1>
            <p className="hero-subtitle">
              The Premier Pokémon Card Perpetual Futures DEX
            </p>
            <p className="hero-description">
              Trade perpetual futures on collectible cards across multiple universes.
              Starting with Pokémon, expanding to One Piece, Magic The Gathering, and more.
            </p>
            <button className="cta-button" onClick={() => navigate('/exchange')}>
              ▶ ENTER EXCHANGE
            </button>
          </div>
        </section>

        <section className="features-section">
          <h2 className="section-title">KEY FEATURES</h2>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon">🃏</div>
              <h3>Card Futures</h3>
              <p>Trade perpetual contracts on Pokémon card prices with zero slippage</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🌍</div>
              <h3>Multi-Universe</h3>
              <p>Trade Pokémon, One Piece, Magic, and more collectible universes</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">⚡</div>
              <h3>Instant Execution</h3>
              <p>Lightning-fast order execution powered by Solana</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📊</div>
              <h3>Real-Time Charts</h3>
              <p>Live price charts and market data at your fingertips</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🏆</div>
              <h3>Leaderboard</h3>
              <p>Compete with other traders and climb the rankings</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🎨</div>
              <h3>Multiple Themes</h3>
              <p>Customize your experience with retro and modern themes</p>
            </div>
          </div>
        </section>

        <section className="how-it-works-section">
          <h2 className="section-title">HOW IT WORKS</h2>
          <div className="steps-container">
            <div className="step">
              <div className="step-number">1</div>
              <h3>Connect Wallet</h3>
              <p>Link your Solana wallet to get started</p>
            </div>
            <div className="step">
              <div className="step-number">2</div>
              <h3>Fund Account</h3>
              <p>Deposit funds to start trading real markets</p>
            </div>
            <div className="step">
              <div className="step-number">3</div>
              <h3>Select Cards</h3>
              <p>Choose Pokémon cards to trade futures on</p>
            </div>
            <div className="step">
              <div className="step-number">4</div>
              <h3>Trade & Compete</h3>
              <p>Buy and sell futures, manage your portfolio, climb the leaderboard</p>
            </div>
          </div>
        </section>

        <section className="cta-section">
          <h2>Ready to Start Trading?</h2>
          <button className="cta-button-large" onClick={() => navigate('/exchange')}>
            ▶ LAUNCH EXCHANGE
          </button>
        </section>

        <footer className="landing-footer">
          <p>GachaDex • Collectible Card Perpetual Futures on Solana</p>
          <p className="footer-links">
            <a href="https://x.com/gachadexcards" target="_blank" rel="noopener noreferrer">
              Twitter
            </a>
            {' • '}
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}

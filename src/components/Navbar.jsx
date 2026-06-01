import React from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function Navbar({ activeView, setActiveView }) {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <div style={{ width: 24, height: 24, background: 'var(--accent)', borderRadius: '50%' }}></div>
        TradeX
      </div>
      
      <div className="nav-links">
        <a 
          href="#" 
          className={`nav-link ${activeView === 'trade' ? 'active' : ''}`}
          onClick={(e) => { e.preventDefault(); setActiveView('trade'); }}
        >
          Trade
        </a>
        <a 
          href="#" 
          className={`nav-link ${activeView === 'browse' ? 'active' : ''}`}
          onClick={(e) => { e.preventDefault(); setActiveView('browse'); }}
        >
          Browse Cards
        </a>
        <a href="#" className="nav-link">Portfolio</a>
      </div>
      
      <div className="nav-actions">
        <WalletMultiButton className="btn-primary" />
      </div>
    </nav>
  );
}

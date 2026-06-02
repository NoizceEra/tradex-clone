import React from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function Navbar({ activeView, setActiveView }) {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <div style={{ width: 24, height: 24, background: 'var(--accent)', borderRadius: '4px' }}></div>
        <span style={{ fontWeight: 'bold', fontSize: '1.25rem' }}>PokeX</span>
      </div>
      
      <div className="nav-links">
        <button 
          className={`nav-link ${activeView === 'trade' ? 'active' : ''}`}
          onClick={() => setActiveView('trade')}
        >
          Exchange
        </button>
        <button 
          className={`nav-link ${activeView === 'browse' ? 'active' : ''}`}
          onClick={() => setActiveView('browse')}
        >
          Marketplace
        </button>
        <a href="#" className="nav-link">Account</a>
      </div>
      
      <div className="nav-actions">
        <WalletMultiButton className="btn-primary" />
      </div>
    </nav>
  );
}

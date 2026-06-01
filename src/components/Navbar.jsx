import React from 'react';

export function Navbar() {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        {/* Placeholder for Logo */}
        <div style={{ width: 24, height: 24, background: 'var(--accent)', borderRadius: '50%' }}></div>
        TradeX
      </div>
      
      <div className="nav-links">
        <a href="#" className="nav-link active">Trade</a>
        <a href="#" className="nav-link">Browse Cards</a>
        <a href="#" className="nav-link">Portfolio</a>
      </div>
      
      <div className="nav-actions">
        <button className="btn-primary">Connect Wallet</button>
      </div>
    </nav>
  );
}

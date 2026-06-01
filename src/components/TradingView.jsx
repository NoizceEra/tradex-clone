import React from 'react';

export function TradingView() {
  return (
    <div className="main-column">
      {/* Ticker Header */}
      <div className="glass-panel ticker-header">
        <div className="ticker-title">
          <h1>
            <span style={{ fontSize: '1.8rem' }}>🔥</span> 
            Charizard Base Set
          </h1>
        </div>
        
        <div className="ticker-stat">
          <span className="stat-label">Oracle Price</span>
          <span className="stat-val text-green">$350.50</span>
        </div>
        
        <div className="ticker-stat">
          <span className="stat-label">24h Change</span>
          <span className="stat-val text-green">+5.24%</span>
        </div>
        
        <div className="ticker-stat">
          <span className="stat-label">Funding Rate</span>
          <span className="stat-val">0.012%</span>
        </div>
        
        <div className="ticker-stat">
          <span className="stat-label">24h Vol</span>
          <span className="stat-val">$1.2M</span>
        </div>
      </div>

      {/* Chart Area */}
      <div className="glass-panel chart-container">
        <div className="chart-placeholder">
          TradingView Chart Integration Placeholder
        </div>
      </div>
    </div>
  );
}

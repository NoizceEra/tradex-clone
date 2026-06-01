import React from 'react';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';

export function TradingView({ selectedCard }) {
  // Fallback defaults if no card is selected yet
  const name = selectedCard ? selectedCard.name : 'Charizard Base Set';
  const price = selectedCard ? (
    selectedCard.tcgplayer?.prices?.holofoil?.market ||
    selectedCard.tcgplayer?.prices?.normal?.market ||
    selectedCard.tcgplayer?.prices?.1stEditionHolofoil?.market ||
    350.50
  ) : 350.50;
  
  const symbol = selectedCard && selectedCard.id === 'base1-4' ? 'BINANCE:SOLUSD' : 'BINANCE:BTCUSD'; // Just mock symbols for chart since TradingView doesn't have Pokemon TCG pairs

  return (
    <div className="main-column">
      {/* Ticker Header */}
      <div className="glass-panel ticker-header">
        <div className="ticker-title">
          <h1>
            {selectedCard && selectedCard.images && (
              <img src={selectedCard.images.small} alt="card" style={{ height: '40px', borderRadius: '4px' }} />
            )}
            {!selectedCard && <span style={{ fontSize: '1.8rem' }}>🔥</span>}
            {name}
          </h1>
        </div>
        
        <div className="ticker-stat">
          <span className="stat-label">Oracle Price</span>
          <span className="stat-val text-green">${price.toFixed(2)}</span>
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
      <div className="glass-panel chart-container" style={{ padding: 0, overflow: 'hidden' }}>
        <AdvancedRealTimeChart 
          theme="dark"
          symbol={symbol}
          autosize
          allow_symbol_change={false}
          hide_side_toolbar={false}
        />
      </div>
    </div>
  );
}

import React, { useState } from 'react';

export function OrderEntry() {
  const [position, setPosition] = useState('long');
  const [leverage, setLeverage] = useState(10);
  
  return (
    <div className="glass-panel order-entry">
      <div className="order-tabs">
        <button 
          className={`order-tab long ${position === 'long' ? 'active' : ''}`}
          onClick={() => setPosition('long')}
        >
          Long
        </button>
        <button 
          className={`order-tab short ${position === 'short' ? 'active' : ''}`}
          onClick={() => setPosition('short')}
        >
          Short
        </button>
      </div>

      <div className="input-group">
        <label>
          <span>Pay</span>
          <span>Balance: 0.00 USDC</span>
        </label>
        <div className="input-wrapper">
          <input type="number" placeholder="0.00" />
          <span className="input-suffix">USDC</span>
        </div>
      </div>

      <div className="input-group">
        <label>
          <span>Size</span>
        </label>
        <div className="input-wrapper">
          <input type="number" placeholder="0.00" />
          <span className="input-suffix">USD</span>
        </div>
      </div>

      <div className="input-group">
        <label>
          <span>Leverage</span>
          <span>{leverage}x</span>
        </label>
        <input 
          type="range" 
          min="1" 
          max="20" 
          value={leverage} 
          onChange={(e) => setLeverage(e.target.value)}
          className="leverage-slider"
        />
      </div>

      <div className="order-summary">
        <div className="summary-row">
          <span className="label">Entry Price</span>
          <span>$350.50</span>
        </div>
        <div className="summary-row">
          <span className="label">Liq. Price</span>
          <span>$0.00</span>
        </div>
        <div className="summary-row">
          <span className="label">Fees</span>
          <span>0.10%</span>
        </div>
      </div>

      <button className={`btn-submit ${position}`}>
        {position === 'long' ? 'Go Long' : 'Go Short'}
      </button>
    </div>
  );
}

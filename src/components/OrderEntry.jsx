import React, { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function OrderEntry({ selectedCard }) {
  const [position, setPosition] = useState('buy');
  
  const entryPrice = selectedCard ? (
    selectedCard.tcgplayer?.prices?.holofoil?.market ||
    selectedCard.tcgplayer?.prices?.normal?.market ||
    selectedCard.tcgplayer?.prices?.['1stEditionHolofoil']?.market ||
    0
  ) : 0;
  
  return (
    <div className="right-column">
      <div className="card-image-container glass-panel">
        {selectedCard ? (
          <img src={selectedCard.images.large} alt={selectedCard.name} className="large-card-img" />
        ) : (
          <div className="card-placeholder">Select a Card</div>
        )}
      </div>

      <div className="glass-panel order-entry">
        
        <div className="order-tabs">
          <button 
            className={`order-tab long ${position === 'buy' ? 'active' : ''}`}
            onClick={() => setPosition('buy')}
          >
            Buy
          </button>
          <button 
            className={`order-tab short ${position === 'sell' ? 'active' : ''}`}
            onClick={() => setPosition('sell')}
          >
            Sell
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



        <div className="order-summary">
          <div className="summary-row">
            <span className="label">Entry Price</span>
            <span>${entryPrice.toFixed(2)}</span>
          </div>

        </div>
        
        <div className="wallet-connect-wrapper">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}

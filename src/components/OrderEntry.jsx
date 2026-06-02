import React, { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

const getPrice = (card) => {
  if (!card) return 0;
  const p = card.tcgplayer?.prices;
  if (!p) return 0;
  return p.holofoil?.market || p.normal?.market || p['1stEditionHolofoil']?.market || 0;
};

export function OrderEntry({ selectedCard }) {
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('');

  const price = getPrice(selectedCard);
  const usdTotal = amount && price ? (parseFloat(amount) * price).toFixed(2) : '0.00';
  const cardQty = amount && price ? parseFloat(amount) : 0;

  return (
    <div className="order-panel">

      {/* Card Preview */}
      <div className="card-preview">
        {selectedCard ? (
          <img
            src={selectedCard.images.large}
            alt={selectedCard.name}
            className="preview-img"
          />
        ) : (
          <div className="card-placeholder">Select a card<br />from the market</div>
        )}
        {selectedCard && (
          <div className="preview-label">{selectedCard.name} #{selectedCard.number}</div>
        )}
      </div>

      {/* Order Form */}
      <div className="order-form">

        {/* Buy / Sell Toggle */}
        <div className="order-side-toggle">
          <button
            className={`side-btn buy ${side === 'buy' ? 'active' : ''}`}
            onClick={() => setSide('buy')}
          >
            BUY
          </button>
          <button
            className={`side-btn sell ${side === 'sell' ? 'active' : ''}`}
            onClick={() => setSide('sell')}
          >
            SELL
          </button>
        </div>

        {/* Amount Input */}
        <div className="form-field">
          <label className="field-label">
            <span>AMOUNT (USDC)</span>
            <span className="field-hint">Balance: 0.00</span>
          </label>
          <div className="field-input-wrap">
            <input
              type="number"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <span className="field-unit">USDC</span>
          </div>
        </div>

        {/* Summary */}
        <div className="order-info-box">
          <div className="order-info-row">
            <span>Market Price</span>
            <span>{price > 0 ? `$${price.toFixed(2)}` : '—'}</span>
          </div>
          <div className="order-info-row">
            <span>Est. Cards</span>
            <span>{price > 0 && amount ? (parseFloat(amount) / price).toFixed(4) : '—'}</span>
          </div>
          <div className="order-info-row total">
            <span>Total</span>
            <span>${usdTotal}</span>
          </div>
        </div>

        {/* Wallet Button */}
        <div className="wallet-wrap">
          <WalletMultiButton />
        </div>

        {/* Place Order */}
        <button
          className={`place-order-btn ${side}`}
          disabled={!selectedCard || !amount}
        >
          {side === 'buy' ? '▶ BUY' : '▶ SELL'} {selectedCard ? selectedCard.name.toUpperCase() : '—'}
        </button>

      </div>
    </div>
  );
}

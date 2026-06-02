import React, { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

const getPrice = (card) => {
  if (!card) return 0;
  const p = card.tcgplayer?.prices;
  if (!p) return 0;
  return p.holofoil?.market || p.normal?.market || p['1stEditionHolofoil']?.market || 0;
};

export function OrderEntry({ selectedCard, portfolio, executeTrade, supplementalData }) {
  const [modalCard, setModalCard] = React.useState(null);
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('');

  const price = getPrice(selectedCard);
  const usdTotal = amount && price ? (parseFloat(amount) * price).toFixed(2) : '0.00';
  const cardQty = amount && price ? parseFloat(amount) : 0;

  return (
    <div className="order-panel">

      {/* Card Preview */}
      <div className="card-preview" onClick={() => selectedCard && setModalCard(selectedCard)} style={{cursor: selectedCard ? 'pointer' : 'default'}}>
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

        {supplementalData?.tcgdex && (
          <div className="mechanics-panel" style={{fontSize: '0.45rem', padding: '0.75rem', background: 'var(--bg-2)', border: '1px solid var(--border)', width: '100%', marginTop: '0.5rem', textAlign: 'left'}}>
            <div style={{color:'var(--gold)', marginBottom:'0.4rem', textTransform: 'uppercase'}}>Stats & Mechanics</div>
            <div style={{display:'flex', justifyContent:'space-between', color: 'var(--text-muted)'}}>
              <span>HP: <strong style={{color:'var(--text)'}}>{supplementalData.tcgdex.hp || 'N/A'}</strong></span>
              <span>Retreat: <strong style={{color:'var(--text)'}}>{supplementalData.tcgdex.retreat || '0'}</strong></span>
            </div>
            {supplementalData.tcgdex.attacks?.map((atk, i) => (
              <div key={i} style={{marginTop: '0.4rem', color: 'var(--text-muted)'}}>
                <strong style={{color:'var(--text)'}}>{atk.name}</strong> {atk.damage ? `(${atk.damage})` : ''}
              </div>
            ))}
          </div>
        )}

        {supplementalData?.justTcg && (
          <div className="mechanics-panel" style={{fontSize: '0.45rem', padding: '0.75rem', background: 'var(--bg-2)', border: '1px solid var(--border)', width: '100%', marginTop: '0.5rem', textAlign: 'left'}}>
            <div style={{color:'var(--gold)', marginBottom:'0.4rem', textTransform: 'uppercase'}}>JustTCG Market Info</div>
            <div style={{color: 'var(--text-muted)'}}>
              Live graded pricing data retrieved.
            </div>
            {(() => {
              const justData = Array.isArray(supplementalData.justTcg) 
                ? supplementalData.justTcg[0] 
                : supplementalData.justTcg?.data 
                  ? supplementalData.justTcg.data[0] 
                  : supplementalData.justTcg;
              
              if (justData && justData.prices) {
                return (
                  <div style={{marginTop: '0.4rem'}}>
                    {Object.entries(justData.prices).slice(0, 3).map(([key, val]) => (
                      <div key={key} style={{display:'flex', justifyContent:'space-between'}}>
                        <span>{key}</span><strong style={{color:'var(--success)'}}>${val}</strong>
                      </div>
                    ))}
                  </div>
                );
              } else if (justData) {
                return <div style={{marginTop:'0.4rem'}}>Pricing structure varied.</div>;
              }
              return null;
            })()}
          </div>
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
            <span>QUANTITY (CARDS)</span>
            <span className="field-hint">Balance: ${portfolio ? portfolio.balance.toFixed(2) : '0.00'}</span>
          </label>
          <div className="field-input-wrap">
            <input
              type="number"
              min="0"
              placeholder="0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <span className="field-unit">QTY</span>
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
            <span>{amount ? parseFloat(amount).toFixed(2) : '—'}</span>
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
            disabled={!selectedCard || !amount || parseFloat(amount) <= 0}
            onClick={() => {
              executeTrade(selectedCard, side, parseFloat(amount), price);
              setAmount('');
            }}
          >
            {side === 'buy' ? '▶ BUY' : '▶ SELL'} {selectedCard ? selectedCard.name.toUpperCase() : '—'}
          </button>
          {modalCard && (
            <div className="modal" onClick={() => setModalCard(null)}>
              <div className="modal-content" onClick={e => e.stopPropagation()}>
                <img src={modalCard.images.large} alt={modalCard.name} style={{maxWidth:'80vw',maxHeight:'80vh'}} />
                <h3 style={{marginTop:'0.5rem',color:'var(--text)'}}>{modalCard.name} #{modalCard.number}</h3>
                <p style={{color:'var(--text-muted)'}}>Set: {modalCard.set?.name}</p>
                <p style={{color:'var(--text)'}}>Price: ${getPrice(modalCard).toFixed(2)}</p>
                <button onClick={() => setModalCard(null)} style={{marginTop:'0.5rem',padding:'0.4rem 0.8rem',background:'var(--bg-3)',border:'1px solid var(--border)',color:'var(--text)',cursor:'pointer'}}>Close</button>
              </div>
            </div>
          )}

      </div>
    </div>
  );
}

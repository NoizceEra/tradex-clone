import React, { useState } from 'react';

const getPrice = (card) => {
  if (!card) return 0;
  const p = card.tcgplayer?.prices;
  if (!p) return 0;
  return p.holofoil?.market || p.normal?.market || p['1stEditionHolofoil']?.market || 0;
};

const getSet = (card) => card?.set?.name || '';

export function SidebarMarkets({ cards, loading, selectedCard, onSelectCard, collapsed, setCollapsed, portfolio }) {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('markets');

  const filtered = cards.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header" style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0.5rem 0.75rem'}}>
        <span style={{fontSize:'0.6rem',color:'var(--text)'}}>Markets</span>
        <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)} style={{background:'none',border:'none',color:'var(--text-muted)',fontSize:'0.8rem',cursor:'pointer'}}>
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab-btn ${tab === 'markets' ? 'active' : ''}`}
          onClick={() => setTab('markets')}
        >
          Markets
        </button>
        <button
          className={`sidebar-tab-btn ${tab === 'positions' ? 'active' : ''}`}
          onClick={() => setTab('positions')}
        >
          Positions
        </button>
      </div>

      {/* Search */}
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Column Headers */}
      <div className="sidebar-col-headers">
        <span>#</span>
        <span>CARD</span>
        <span>PRICE</span>
      </div>

      {/* List */}
      <div className="market-list">
        {loading && (
          <div className="loading-pixel" style={{ padding: '2rem' }}>
            <span /><span /><span />
          </div>
        )}
        {tab === 'positions' && !loading && (
          (!portfolio || Object.keys(portfolio.positions).length === 0) ? (
            <div className="empty-state">No open positions.<br />Buy cards to begin.</div>
          ) : (
            Object.values(portfolio.positions).map((pos, idx) => {
              const card = pos.card;
              const price = getPrice(card);
              const isActive = selectedCard?.id === card.id;
              
              return (
                <div
                  key={card.id}
                  className={`market-item ${isActive ? 'selected' : ''}`}
                  onClick={() => onSelectCard(card)}
                >
                  <div className="market-item-left">
                    <span className="market-index" style={{fontSize:'0.4rem',color:'var(--text-muted)',marginRight:'0.3rem'}}>{idx + 1}.</span>
                    <img src={card.images.small} alt={card.name} className="market-thumb" />
                    <div className="market-item-info">
                      <span className="market-item-name">{card.name}</span>
                      <span className="market-item-set">Qty: {pos.amount}</span>
                    </div>
                  </div>
                  <div className="market-item-right">
                    <span className="market-item-price">${(pos.amount * price).toFixed(2)}</span>
                    <span className="market-item-change" style={{color: 'var(--text-muted)'}}>
                      Avg: ${pos.avgPrice.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })
          )
        )}
        {tab === 'markets' && filtered.map((card, idx) => {
          const price = getPrice(card);
          const isActive = selectedCard?.id === card.id;
          // Deterministic fake 24h change from card ID
          const seed = card.id.charCodeAt(0) + card.id.charCodeAt(1);
          const change = ((seed % 20) - 8) * 0.3;
          const changeUp = change >= 0;

          return (
            <div
              key={card.id}
              className={`market-item ${isActive ? 'selected' : ''}`}
              onClick={() => onSelectCard(card)}
            >
              <div className="market-item-left">
                <span className="market-index" style={{fontSize:'0.4rem',color:'var(--text-muted)',marginRight:'0.3rem'}}>{idx + 1}.</span>
                <img src={card.images.small} alt={card.name} className="market-thumb" />
                <div className="market-item-info">
                  <span className="market-item-name">{card.name}</span>
                  <span className="market-item-set">{getSet(card)} #{card.number}</span>
                </div>
              </div>
              <div className="market-item-right">
                <span className="market-item-price">${price.toFixed(2)}</span>
                <span className={`market-item-change ${changeUp ? 'up' : 'down'}`}>
                  {changeUp ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

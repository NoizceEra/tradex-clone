import React from 'react';

export function SidebarMarkets({ cards, loading, selectedCard, onSelectCard }) {
  return (
    <div className="sidebar-markets">
      <div className="sidebar-tabs">
        <span className="sidebar-tab active">Top Markets</span>
        <span className="sidebar-tab">My Positions</span>
      </div>
      
      <div className="sidebar-header">
        <span>Market</span>
        <span>Price</span>
      </div>

      <div className="market-list">
        {loading && <div style={{ padding: '1rem', color: 'var(--text-muted)' }}>Loading...</div>}
        
        {cards.map(card => {
          const price = card.tcgplayer?.prices?.holofoil?.market 
            || card.tcgplayer?.prices?.normal?.market 
            || card.tcgplayer?.prices?.['1stEditionHolofoil']?.market
            || 0;
            
          const isActive = selectedCard?.id === card.id;
          
          return (
            <div 
              key={card.id} 
              className={`market-item ${isActive ? 'active' : ''}`} 
              onClick={() => onSelectCard(card)}
            >
              <div className="market-item-left">
                <span className="market-name">{card.name} - {card.number}</span>
                <span className="market-vol">{(price * 400).toFixed(0)}</span>
              </div>
              <div className="market-item-right">
                <span className="market-price">${price.toFixed(2)}</span>
                <span className="market-change text-green">+1.01%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

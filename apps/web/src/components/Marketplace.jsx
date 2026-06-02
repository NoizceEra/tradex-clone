import { useState, useEffect, useCallback } from 'react';
import { getCardPrice } from '@pokex/pricing';

const CARDS_PER_PAGE = 8; // 4 per side, 2 pages visible

export function Marketplace({ cards, loading, onTradeCard }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const [flipDir, setFlipDir] = useState('next');

  const filtered = cards.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / CARDS_PER_PAGE);
  const pageCards = filtered.slice(page * CARDS_PER_PAGE, (page + 1) * CARDS_PER_PAGE);
  // Pad to 8 slots
  const slots = [...pageCards, ...Array(CARDS_PER_PAGE - pageCards.length).fill(null)];

  const navigate = useCallback((dir) => {
    if (flipping) return;
    if (dir === 'next' && page >= totalPages - 1) return;
    if (dir === 'prev' && page <= 0) return;
    setFlipDir(dir);
    setFlipping(true);
    setTimeout(() => {
      setPage(p => dir === 'next' ? p + 1 : p - 1);
      setFlipping(false);
    }, 280);
  }, [flipping, page, totalPages]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight') navigate('next');
      if (e.key === 'ArrowLeft')  navigate('prev');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  // (page reset happens in the search input's onChange)

  // Returns 0 when unavailable; rendered as 'N/A' below.
  const getPrice = (card) => getCardPrice(card);

  return (
    <div className="marketplace-view">
      <div className="binder-chrome">

        {/* Controls */}
        <div className="binder-controls">
          <button
            className="binder-nav-btn"
            onClick={() => navigate('prev')}
            disabled={page === 0 || flipping}
          >◀ PREV</button>

          <input
            type="text"
            placeholder="Search cards..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
          />

          <span className="binder-page-info">
            PAGE {page + 1} / {Math.max(totalPages, 1)}
          </span>

          <button
            className="binder-nav-btn"
            onClick={() => navigate('next')}
            disabled={page >= totalPages - 1 || flipping}
          >NEXT ▶</button>
        </div>

        {/* Binder Book */}
        <div className="binder-book">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
              <div className="loading-pixel">
                <span /><span /><span />
              </div>
            </div>
          ) : (
            <div
              className={`binder-page ${flipping ? (flipDir === 'next' ? 'binder-flip-exit' : 'binder-flip-enter') : 'binder-flip-enter'}`}
            >
              {slots.map((card, i) => (
                <div key={card ? card.id : `empty-${i}`} className="binder-slot">
                  {card ? (
                    <>
                      <img src={card.images.small} alt={card.name} />
                      <div className="binder-slot-overlay">
                        <span className="slot-name">{card.name}</span>
                        <span className="slot-price">
                          {getPrice(card) != null ? `$${getPrice(card).toFixed(2)}` : 'N/A'}
                        </span>
                        <button
                          className="slot-trade-btn"
                          onClick={(e) => { e.stopPropagation(); onTradeCard(card); }}
                        >
                          ▶ TRADE
                        </button>
                      </div>
                    </>
                  ) : (
                    <span className="binder-slot-empty">· · ·</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

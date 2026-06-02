import { useState, useEffect, useCallback } from 'react';
import { formatUsd } from '@pokex/pricing';

const CARDS_PER_PAGE = 8;

export function Marketplace({ markets, loading, onTradeMarket }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const [flipDir, setFlipDir] = useState('next');

  const cards = (markets || []).filter((m) => m.kind === 'card');
  const filtered = cards.filter((c) => c.displayName.toLowerCase().includes(search.toLowerCase()));
  const totalPages = Math.ceil(filtered.length / CARDS_PER_PAGE);
  const pageCards = filtered.slice(page * CARDS_PER_PAGE, (page + 1) * CARDS_PER_PAGE);
  const slots = [...pageCards, ...Array(Math.max(0, CARDS_PER_PAGE - pageCards.length)).fill(null)];

  const navigate = useCallback(
    (dir) => {
      if (flipping) return;
      if (dir === 'next' && page >= totalPages - 1) return;
      if (dir === 'prev' && page <= 0) return;
      setFlipDir(dir);
      setFlipping(true);
      setTimeout(() => {
        setPage((p) => (dir === 'next' ? p + 1 : p - 1));
        setFlipping(false);
      }, 280);
    },
    [flipping, page, totalPages],
  );

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight') navigate('next');
      if (e.key === 'ArrowLeft') navigate('prev');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return (
    <div className="marketplace-view">
      <div className="binder-chrome">
        <div className="binder-controls">
          <button className="binder-nav-btn" onClick={() => navigate('prev')} disabled={page === 0 || flipping}>◀ PREV</button>
          <input type="text" placeholder="Search cards..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
          <span className="binder-page-info">PAGE {page + 1} / {Math.max(totalPages, 1)}</span>
          <button className="binder-nav-btn" onClick={() => navigate('next')} disabled={page >= totalPages - 1 || flipping}>NEXT ▶</button>
        </div>

        <div className="binder-book">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
              <div className="loading-pixel"><span /><span /><span /></div>
            </div>
          ) : (
            <div className={`binder-page ${flipping ? (flipDir === 'next' ? 'binder-flip-exit' : 'binder-flip-enter') : 'binder-flip-enter'}`}>
              {slots.map((m, i) => (
                <div key={m ? m.id : `empty-${i}`} className="binder-slot">
                  {m ? (
                    <>
                      {m.imageSmall ? <img src={m.imageSmall} alt={m.displayName} /> : <div className="binder-idx">📈</div>}
                      <div className="binder-slot-overlay">
                        <span className="slot-name">{m.displayName}</span>
                        <span className="slot-price">{m.markE6 ? formatUsd(BigInt(m.markE6)) : 'N/A'}</span>
                        <button className="slot-trade-btn" onClick={(e) => { e.stopPropagation(); onTradeMarket(m); }}>▶ TRADE</button>
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

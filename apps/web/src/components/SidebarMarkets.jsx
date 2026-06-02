import { useState, useEffect } from 'react';
import { formatUsd } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import { useAuth } from '../auth/AuthContext';
import * as api from '../lib/api.js';

const TABS = ['indices', 'cards', 'positions'];

export function SidebarMarkets({ markets, loading, selected, onSelect, collapsed, setCollapsed }) {
  const [tab, setTab] = useState('cards');
  const [search, setSearch] = useState('');
  const marks = useRealtime((s) => s.marks);
  const { user } = useAuth();
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    if (tab !== 'positions' || !user) return;
    let alive = true;
    const load = () => api.getPositions().then((r) => alive && setPositions(r.positions)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab, user]);

  const livePrice = (m) => marks[m.id]?.markE6 ?? m.markE6;
  const cards = markets.filter((m) => m.kind === 'card');
  const indices = markets.filter((m) => m.kind === 'index');
  const list = (tab === 'indices' ? indices : tab === 'cards' ? cards : []).filter((m) =>
    m.displayName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem' }}>
        <span style={{ fontSize: '0.6rem', color: 'var(--text)' }}>Markets</span>
        <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      <div className="sidebar-tabs">
        {TABS.map((t) => (
          <button key={t} className={`sidebar-tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab !== 'positions' && (
        <div className="sidebar-search">
          <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}

      <div className="sidebar-col-headers">
        <span>#</span>
        <span>{tab === 'indices' ? 'INDEX' : tab === 'cards' ? 'CARD' : 'POSITION'}</span>
        <span>{tab === 'positions' ? 'uPnL' : 'PRICE'}</span>
      </div>

      <div className="market-list">
        {loading && (
          <div className="loading-pixel" style={{ padding: '2rem' }}>
            <span /><span /><span />
          </div>
        )}

        {tab === 'positions' &&
          !loading &&
          (!user ? (
            <div className="empty-state">Sign in to see your positions.</div>
          ) : positions.length === 0 ? (
            <div className="empty-state">No open positions.<br />Place a trade to begin.</div>
          ) : (
            positions.map((p, i) => {
              const m = markets.find((mm) => mm.id === p.marketId);
              const up = BigInt(p.unrealizedPnlUusdc) >= 0n;
              return (
                <div key={p.id} className={`market-item ${selected?.id === p.marketId ? 'selected' : ''}`} onClick={() => m && onSelect(m)}>
                  <div className="market-item-left">
                    <span className="market-index">{i + 1}.</span>
                    {m?.imageSmall ? <img src={m.imageSmall} alt="" className="market-thumb" /> : <span className="market-thumb idx-thumb">IDX</span>}
                    <div className="market-item-info">
                      <span className="market-item-name">{p.symbol}</span>
                      <span className="market-item-set">{p.side.toUpperCase()} {p.leverage}x</span>
                    </div>
                  </div>
                  <div className="market-item-right">
                    <span className="market-item-price">{formatUsd(BigInt(p.markE6))}</span>
                    <span className={`market-item-change ${up ? 'up' : 'down'}`}>
                      {up ? '+' : ''}
                      {formatUsd(BigInt(p.unrealizedPnlUusdc))}
                    </span>
                  </div>
                </div>
              );
            })
          ))}

        {tab !== 'positions' &&
          list.map((m, i) => {
            const ch = m.change24hPct || 0;
            const up = ch >= 0;
            const price = livePrice(m);
            return (
              <div
                key={m.id}
                className={`market-item ${selected?.id === m.id ? 'selected' : ''} ${m.tradeable ? '' : 'market-item-disabled'}`}
                onClick={() => onSelect(m)}
                title={m.tradeable ? '' : 'Data source pending'}
              >
                <div className="market-item-left">
                  <span className="market-index">{i + 1}.</span>
                  {m.imageSmall ? <img src={m.imageSmall} alt="" className="market-thumb" /> : <span className="market-thumb idx-thumb">IDX</span>}
                  <div className="market-item-info">
                    <span className="market-item-name">{m.displayName}</span>
                    <span className="market-item-set">
                      {m.kind === 'card' && m.setLogo ? (
                        <img src={m.setLogo} alt="" className="set-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      ) : m.kind === 'index' ? (
                        m.tradeable ? `Index · ${m.maxLeverage}x` : 'Soon'
                      ) : (
                        m.symbol
                      )}
                    </span>
                  </div>
                </div>
                <div className="market-item-right">
                  <span className="market-item-price">{price ? formatUsd(BigInt(price)) : '—'}</span>
                  <span className={`market-item-change ${up ? 'up' : 'down'}`}>
                    {up ? '▲' : '▼'} {Math.abs(ch).toFixed(2)}%
                  </span>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

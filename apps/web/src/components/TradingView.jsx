import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, AreaSeries } from 'lightweight-charts';
import { getCardPrice as getPrice } from '@pokex/pricing';

const TIMEFRAMES = ['1D', '1W', '1M', '3M', '1Y'];

export function TradingView({ selectedCard }) {
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [activeTimeframe, setActiveTimeframe] = useState('1M');
  const [bottomTab, setBottomTab] = useState('activity');

  const name = selectedCard ? selectedCard.name : '—';
  const cardNum = selectedCard ? `#${selectedCard.number}` : '';
  const setName = selectedCard?.set?.name || '';
  const price = getPrice(selectedCard);

  // Deterministic change
  const seed = selectedCard ? (selectedCard.id.charCodeAt(0) + selectedCard.id.charCodeAt(1)) : 10;
  const change = ((seed % 20) - 8) * 0.3;
  const changeUp = change >= 0;

  // Init chart once
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#111418' },
        textColor: '#8b949e',
        fontFamily: "'Press Start 2P', monospace",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true },
      crosshair: { mode: 1 },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: '#f0c040',
      topColor: 'rgba(240,192,64,0.25)',
      bottomColor: 'rgba(240,192,64,0.0)',
      lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // Update data when card or timeframe changes
  useEffect(() => {
    if (!seriesRef.current || !selectedCard || price === 0) return;

    const days = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }[activeTimeframe] || 30;
    const mockData = [];
    let cur = price * 0.75;
    const today = new Date();

    for (let i = days; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const change = (Math.random() - 0.44) * (price * 0.04);
      cur = Math.max(cur + change, price * 0.1);
      if (i === 0) cur = price;
      mockData.push({ time: d.toISOString().split('T')[0], value: parseFloat(cur.toFixed(2)) });
    }

    // Deduplicate timestamps
    const seen = new Set();
    const unique = mockData.filter(d => {
      if (seen.has(d.time)) return false;
      seen.add(d.time);
      return true;
    });

    seriesRef.current.setData(unique);
    chartRef.current?.timeScale().fitContent();
  }, [selectedCard, price, activeTimeframe]);

  return (
    <div className="trading-center">

      {/* ── Card Header ── */}
      <div className="card-header-bar">
        <div className="card-header-left">
          {selectedCard && (
            <img
              src={selectedCard.images.small}
              alt={name}
              className="header-card-thumb"
            />
          )}
          <div className="card-header-meta">
            <div className="card-header-name">{name} {cardNum}</div>
            <div className="card-header-set">{setName}</div>
          </div>
        </div>

        <div className="card-header-stats">
          <div className="stat-block">
            <span className="stat-label">PRICE</span>
            <span className="stat-value">${price.toFixed(2)}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">24H</span>
            <span className={`stat-value ${changeUp ? 'up' : 'down'}`}>
              {changeUp ? '+' : ''}{change.toFixed(2)}%
            </span>
          </div>
          <div className="stat-block">
            <span className="stat-label">LOW</span>
            <span className="stat-value down">${(price * 0.95).toFixed(2)}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">HIGH</span>
            <span className="stat-value up">${(price * 1.05).toFixed(2)}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">VOL</span>
            <span className="stat-value">${(price * 420).toFixed(0)}</span>
          </div>
        </div>
      </div>

      {/* ── Timeframe Selector ── */}
      <div className="timeframe-bar">
        {TIMEFRAMES.map(tf => (
          <button
            key={tf}
            className={`tf-btn ${activeTimeframe === tf ? 'active' : ''}`}
            onClick={() => setActiveTimeframe(tf)}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* ── Chart ── */}
      <div className="chart-container" ref={chartContainerRef} />

      {/* ── Bottom Panel ── */}
      <div className="bottom-panel">
        <div className="bottom-tabs">
          <button
            className={`bottom-tab-btn ${bottomTab === 'activity' ? 'active' : ''}`}
            onClick={() => setBottomTab('activity')}
          >Recent Sales</button>
          <button
            className={`bottom-tab-btn ${bottomTab === 'listings' ? 'active' : ''}`}
            onClick={() => setBottomTab('listings')}
          >Listings</button>
        </div>

        <div className="bottom-content">
          {bottomTab === 'activity' && (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>PRICE</th>
                  <th>TYPE</th>
                  <th>TIME</th>
                </tr>
              </thead>
              <tbody>
                {price > 0 && [0, 1, 2, 3, 4].map(i => {
                  const rowPrice = (price * (0.95 + Math.sin(i * 7.3) * 0.06)).toFixed(2);
                  const isBuy = (i + seed) % 2 === 0;
                  const mins = [2, 7, 15, 31, 58][i];
                  return (
                    <tr key={i}>
                      <td className={isBuy ? 'up' : 'down'}>${rowPrice}</td>
                      <td className={isBuy ? 'up' : 'down'}>{isBuy ? 'BUY' : 'SELL'}</td>
                      <td className="muted">{mins}m ago</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {bottomTab === 'listings' && (
            <div className="empty-state">No active listings yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

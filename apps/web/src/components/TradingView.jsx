import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, AreaSeries } from 'lightweight-charts';
import { formatUsd } from '@pokex/pricing';
import { useRealtime } from '../store/realtime';
import * as api from '../lib/api.js';

const TIMEFRAMES = ['1D', '1W', '1M', '3M', '1Y'];
const px = (e6) => (e6 == null ? 0 : Number(e6) / 1_000_000);

export function TradingView({ market }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [tf, setTf] = useState('1M');

  const marks = useRealtime((s) => s.marks);
  const oi = useRealtime((s) => s.oi);
  const watch = useRealtime((s) => s.watch);
  const unwatch = useRealtime((s) => s.unwatch);

  const liveMark = market ? marks[market.id]?.markE6 ?? market.markE6 : null;
  const liveIndex = market ? marks[market.id]?.indexE6 ?? market.indexE6 : null;
  const change = market?.change24hPct ?? 0;
  const changeUp = change >= 0;

  // init chart once
  useEffect(() => {
    if (!elRef.current) return;
    const chart = createChart(elRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#111418' }, textColor: '#8b949e', fontFamily: "'Press Start 2P', monospace", fontSize: 9 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true },
      crosshair: { mode: 1 },
      width: elRef.current.clientWidth,
      height: elRef.current.clientHeight,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#f0c040',
      topColor: 'rgba(240,192,64,0.25)',
      bottomColor: 'rgba(240,192,64,0.0)',
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const onResize = () => elRef.current && chart.applyOptions({ width: elRef.current.clientWidth, height: elRef.current.clientHeight });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
    };
  }, []);

  // subscribe to the selected market's live channels
  useEffect(() => {
    if (!market) return;
    watch(market.id);
    return () => unwatch(market.id);
  }, [market?.id, watch, unwatch]);

  // load candle history on market / timeframe change
  useEffect(() => {
    if (!market || !seriesRef.current) return;
    let alive = true;
    api
      .getCandles(market.id, tf)
      .then(({ candles }) => {
        if (!alive || !seriesRef.current) return;
        seriesRef.current.setData(candles.map((c) => ({ time: c.time, value: c.value })));
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [market?.id, tf]);

  // live-update the latest point from the mark feed
  useEffect(() => {
    if (!market || !seriesRef.current || !liveMark) return;
    const today = new Date().toISOString().split('T')[0];
    try {
      seriesRef.current.update({ time: today, value: px(liveMark) });
    } catch {
      /* out-of-order time during history load */
    }
  }, [liveMark, market?.id]);

  const o = market ? oi[market.id] : null;
  const longU = o ? Number(o.longUusdc) / 1e6 : 0;
  const shortU = o ? Number(o.shortUusdc) / 1e6 : 0;
  const totalOi = longU + shortU;
  const longPct = totalOi > 0 ? (longU / totalOi) * 100 : 50;

  // NOTE: the chart container must always be mounted so the init effect (run once) can
  // attach the chart; we guard a null market inline rather than early-returning.
  return (
    <div className="trading-center">
      <div className="card-header-bar">
        <div className="card-header-left">
          {market?.imageSmall ? (
            <img src={market.imageSmall} alt="" className="header-card-thumb" />
          ) : (
            <span className="header-card-thumb idx-thumb">{market?.kind === 'index' ? 'IDX' : '—'}</span>
          )}
          <div className="card-header-meta">
            <div className="card-header-name">{market?.displayName ?? 'Select a market'}</div>
            <div className="card-header-set">{market ? (market.kind === 'index' ? 'PokeX Index' : market.symbol) : ''}</div>
          </div>
        </div>

        <div className="card-header-stats">
          <div className="stat-block">
            <span className="stat-label">MARK</span>
            <span className="stat-value">{liveMark == null ? '—' : formatUsd(px(liveMark))}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">24H</span>
            <span className={`stat-value ${changeUp ? 'up' : 'down'}`}>{changeUp ? '+' : ''}{change.toFixed(2)}%</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">INDEX</span>
            <span className="stat-value">{liveIndex == null ? '—' : formatUsd(px(liveIndex))}</span>
          </div>
          <div className="stat-block">
            <span className="stat-label">OPEN INT.</span>
            <span className="stat-value">{formatUsd(totalOi, { compact: true })}</span>
          </div>
        </div>
      </div>

      <div className="timeframe-bar">
        {TIMEFRAMES.map((t) => (
          <button key={t} className={`tf-btn ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>
            {t}
          </button>
        ))}
        {market && market.status !== 'active' && <span className="market-halt-badge">{market.status.toUpperCase()}</span>}
      </div>

      <div className="chart-container" ref={elRef} />

      <div className="bottom-panel">
        <div className="bottom-tabs">
          <span className="bottom-tab-btn active">Open Interest</span>
        </div>
        <div className="bottom-content">
          <div className="oi-row">
            <span className="up">▲ Long {formatUsd(longU, { compact: true })}</span>
            <span className="down">Short {formatUsd(shortU, { compact: true })} ▼</span>
          </div>
          <div className="oi-bar">
            <div className="oi-bar-long" style={{ width: `${longPct}%` }} />
            <div className="oi-bar-short" style={{ width: `${100 - longPct}%` }} />
          </div>
          <div className="oi-hint">Mark = index {market?.kind === 'index' ? '(basket NAV)' : ''} ± a bounded skew premium from open interest.</div>
        </div>
      </div>
    </div>
  );
}

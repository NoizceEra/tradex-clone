import React, { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export function TradingView({ selectedCard }) {
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  const name = selectedCard ? `${selectedCard.name} - ${selectedCard.number}` : 'Loading...';
  const price = selectedCard ? (
    selectedCard.tcgplayer?.prices?.holofoil?.market ||
    selectedCard.tcgplayer?.prices?.normal?.market ||
    selectedCard.tcgplayer?.prices?.['1stEditionHolofoil']?.market ||
    0
  ) : 0;

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#161a1e' },
        textColor: '#848e9c',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
      crosshair: {
        mode: 0,
      }
    });

    chartRef.current = chart;
    
    // Create an Area series to match the golden look in the reference image
    const series = chart.addAreaSeries({
      lineColor: '#fcd535',
      topColor: 'rgba(252, 213, 53, 0.4)',
      bottomColor: 'rgba(252, 213, 53, 0.0)',
      lineWidth: 2,
    });
    
    seriesRef.current = series;

    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !selectedCard) return;

    // Generate mock historical data anchored to current price
    const mockData = [];
    let currentPrice = price * 0.8; // start 20% lower
    const today = new Date();
    
    for (let i = 30; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      
      // Random walk
      const change = (Math.random() - 0.45) * (price * 0.05);
      currentPrice += change;
      
      // Last point perfectly matches current price
      if (i === 0) {
        currentPrice = price;
      }
      
      mockData.push({
        time: d.toISOString().split('T')[0],
        value: currentPrice
      });
    }

    seriesRef.current.setData(mockData);
    chartRef.current?.timeScale().fitContent();
    
  }, [selectedCard, price]);

  return (
    <div className="center-column">
      {/* Ticker Header */}
      <div className="center-header">
        <div className="header-left">
          <div className="header-title-row">
            <h1>{name}</h1>
            <span className="star-icon">☆</span>
            <span className="tag-promo">ME: Mega Evolution Promo</span>
          </div>
          <div className="header-subtitle">#{selectedCard?.id || '659232'}</div>
        </div>
        
        <div className="header-stats-row">
          <div className="header-stat">
            <span className="stat-label">Last Price</span>
            <span className="stat-val text-accent">${price.toFixed(2)}</span>
          </div>
          <div className="header-stat">
            <span className="stat-label">24h Change</span>
            <span className="stat-val text-green">+1.01%</span>
          </div>
          <div className="header-stat">
            <span className="stat-label">24h Low</span>
            <span className="stat-val text-red">${(price * 0.95).toFixed(2)}</span>
          </div>
          <div className="header-stat">
            <span className="stat-label">24h High</span>
            <span className="stat-val text-green">${(price * 1.05).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Chart Tools */}
      <div className="chart-tools">
        <div className="timeframes">
          <span>1D</span>
          <span>1W</span>
          <span className="active">1M</span>
          <span>3M</span>
          <span>1Y</span>
        </div>
      </div>

      {/* Chart Container */}
      <div className="chart-container" ref={chartContainerRef} style={{ flex: 1, width: '100%' }}></div>

      {/* Bottom Panel */}
      <div className="bottom-panel">
        <div className="bottom-tabs">
          <span className="bottom-tab active">Open Interest</span>
          <span className="bottom-tab">Active Listings (50)</span>
          <span className="bottom-tab">Recent Sales (5)</span>
        </div>
        
        <div className="oi-content">
          <div className="oi-title">{name}</div>
          <div className="oi-dist-header">
            <span>Open Interest Distribution</span>
            <span>$1.00 total</span>
          </div>
          <div className="oi-bar-container">
            <div className="oi-bar-fill" style={{ width: '100%', backgroundColor: '#f6465d' }}>
              <span className="oi-bar-text">100%</span>
            </div>
          </div>
          <div className="oi-dist-footer">
            <span className="text-green">↗ Longs $0.00</span>
            <span className="text-red">$1.00 Shorts ↘</span>
          </div>
        </div>
      </div>
    </div>
  );
}

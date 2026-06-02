import { useState } from 'react';
import { formatUsd } from '@pokex/pricing';
import * as api from '../lib/api.js';

export function OpenPositions({ positions, onChanged, onSelect }) {
  const [busy, setBusy] = useState(null);

  if (!positions || positions.length === 0) {
    return <div className="empty-state">No open positions.</div>;
  }

  const close = async (p) => {
    setBusy(p.id);
    try {
      await api.closePosition(p.id, { fractionBps: 10_000, idempotencyKey: crypto.randomUUID() });
      onChanged?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <table className="positions-table">
      <thead>
        <tr>
          <th>MARKET</th>
          <th>SIDE</th>
          <th>SIZE</th>
          <th>ENTRY</th>
          <th>MARK</th>
          <th>LIQ</th>
          <th>uPnL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const up = BigInt(p.unrealizedPnlUusdc) >= 0n;
          return (
            <tr key={p.id}>
              <td className="link" onClick={() => onSelect?.(p.marketId)}>{p.symbol}</td>
              <td className={p.side === 'long' ? 'up' : 'down'}>
                {p.side.toUpperCase()} {p.leverage}x
              </td>
              <td>{(Number(p.qtyE6) / 1e6).toFixed(2)}</td>
              <td>{formatUsd(BigInt(p.avgEntryE6))}</td>
              <td>{formatUsd(BigInt(p.markE6))}</td>
              <td className="down">{formatUsd(BigInt(p.liqPriceE6))}</td>
              <td className={up ? 'up' : 'down'}>
                {up ? '+' : ''}
                {formatUsd(BigInt(p.unrealizedPnlUusdc))}
              </td>
              <td>
                <button className="btn-ghost sm" disabled={busy === p.id} onClick={() => close(p)}>
                  {busy === p.id ? '…' : 'Close'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { SidebarMarkets } from './components/SidebarMarkets';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';
import { Marketplace } from './components/Marketplace';
import { Portfolio } from './components/Portfolio';
import { PoolView } from './components/PoolView';
import { Leaderboard } from './components/Leaderboard';
import { AdminPanel } from './components/AdminPanel';
import { Landing } from './components/Landing';
import { ChatSidebar } from './components/ChatSidebar';
import { Toasts } from './components/Toasts';
import { useRealtime } from './store/realtime';
import { useChat } from './store/chat';
import * as api from './lib/api.js';

api.capturePendingReferral(); // stash any ?ref=CODE before the URL changes

function App() {
  const [markets, setMarkets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  // Always default to the landing on a fresh load; #admin is the only deep-link exception.
  const [activeView, setActiveView] = useState(() => (window.location.hash === '#admin' ? 'admin' : 'home'));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('gachadex_chat_open') !== '0');
  const startRealtime = useRealtime((s) => s.start);
  const startChat = useChat((s) => s.start);

  const toggleChat = () =>
    setChatOpen((o) => {
      const next = !o;
      localStorage.setItem('gachadex_chat_open', next ? '1' : '0');
      return next;
    });

  useEffect(() => {
    startRealtime();
    startChat();
  }, [startRealtime, startChat]);

  // Operator panel is reachable at #admin only (not in the public nav).
  useEffect(() => {
    const sync = () => { if (window.location.hash === '#admin') setActiveView('admin'); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const loadMarkets = useCallback(async () => {
    try {
      const { markets: m } = await api.getMarkets();
      setMarkets(m);
      setSelectedId((cur) => cur ?? m.find((x) => x.kind === 'card' && x.markE6)?.id ?? m[0]?.id ?? null);
    } catch (e) {
      console.error('Failed to load markets', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    const t = setInterval(loadMarkets, 30_000);
    return () => clearInterval(t);
  }, [loadMarkets]);

  const selected = markets.find((m) => m.id === selectedId) || null;
  const onSelectMarket = (m) => setSelectedId(m.id);
  const handleTradeMarket = (m) => {
    setSelectedId(m.id);
    setActiveView('trade');
  };
  const enterApp = () => setActiveView('trade'); // in-session only; a reload returns to the landing

  // The marketing landing is its own full-screen page (no trading chrome) — render it before the app shell.
  if (activeView === 'home') return <Landing onEnter={enterApp} />;

  return (
    <>
      <div className="skin-cardback" aria-hidden="true"><span className="skin-emblem" /></div>
      <div className={`app-container ${chatOpen ? 'chat-open' : ''}`}>
      <ChatSidebar open={chatOpen} onToggle={toggleChat} />
      <Navbar activeView={activeView} setActiveView={setActiveView} chatOpen={chatOpen} onToggleChat={toggleChat} />

      {activeView === 'trade' && (
        <div className={`main-grid ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <SidebarMarkets
            markets={markets}
            loading={loading}
            selected={selected}
            onSelect={onSelectMarket}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
          />
          <TradingView market={selected} />
          <OrderEntry market={selected} onTraded={loadMarkets} />
        </div>
      )}

      {activeView === 'markets' && <Marketplace markets={markets} loading={loading} onTradeMarket={handleTradeMarket} />}
      {activeView === 'portfolio' && <Portfolio markets={markets} onSelect={handleTradeMarket} />}
      {activeView === 'pool' && <PoolView />}
      {activeView === 'leaderboard' && <Leaderboard />}
      {activeView === 'admin' && <AdminPanel />}

      <Toasts />
      </div>
    </>
  );
}

export default App;

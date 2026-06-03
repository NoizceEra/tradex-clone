import { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { SidebarMarkets } from './components/SidebarMarkets';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';
import { Marketplace } from './components/Marketplace';
import { Portfolio } from './components/Portfolio';
import { PoolView } from './components/PoolView';
import { Leaderboard } from './components/Leaderboard';
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
  const [activeView, setActiveView] = useState('trade');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('pokeX_chat_open') !== '0');
  const startRealtime = useRealtime((s) => s.start);
  const startChat = useChat((s) => s.start);

  const toggleChat = () =>
    setChatOpen((o) => {
      const next = !o;
      localStorage.setItem('pokeX_chat_open', next ? '1' : '0');
      return next;
    });

  useEffect(() => {
    startRealtime();
    startChat();
  }, [startRealtime, startChat]);

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

      <Toasts />
      </div>
    </>
  );
}

export default App;

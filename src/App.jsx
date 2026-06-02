import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { SidebarMarkets } from './components/SidebarMarkets';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';
import { Marketplace } from './components/Marketplace';

function App() {
  const [cards, setCards] = useState([]);
  const [selectedCard, setSelectedCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState('trade');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [portfolio, setPortfolio] = useState(() => {
    const saved = localStorage.getItem('pokeX_portfolio');
    return saved ? JSON.parse(saved) : { balance: 10000, positions: {} };
  });

  useEffect(() => {
    localStorage.setItem('pokeX_portfolio', JSON.stringify(portfolio));
  }, [portfolio]);

  const executeTrade = (card, side, amount, price) => {
    setPortfolio(prev => {
      const newPortfolio = { ...prev };
      const cost = amount * price;
      
      if (side === 'buy') {
        if (newPortfolio.balance < cost) {
          alert('Insufficient funds');
          return prev;
        }
        newPortfolio.balance -= cost;
        const currentPos = newPortfolio.positions[card.id] || { amount: 0, avgPrice: 0, card };
        const totalAmount = currentPos.amount + amount;
        const totalCost = (currentPos.amount * currentPos.avgPrice) + cost;
        newPortfolio.positions[card.id] = {
          ...currentPos,
          amount: totalAmount,
          avgPrice: totalCost / totalAmount
        };
      } else {
        const currentPos = newPortfolio.positions[card.id] || { amount: 0, avgPrice: 0, card };
        if (currentPos.amount < amount) {
          alert('Insufficient position to sell');
          return prev;
        }
        newPortfolio.balance += cost;
        currentPos.amount -= amount;
        if (currentPos.amount === 0) {
          delete newPortfolio.positions[card.id];
        } else {
          newPortfolio.positions[card.id] = currentPos;
        }
      }
      return newPortfolio;
    });
  };

  useEffect(() => {
    async function fetchCards() {
      try {
        const response = await fetch(
          'https://api.pokemontcg.io/v2/cards?q=set.id:base1 supertype:Pokémon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=60',
          { headers: { 'X-Api-Key': '07c20d0a64mshf9bf046e5c2971dp18eebbjsnd624c80d8b9b' } }
        );
        const data = await response.json();
        if (data && data.data) {
          setCards(data.data);
          if (data.data.length > 0) setSelectedCard(data.data[0]);
        }
      } catch (error) {
        console.error('Failed to fetch cards', error);
      } finally {
        setLoading(false);
      }
    }
    fetchCards();
  }, []);

  // When user clicks "TRADE" from the binder, switch to exchange view
  const handleTradeCard = (card) => {
    setSelectedCard(card);
    setActiveView('trade');
  };

  return (
    <div className="app-container">
      <Navbar activeView={activeView} setActiveView={setActiveView} />

      {activeView === 'trade' ? (
        <div className={`main-grid ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <SidebarMarkets
            cards={cards}
            loading={loading}
            selectedCard={selectedCard}
            onSelectCard={setSelectedCard}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            portfolio={portfolio}
          />
          <TradingView selectedCard={selectedCard} />
          <OrderEntry 
            selectedCard={selectedCard} 
            portfolio={portfolio} 
            executeTrade={executeTrade} 
          />
        </div>
      ) : (
        <Marketplace
          cards={cards}
          loading={loading}
          onTradeCard={handleTradeCard}
        />
      )}
    </div>
  );
}

export default App;

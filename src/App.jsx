import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { SidebarMarkets } from './components/SidebarMarkets';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';

function App() {
  const [cards, setCards] = useState([]);
  const [selectedCard, setSelectedCard] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCards() {
      try {
        const response = await fetch('https://api.pokemontcg.io/v2/cards?q=set.id:base1 supertype:Pokémon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=20', {
          headers: {
            'X-Api-Key': '07c20d0a64mshf9bf046e5c2971dp18eebbjsnd624c80d8b9b'
          }
        });
        const data = await response.json();
        if (data && data.data) {
          setCards(data.data);
          if (data.data.length > 0) setSelectedCard(data.data[0]);
        }
      } catch (error) {
        console.error("Failed to fetch cards", error);
      } finally {
        setLoading(false);
      }
    }
    fetchCards();
  }, []);

  return (
    <div className="app-container">
      <Navbar />
      
      <div className="main-grid">
        {/* Left Column */}
        <SidebarMarkets 
          cards={cards} 
          loading={loading} 
          selectedCard={selectedCard} 
          onSelectCard={setSelectedCard} 
        />
        
        {/* Center Column */}
        <TradingView selectedCard={selectedCard} />
        
        {/* Right Column */}
        <OrderEntry selectedCard={selectedCard} />
      </div>
    </div>
  );
}

export default App;

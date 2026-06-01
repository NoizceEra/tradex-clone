import React, { useState } from 'react';
import { Navbar } from './components/Navbar';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';
import { BrowseCards } from './components/BrowseCards';

function App() {
  const [activeView, setActiveView] = useState('trade');
  const [selectedCard, setSelectedCard] = useState(null);

  const handleSelectCard = (card) => {
    setSelectedCard(card);
    setActiveView('trade');
  };

  return (
    <div className="app-container">
      <Navbar activeView={activeView} setActiveView={setActiveView} />
      
      {activeView === 'trade' && (
        <div className="trading-layout">
          <TradingView selectedCard={selectedCard} />
          <OrderEntry selectedCard={selectedCard} />
        </div>
      )}

      {activeView === 'browse' && (
        <BrowseCards onSelectCard={handleSelectCard} />
      )}
    </div>
  );
}

export default App;

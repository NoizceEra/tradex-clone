import React, { useState, useEffect } from 'react';
import './BrowseCards.css';

export function BrowseCards({ onSelectCard }) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCards() {
      try {
        const response = await fetch('https://api.pokemontcg.io/v2/cards?q=set.id:base1 supertype:Pokémon&orderBy=-tcgplayer.prices.holofoil.market&pageSize=20', {
          headers: {
            'X-Api-Key': '07c20d0a64mshf9bf046e5c2971dp18eebbjsnd624c80d8b9b' // Provided key
          }
        });
        const data = await response.json();
        if (data && data.data) {
          setCards(data.data);
        }
      } catch (error) {
        console.error("Failed to fetch cards", error);
      } finally {
        setLoading(false);
      }
    }
    fetchCards();
  }, []);

  if (loading) {
    return <div className="browse-loading">Loading cards...</div>;
  }

  return (
    <div className="browse-container">
      <h2>Browse Pokemon Cards</h2>
      <div className="card-grid">
        {cards.map(card => {
          const price = card.tcgplayer?.prices?.holofoil?.market 
            || card.tcgplayer?.prices?.normal?.market 
            || card.tcgplayer?.prices?.1stEditionHolofoil?.market
            || 0;
            
          return (
            <div key={card.id} className="card-item glass-panel" onClick={() => onSelectCard(card)}>
              <img src={card.images.small} alt={card.name} />
              <div className="card-info">
                <h3>{card.name}</h3>
                <p className="card-set">{card.set.name}</p>
                <p className="card-price text-green">${price.toFixed(2)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

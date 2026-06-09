fetch('https://pokexapi-production.up.railway.app/markets')
  .then(r => r.json())
  .then(data => {
    const cards = data.markets.filter(m => m.kind === 'card');
    const withMarks = cards.filter(c => c.markE6 != null);
    console.log(`Cards: ${cards.length}, With Marks: ${withMarks.length}`);
    if (cards.length > 0) {
      console.log('Sample card:', JSON.stringify(cards[0], null, 2));
    }
  })
  .catch(e => console.error(e));

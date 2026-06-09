fetch('https://pokexapi-production.up.railway.app/markets')
  .then(r => r.json())
  .then(data => {
    const tradeable = data.markets.filter(m => m.tradeable);
    console.log(`Total markets: ${data.markets.length}`);
    console.log(`Tradeable markets: ${tradeable.length}`);
    if (tradeable.length > 0) {
      console.log('Sample tradeable:', JSON.stringify(tradeable[0], null, 2));
    } else {
      console.log('Sample non-tradeable:', JSON.stringify(data.markets[0], null, 2));
    }
  })
  .catch(e => console.error(e));

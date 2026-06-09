const token = "XRG0EhxXvlirN9mXtlEaGWyR7mOpdzxEA7rxML81gGB";
fetch('https://backboard.railway.app/graphql/v2', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: "query { projects { edges { node { id name } } } }" })
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));

// Fetch the deployed JS bundle and search for the API URL
fetch('https://www.gachadex.fun')
  .then(r => r.text())
  .then(html => {
    // Find the JS bundle path
    const match = html.match(/\/assets\/index-[^"]+\.js/);
    if (!match) { console.log('Could not find JS bundle in HTML'); return; }
    const jsPath = match[0];
    console.log('JS bundle:', jsPath);
    return fetch(`https://www.gachadex.fun${jsPath}`);
  })
  .then(r => r?.text())
  .then(js => {
    if (!js) return;
    const hasCorrectUrl = js.includes('pokexapi-production.up.railway.app');
    const hasNewline = js.includes('pokexapi-production.up.railway.app\\n');
    console.log('Contains API URL:', hasCorrectUrl);
    console.log('Contains trailing newline (bad):', hasNewline);
    if (hasCorrectUrl && !hasNewline) {
      console.log('✅ VITE_API_URL is correctly baked in without newline!');
    } else if (hasNewline) {
      console.log('❌ Still has trailing newline issue!');
    } else {
      console.log('❌ API URL not found in bundle');
    }
  })
  .catch(e => console.error('Error:', e));

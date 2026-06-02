export default async function handler(req, res) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'JustTCG API key not configured' });
    return;
  }
  // Build target URL by stripping the "/api/justtcg" prefix
  const targetPath = req.url.replace(/^\/api\/justtcg/, '');
  const targetUrl = `https://api.justtcg.com${targetPath}`;
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        'x-api-key': apiKey,
      },
    });
    const body = await response.buffer();
    // Forward status and content type
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.status(response.status).send(body);
  } catch (e) {
    console.error('JustTCG proxy error', e);
    res.status(502).json({ error: 'Bad gateway' });
  }
}

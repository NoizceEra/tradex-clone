/**
 * Sets VITE_API_URL on Vercel for Production + Preview using the Vercel REST API.
 * Reads the token from the local Vercel CLI auth file.
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Vercel stores the token here on Windows
const authPath = path.join(os.homedir(), 'AppData', 'Roaming', 'com.vercel.cli', 'Data', 'auth.json');

let token;
try {
  const raw = fs.readFileSync(authPath, 'utf8');
  token = JSON.parse(raw).token;
  console.log('Found token, length:', token?.length);
} catch (e) {
  console.error('Could not find Vercel auth token:', e.message);
  process.exit(1);
}

const VALUE = 'https://pokexapi-production.up.railway.app';
const KEY = 'VITE_API_URL';

// First, get the project info to find the correct project ID
function apiRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const options = {
      hostname: 'api.vercel.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const PROJECT_ID = 'prj_RzM6NP6ePnbH94a4RfIuBdvaounu';
  const TEAM_ID = 'team_iJ1WqPRmNFSeadrcmQahgNAj';
  
  // Get existing env vars to find the ID of VITE_API_URL if it exists
  const envRes = await apiRequest('GET', `/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`);
  console.log('Env vars status:', envRes.status);
  
  if (envRes.status !== 200) {
    console.error('Error:', JSON.stringify(envRes.body));
    return;
  }
  
  const envVars = envRes.body.envs || [];
  const existing = envVars.filter(e => e.key === KEY);
  console.log(`Found ${existing.length} existing ${KEY} env vars`);
  
  // Delete any existing VITE_API_URL
  for (const ev of existing) {
    console.log(`Deleting existing ${KEY} (id: ${ev.id}, target: ${JSON.stringify(ev.target)})...`);
    const delRes = await apiRequest('DELETE', `/v9/projects/${PROJECT_ID}/env/${ev.id}?teamId=${TEAM_ID}`);
    console.log('Delete status:', delRes.status);
  }

  // Create new env var for production and preview
  const createBody = {
    key: KEY,
    value: VALUE,
    type: 'plain',
    target: ['production', 'preview'],
  };
  
  console.log(`\nCreating ${KEY}=${VALUE} for production+preview...`);
  const createRes = await apiRequest('POST', `/v10/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`, createBody);
  console.log('Create status:', createRes.status);
  
  if (createRes.status === 200 || createRes.status === 201) {
    console.log('Raw response:', JSON.stringify(createRes.body, null, 2));
    const created = Array.isArray(createRes.body) ? createRes.body : (createRes.body.created || [createRes.body]);
    for (const c of created) {
      console.log(`✅ Created ${c.key} = ${c.value} for [${c.target?.join(', ')}]`);
    }
  } else {
    console.error('❌ Error creating:', JSON.stringify(createRes.body, null, 2));
  }
}

main().catch(console.error);

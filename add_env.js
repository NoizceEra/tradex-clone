const { execFileSync } = require('child_process');

// Write the value to stdin of vercel env add, using a Buffer with no trailing newline
const { spawn } = require('child_process');
const proc = spawn('vercel', ['env', 'add', 'VITE_API_URL', 'production'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true
});

// Answer: value, then 'n' for sensitive
const value = 'https://pokexapi-production.up.railway.app';
proc.stdin.write(value + '\n'); // value + newline to submit
proc.stdin.write('n\n'); // answer 'n' to sensitive question
proc.stdin.end();

proc.on('close', (code) => {
  console.log('Exit code:', code);
});

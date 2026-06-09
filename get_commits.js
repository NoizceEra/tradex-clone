const https = require('https');
https.get('https://api.github.com/repos/NoizceEra/tradex-clone/commits', { headers: { 'User-Agent': 'Node.js' } }, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const commits = JSON.parse(data);
    if (!Array.isArray(commits)) {
      console.log('Error:', commits);
      return;
    }
    commits.slice(0, 5).forEach(c => {
      console.log(c.commit.author.date, c.commit.message.split('\n')[0]);
    });
  });
});

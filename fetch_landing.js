fetch('https://tradex-clone-noizceeras-projects.vercel.app/')
  .then(res => res.text())
  .then(text => console.log(text.substring(0, 1000)))
  .catch(err => console.error(err));

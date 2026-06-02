import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

// Web3 polyfills might be needed for some wallet packages, but Vite often handles standard ones. 
// If not, window.Buffer = Buffer could be required. 
import { Buffer } from 'buffer';
window.Buffer = window.Buffer || Buffer;

// eslint-disable-next-line react-refresh/only-export-components
const RootApp = () => {
  // Play-money MVP runs on devnet. Override with VITE_SOLANA_RPC in prod.
  const endpoint = import.meta.env.VITE_SOLANA_RPC || clusterApiUrl('devnet');

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);

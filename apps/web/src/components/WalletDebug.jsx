import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

/**
 * Debug component to diagnose wallet connection issues.
 * Shows real-time wallet and RPC status without requiring blockchain access.
 */
export function WalletDebug() {
  const { wallet, connected, publicKey, signMessage, connecting, disconnecting } = useWallet();
  const { connection } = useConnection();

  const testSignMessage = async () => {
    if (!signMessage) {
      alert('Wallet not connected or does not support message signing');
      return;
    }
    try {
      const message = new TextEncoder().encode('Test message - no blockchain required');
      const sig = await signMessage(message);
      alert(`✅ Message signed successfully!\nSignature: ${sig.slice(0, 20).toString()}...`);
    } catch (e) {
      alert(`❌ Failed to sign message:\n${e.message}`);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace', backgroundColor: '#1a1a1a', color: '#0f0' }}>
      <h2>🔍 Wallet Connection Diagnostics</h2>

      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#2a2a2a', borderRadius: '5px' }}>
        <h3>Wallet Status</h3>
        <p>
          <strong>Connected:</strong> {connected ? '✅ YES' : '❌ NO'}
        </p>
        <p>
          <strong>Connecting:</strong> {connecting ? '⏳ YES' : '✅ NO'}
        </p>
        <p>
          <strong>Disconnecting:</strong> {disconnecting ? '⏳ YES' : '✅ NO'}
        </p>
        <p>
          <strong>Wallet Name:</strong> {wallet?.adapter?.name ?? 'None selected'}
        </p>
        <p>
          <strong>Public Key:</strong>{' '}
          {publicKey ? (
            <code>{publicKey.toBase58().slice(0, 20)}...</code>
          ) : (
            'Not connected'
          )}
        </p>
        <p>
          <strong>Can Sign:</strong> {signMessage ? '✅ YES' : '❌ NO'}
        </p>
      </div>

      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#2a2a2a', borderRadius: '5px' }}>
        <h3>RPC Endpoint</h3>
        <p>
          <strong>Endpoint:</strong>{' '}
          <code>{connection?.rpcEndpoint ?? 'Unknown'}</code>
        </p>
        <p>
          <strong>Status:</strong> {connection ? '✅ Configured' : '❌ Not configured'}
        </p>
      </div>

      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#2a2a2a', borderRadius: '5px' }}>
        <h3>Controls</h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ padding: '10px', backgroundColor: '#333', borderRadius: '5px' }}>
            <p style={{ marginBottom: '10px' }}>
              <strong>Step 1: Connect Wallet</strong>
            </p>
            <WalletMultiButton />
          </div>

          <button
            onClick={testSignMessage}
            disabled={!signMessage}
            style={{
              padding: '10px 20px',
              backgroundColor: signMessage ? '#0f0' : '#666',
              color: '#000',
              border: 'none',
              borderRadius: '5px',
              cursor: signMessage ? 'pointer' : 'not-allowed',
              fontWeight: 'bold',
            }}
          >
            Step 2: Test Sign Message
          </button>
        </div>
      </div>

      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#2a2a2a', borderRadius: '5px' }}>
        <h3>Instructions</h3>
        <ol>
          <li>Make sure Phantom or Solflare is installed in your browser</li>
          <li>Open the extension and switch to <strong>Devnet</strong> network</li>
          <li>Click "Connect Wallet" above and select your wallet</li>
          <li>Once connected, click "Test Sign Message" to verify signing works</li>
          <li>Check browser console (F12) for any error messages</li>
        </ol>
      </div>

      <details style={{ marginBottom: '20px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>Show Console Logs</summary>
        <pre
          style={{
            backgroundColor: '#1a1a1a',
            padding: '10px',
            overflow: 'auto',
            maxHeight: '300px',
            fontSize: '12px',
          }}
        >
          Check your browser's Developer Tools (F12 → Console tab) for detailed logs
        </pre>
      </details>
    </div>
  );
}

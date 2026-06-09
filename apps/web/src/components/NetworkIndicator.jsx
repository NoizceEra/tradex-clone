import { useConnection } from '@solana/wallet-adapter-react';

export function NetworkIndicator() {
  const { connection } = useConnection();

  // Extract the cluster from the RPC endpoint
  let cluster = 'devnet';
  if (connection?.rpcEndpoint) {
    if (connection.rpcEndpoint.includes('mainnet')) cluster = 'mainnet';
    else if (connection.rpcEndpoint.includes('testnet')) cluster = 'testnet';
  }

  const getClusterColor = (c) => {
    switch (c) {
      case 'mainnet':
        return '#51cf66'; // green
      case 'devnet':
        return '#ffd43b'; // yellow/warning
      case 'testnet':
        return '#ff922b'; // orange
      default:
        return '#a6aeb7'; // gray
    }
  };

  const getClusterLabel = (c) => {
    return c.charAt(0).toUpperCase() + c.slice(1);
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 12px',
        borderRadius: '16px',
        fontSize: '12px',
        fontWeight: '500',
        backgroundColor: getClusterColor(cluster) + '20',
        color: getClusterColor(cluster),
        border: `1px solid ${getClusterColor(cluster)}40`,
      }}
      title={`Connected to Solana ${cluster}`}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: getClusterColor(cluster),
        }}
      />
      {getClusterLabel(cluster)}
    </div>
  );
}

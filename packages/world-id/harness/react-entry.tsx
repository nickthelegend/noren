// The Noren app's VerifyHuman component, rendered by the harness at /react with the same server.
import { createRoot } from 'react-dom/client';
import { VerifyHuman } from '../src/VerifyHuman.tsx';

const wallet = new URLSearchParams(location.search).get('wallet') ?? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
createRoot(document.getElementById('root')!).render(
  <div style={{ maxWidth: 560, margin: '32px auto', padding: '0 16px', display: 'grid', gap: 12 }}>
    <p style={{ margin: 0, fontSize: 12.5, color: '#5a5f75' }}>Harness · the Noren app component, wallet <code>{wallet}</code></p>
    <VerifyHuman serverUrl="" wallet={wallet} onResult={r => console.log('[VerifyHuman]', r)} />
  </div>,
);

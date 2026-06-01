import { Navbar } from './components/Navbar';
import { TradingView } from './components/TradingView';
import { OrderEntry } from './components/OrderEntry';

function App() {
  return (
    <div className="app-container">
      <Navbar />
      <div className="trading-layout">
        <TradingView />
        <OrderEntry />
      </div>
    </div>
  );
}

export default App;

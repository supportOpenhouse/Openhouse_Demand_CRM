import { createRoot } from 'react-dom/client';
import './theme.css';   // legacy theme (variables + component styles), kept verbatim
import './app.css';     // migration shell + motion (rx-* prefixed, no collisions)
import './recordings.css'; // meeting-recordings annotation layer (rec-* prefixed)
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);

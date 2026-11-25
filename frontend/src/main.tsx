import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Fontes servidas pelo próprio sistema (sem Google Fonts): só os pesos usados pela escala
// tipográfica (400, 500, 600) e o 500 da marca. O 700 não é carregado de propósito.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

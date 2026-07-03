import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restoreLastProject, startAutosave } from './state/persist';
import './styles.css';

// Reopen the last project before autosave attaches, so a fresh default
// project can never clobber saved work.
void restoreLastProject().finally(startAutosave);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

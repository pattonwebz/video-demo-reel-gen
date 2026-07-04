import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restoreLastProject, startAutosave } from './state/persist';
import { installAutomationApi } from './automation/api';
import './styles.css';

// Headless-driver backdoor for the scripted pipeline — never on for users.
if (new URLSearchParams(location.search).get('automation') === '1') {
  installAutomationApi();
}

// Reopen the last project before autosave attaches, so a fresh default
// project can never clobber saved work.
void restoreLastProject().finally(startAutosave);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import Preview from './components/Preview';
import SettingsPanel from './components/SettingsPanel';
import ImportButton from './components/ImportButton';
import ExportButton from './components/ExportButton';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Demo Reel Studio</h1>
        <div className="topbar-actions">
          <ImportButton />
          <ExportButton />
        </div>
      </header>
      <main className="workspace">
        <Preview />
        <SettingsPanel />
      </main>
    </div>
  );
}

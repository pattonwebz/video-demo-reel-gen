import Preview from './components/Preview';
import SettingsPanel from './components/SettingsPanel';
import ImportButton from './components/ImportButton';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Demo Reel Studio</h1>
        <div className="topbar-actions">
          <ImportButton />
        </div>
      </header>
      <main className="workspace">
        <Preview />
        <SettingsPanel />
      </main>
    </div>
  );
}

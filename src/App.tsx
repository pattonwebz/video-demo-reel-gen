import Preview from './components/Preview';
import SettingsPanel from './components/SettingsPanel';
import ImportButton from './components/ImportButton';
import ExportButton from './components/ExportButton';
import TimelinePanel from './components/TimelinePanel';
import RecordPanel from './components/RecordPanel';
import ProjectMenu from './components/ProjectMenu';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Demo Reel Studio</h1>
          <ProjectMenu />
        </div>
        <div className="topbar-actions">
          <RecordPanel />
          <ImportButton />
          <ExportButton />
        </div>
      </header>
      <main className="workspace">
        <Preview />
        <SettingsPanel />
      </main>
      <TimelinePanel />
    </div>
  );
}

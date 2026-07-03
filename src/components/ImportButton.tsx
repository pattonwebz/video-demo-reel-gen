import { useRef } from 'react';
import { importAndPersistVideoFile } from '../state/persist';

export default function ImportButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="btn" onClick={() => inputRef.current?.click()}>
        Import video
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await importAndPersistVideoFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

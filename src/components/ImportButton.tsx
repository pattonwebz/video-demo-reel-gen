import { useRef } from 'react';
import { importVideoFile } from '../state/store';

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
          if (file) await importVideoFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

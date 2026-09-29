import { useState } from 'react';

const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/))([A-Za-z0-9_-]{11})/;

/** Extract a YouTube video id from youtu.be/, watch?v=, shorts/ (or embed/) URLs. */
export function extractYouTubeId(url: string): string | null {
  const m = url.trim().match(YT_RE);
  const id = m?.[1];
  return id !== undefined ? id : null;
}

const BTN =
  'rounded-[8px] bg-panel px-4 py-2 text-xl font-semibold text-ink hover:bg-ink/15 active:bg-ink/20';

export default function MediaPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!url.trim()) {
      setError('Paste a YouTube link first.');
      setVideoId(null);
      return;
    }
    const id = extractYouTubeId(url);
    if (id === null) {
      setError('That does not look like a YouTube link (youtu.be/, watch?v=, shorts/).');
      setVideoId(null);
      return;
    }
    setError(null);
    setVideoId(id);
  };

  return (
    <aside
      className={`absolute inset-y-0 right-0 z-20 flex w-[26rem] flex-col gap-3 border-l border-line bg-void/95 p-4 shadow-2xl backdrop-blur transition-transform duration-300 ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.06em] text-ink">Media</h2>
        <button type="button" onClick={onClose} className={BTN}>
          Close
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-void px-3 py-2 text-lg text-ink placeholder:text-dim/70 focus:outline-none focus:ring-2 focus:ring-on"
        />
        <button type="button" onClick={load} className="rounded-[8px] bg-on px-4 py-2 text-lg font-bold text-void hover:bg-on/85">
          Play
        </button>
      </div>
      {error !== null && <p className="text-lg text-danger">{error}</p>}
      {videoId !== null ? (
        <iframe
          key={videoId}
          src={`https://www.youtube-nocookie.com/embed/${videoId}`}
          title="YouTube media"
          allow="autoplay; encrypted-media; fullscreen"
          allowFullScreen
          className="min-h-0 w-full flex-1 rounded-[8px] bg-black"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-[8px] border border-dashed border-line">
          <p className="px-4 text-center text-xl text-dim">Paste a YouTube link to start the show.</p>
        </div>
      )}
    </aside>
  );
}

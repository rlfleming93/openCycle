import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { SessionSnapshot } from '@opencycle/shared';
import { useNavigate } from 'react-router-dom';

import { sendWs } from '../../lib/ws.js';
import { useAppStore } from '../../store.js';

type Rider = SessionSnapshot['riders'][number];

const CONFIRM_MS = 5000;

const BTN =
  'rounded-[8px] border border-line bg-ink/5 px-[clamp(8px,0.83vw,26px)] py-[clamp(3px,0.31vw,12px)] font-display text-[clamp(13px,1.04vw,32px)] font-semibold uppercase tracking-[0.06em] text-ink hover:bg-ink/10 disabled:cursor-not-allowed disabled:opacity-40';
const BTN_DANGER =
  'rounded-[8px] border border-danger/40 bg-danger/10 px-[clamp(8px,0.83vw,26px)] py-[clamp(3px,0.31vw,12px)] font-display text-[clamp(13px,1.04vw,32px)] font-semibold uppercase tracking-[0.06em] text-danger hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Bottom-center ride controls: a focusable tray button (C toggles, Esc closes)
 * holding every action that is not safe to hit in a sprint. Destructive
 * actions use an inline two-step confirm that reverts after 5 s.
 */
export default function ControlsTray({
  session,
  onOpenMedia,
}: {
  session: SessionSnapshot;
  onOpenMedia: () => void;
}) {
  const navigate = useNavigate();
  const wsStatus = useAppStore((state) => state.wsStatus);
  const spaceGame = useAppStore((state) => state.spaceGame);
  const setSpaceGame = useAppStore((state) => state.setSpaceGame);
  const [open, setOpen] = useState(false);
  /** `rider:<id>` or `session` — the pending two-step confirm. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Distance from the viewport bottom to the open panel's bottom edge. */
  const [panelBottom, setPanelBottom] = useState(120);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const controlsOff = wsStatus !== 'open';

  // The open panel is placed above the rider-card band, measured from the real
  // layout: card height is content-driven, so a static offset cannot promise
  // the 16 px gap at every width and rider count.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bands = [...document.querySelectorAll('[data-rider-card-band]')];
      const tops = bands.map((band) => band.getBoundingClientRect().top);
      const cardTop = tops.length > 0 ? Math.min(...tops) : window.innerHeight;
      setPanelBottom(Math.max(96, Math.round(window.innerHeight - (cardTop - 16))));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, session.riders.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      if (event.key === 'Escape') {
        setOpen(false);
        setConfirming(null);
        buttonRef.current?.focus();
        return;
      }
      if ((event.key === 'c' || event.key === 'C') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (confirming === null) return;
    const id = window.setTimeout(() => setConfirming(null), CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [confirming]);

  const riderAction = (rider: Rider, action: 'pause' | 'resume' | 'bias-1' | 'bias+1' | 'skip') => {
    switch (action) {
      case 'pause':
        sendWs({ type: 'pause', riderId: rider.riderId });
        break;
      case 'resume':
        sendWs({ type: 'resume', riderId: rider.riderId });
        break;
      case 'bias-1':
        sendWs({ type: 'setBias', riderId: rider.riderId, deltaPct: -1 });
        break;
      case 'bias+1':
        sendWs({ type: 'setBias', riderId: rider.riderId, deltaPct: 1 });
        break;
      case 'skip':
        sendWs({ type: 'skipStep', riderId: rider.riderId });
        break;
    }
  };

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Ride controls"
          tabIndex={-1}
          style={{ bottom: `${panelBottom}px` }}
          className="pointer-events-auto absolute left-1/2 z-40 w-[min(70vw,1180px)] -translate-x-1/2 rounded-[14px] border border-line bg-void/90 px-[clamp(14px,1.35vw,48px)] py-[clamp(12px,1.15vw,40px)] backdrop-blur-[10px] focus:outline-none"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-[clamp(18px,1.5625vw,44px)] font-semibold uppercase tracking-[0.06em] text-ink">
              Ride controls
            </h2>
            <p className="font-display text-[clamp(12px,0.94vw,28px)] uppercase tracking-[0.06em] text-dim">
              C to toggle · Esc to close
            </p>
          </div>

          <div className="mt-[clamp(8px,0.83vw,28px)] flex flex-col gap-[clamp(6px,0.52vw,18px)]">
            {session.riders.map((rider) => (
              <div
                key={rider.riderId}
                className="flex flex-wrap items-center justify-between gap-[clamp(6px,0.62vw,20px)] border-t border-line pt-[clamp(6px,0.52vw,18px)]"
              >
                <span className="min-w-0 truncate font-display text-[clamp(15px,1.25vw,38px)] uppercase tracking-[0.06em] text-ink">
                  {rider.name}
                </span>
                <div className="flex flex-wrap gap-[clamp(4px,0.42vw,14px)]">
                  <button
                    type="button"
                    disabled={controlsOff}
                    onClick={() => riderAction(rider, rider.state === 'paused' ? 'resume' : 'pause')}
                    className={BTN}
                  >
                    {rider.state === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    disabled={controlsOff}
                    onClick={() => riderAction(rider, 'bias-1')}
                    className={BTN}
                    aria-label={`Ease ${rider.name} 1 percent`}
                  >
                    −1%
                  </button>
                  <button
                    type="button"
                    disabled={controlsOff}
                    onClick={() => riderAction(rider, 'bias+1')}
                    className={BTN}
                    aria-label={`Push ${rider.name} 1 percent`}
                  >
                    +1%
                  </button>
                  <button type="button" disabled={controlsOff} onClick={() => riderAction(rider, 'skip')} className={BTN}>
                    Skip
                  </button>
                  <button
                    type="button"
                    disabled={controlsOff}
                    onClick={() => {
                      if (confirming === `rider:${rider.riderId}`) {
                        sendWs({ type: 'stopRider', riderId: rider.riderId });
                        setConfirming(null);
                        return;
                      }
                      setConfirming(`rider:${rider.riderId}`);
                    }}
                    className={BTN_DANGER}
                  >
                    {confirming === `rider:${rider.riderId}` ? 'Confirm stop' : 'Stop rider'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-[clamp(8px,0.83vw,28px)] flex flex-wrap items-center justify-between gap-[clamp(6px,0.62vw,20px)] border-t border-line pt-[clamp(6px,0.62vw,20px)]">
            <div className="flex flex-wrap gap-[clamp(4px,0.42vw,14px)]">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenMedia();
                }}
                className={BTN}
              >
                Media
              </button>
              <button
                type="button"
                aria-pressed={spaceGame}
                onClick={() => setSpaceGame(!spaceGame)}
                className={BTN}
              >
                Space game {spaceGame ? 'On' : 'Off'}
              </button>
            </div>
            <button
              type="button"
              disabled={controlsOff}
              onClick={() => {
                if (confirming === 'session') {
                  sendWs({ type: 'stopSession' });
                  navigate('/history');
                  return;
                }
                setConfirming('session');
              }}
              className={BTN_DANGER}
            >
              {confirming === 'session' ? 'Confirm stop' : 'Stop session'}
            </button>
          </div>
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="pointer-events-auto absolute bottom-[clamp(8px,1.15vw,40px)] left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-void/60 px-[clamp(12px,1.35vw,44px)] py-[clamp(4px,0.42vw,14px)] font-display text-[clamp(13px,0.94vw,30px)] uppercase tracking-[0.06em] text-dim backdrop-blur-[10px] hover:bg-ink/10 hover:text-ink"
      >
        Ride controls
      </button>
    </>
  );
}

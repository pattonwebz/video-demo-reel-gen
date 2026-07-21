import type { PointerSample } from '../engine/types';

/**
 * Pointer telemetry from the demoed page. `getDisplayMedia` only captures
 * pixels — it cannot see the cursor of another window — so the page being
 * demoed runs a small snippet (bookmarklet) that streams pointermove/click
 * events back here via postMessage. Timestamps are epoch ms (same machine,
 * same clock); the receiver rebases them onto recording-start.
 *
 * Coordinates are normalized to the demo page's viewport, which matches the
 * captured surface when the user records that browser tab — recording a
 * whole window/screen skews them by the browser chrome.
 */

const MARKER = '__demoTelemetry';

interface TelemetryMessage {
  [MARKER]: 1;
  t: number;
  x: number;
  y: number;
  kind: 'move' | 'click';
}

function isTelemetryMessage(d: unknown): d is TelemetryMessage {
  return typeof d === 'object' && d !== null && (d as Record<string, unknown>)[MARKER] === 1;
}

/** The snippet the user runs on the demoed page (as a bookmarklet or pasted in devtools). */
export function buildBookmarklet(): string {
  const src =
    `(()=>{if(window.__dtOn)return alert('demo telemetry already on');` +
    `var w=window.opener||(window.parent!==window?window.parent:null);` +
    `if(!w)return alert('No opener window found — open this page with the app\\'s Open button (not by navigating here yourself), then run the bookmarklet again.');` +
    `window.__dtOn=1;` +
    `var s=function(k,e){try{w.postMessage({${MARKER}:1,t:Date.now(),x:e.clientX/innerWidth,y:e.clientY/innerHeight,kind:k},'*')}catch(_){}};` +
    `var l=0;addEventListener('pointermove',function(e){var n=Date.now();if(n-l>50){l=n;s('move',e)}},true);` +
    `addEventListener('click',function(e){s('click',e)},true);` +
    `alert('demo telemetry on')})()`;
  return `javascript:${src}`;
}

export class TelemetryReceiver {
  private samples: PointerSample[] = [];
  private startEpoch = 0;
  private listening = false;

  private onMessage = (e: MessageEvent) => {
    const d: unknown = e.data;
    if (!isTelemetryMessage(d)) return;
    const t = d.t - this.startEpoch;
    if (t < 0) return;
    this.samples.push({ t, x: d.x, y: d.y, kind: d.kind === 'click' ? 'click' : 'move' });
  };

  begin(startEpochMs: number): void {
    this.samples = [];
    this.startEpoch = startEpochMs;
    if (!this.listening) {
      window.addEventListener('message', this.onMessage);
      this.listening = true;
    }
  }

  end(): PointerSample[] {
    if (this.listening) {
      window.removeEventListener('message', this.onMessage);
      this.listening = false;
    }
    return this.samples;
  }
}

/**
 * Opens the page to demo in a new tab so its bookmarklet can reach
 * window.opener. Deliberately opened with no size/feature string — passing
 * one (e.g. 'width=1280,height=800') makes browsers spawn a chromeless popup
 * with no bookmarks bar, leaving no way to click a saved bookmarklet there.
 */
export function openDemoPage(url: string): void {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  window.open(withScheme, 'demo-page');
}

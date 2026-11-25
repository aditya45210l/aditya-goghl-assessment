import { useEffect, useRef, useState } from 'react';

export type LiveFrame = { seq: number; type: string; contact: string; [k: string]: unknown };

// Keeps a WebSocket open for one workspace and calls onFrame for each change.
// If the connection drops it reconnects with ?after=<last seq seen>, so nothing is missed.
export function useLiveEvents(workspace: string | null, onFrame: (f: LiveFrame) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onFrame);
  handler.current = onFrame;

  useEffect(() => {
    if (!workspace) return;
    let lastSeq: number | null = null;
    let socket: WebSocket | null = null;
    let retryMs = 500;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const after = lastSeq === null ? '' : '&after=' + lastSeq;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`);
      socket.onopen = () => { setConnected(true); retryMs = 500; };
      socket.onmessage = (m) => {
        const frame = JSON.parse(m.data) as LiveFrame;
        if (typeof frame.seq !== 'number' || (lastSeq !== null && frame.seq <= lastSeq)) return;
        lastSeq = frame.seq;
        handler.current(frame);
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 8000); // back off while the server is away
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [workspace]);

  return connected;
}

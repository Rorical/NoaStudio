import { useEffect, useRef, useState } from 'react';
import { EngineClient } from './EngineClient';

export function useEngine() {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const engine = new EngineClient();
    const workletUrl = new URL('./audio-worklet.ts', import.meta.url);
    engine
      .init(workletUrl)
      .then(() => {
        if (cancelled) {
          engine.dispose();
          return;
        }
        ref.current = engine;
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
      ref.current?.dispose();
      ref.current = null;
    };
  }, []);

  return { engineRef: ref, ready, error };
}

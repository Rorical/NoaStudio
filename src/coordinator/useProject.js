import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCoordinator } from './connectCoordinator';

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

export function useProject(selector) {
  const bridge = getCoordinator();
  const cacheRef = useRef({ state: null, selected: undefined });

  const subscribe = useCallback((cb) => bridge.subscribe(cb), [bridge]);

  const getSnapshot = useCallback(() => {
    const state = bridge.getState();
    if (state !== cacheRef.current.state) {
      const next = selector(state);
      if (!shallowEqual(cacheRef.current.selected, next)) {
        cacheRef.current = { state, selected: next };
      } else {
        cacheRef.current.state = state;
      }
    }
    return cacheRef.current.selected;
  }, [bridge, selector]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useDispatch() {
  const bridge = getCoordinator();
  return useCallback((action) => bridge.dispatch(action), [bridge]);
}

export function useUndoRedo() {
  const bridge = getCoordinator();
  const [, force] = useState(0);
  useEffect(() => bridge.subscribe(() => force((n) => n + 1)), [bridge]);
  const undo = useCallback(() => bridge.undo(), [bridge]);
  const redo = useCallback(() => bridge.redo(), [bridge]);
  return {
    canUndo: bridge.canUndo(),
    canRedo: bridge.canRedo(),
    undo,
    redo,
  };
}

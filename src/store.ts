export type StateUpdater<T> = Partial<T> | ((state: T) => Partial<T>);

export type Store<T> = {
  getState: () => T;
  setState: (updater: StateUpdater<T>) => void;
  subscribe: (listener: (state: T) => void) => () => void;
};

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<(state: T) => void>();

  return {
    getState: () => state,
    setState: (updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater;
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener(state));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { Mediator } from "./mediator.ts";
import type { UiState } from "./state.ts";

/**
 * Presenters (MVP) read the Root's Mediator: each one takes only the regions its view draws, so
 * a change elsewhere (a key typed in Settings, a run that changed) re-renders that view alone.
 * The Root provides the Mediator; its events still bubble up the hierarchy as before.
 */
export const MediatorContext = createContext<Mediator | null>(null);

export interface Kept<T> { state: UiState; value: T }

/** The value drawn last while it is still the same: for the same state, or an equal one. */
export function keep<T>(cache: Kept<T> | null, state: UiState, select: (state: UiState) => T, isEqual: (a: T, b: T) => boolean = Object.is): Kept<T> {
  if (cache && cache.state === state) return cache;
  const value = select(state);
  return { state, value: cache && isEqual(cache.value, value) ? cache.value : value };
}

/**
 * Selects regions of the state, kept while every one of them is the same object: a transition
 * keeps each region it does not change.
 */
export function regions<K extends keyof UiState>(...keys: K[]): (state: UiState) => Pick<UiState, K> {
  return (state) => Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<UiState, K>;
}

export function sameRegions<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as Array<keyof T>).every((key) => a[key] === b[key]);
}

function useMediator(): Mediator {
  const mediator = useContext(MediatorContext);
  if (mediator === null) throw new Error("a Presenter needs the Root's MediatorContext above it");
  return mediator;
}

/**
 * Reads the Mediator's state at the moment of an event, re-rendering for nothing: for a parent
 * on the chain that acts on what an event it passed up changed (the Mediator decides at once).
 */
export function useStateNow(): () => UiState {
  return useMediator().getState;
}

/** Reads one value from the Mediator's state, re-rendering only when it changes. */
export function useSelected<T>(select: (state: UiState) => T, isEqual?: (a: T, b: T) => boolean): T {
  const mediator = useMediator();
  const cache = useRef<Kept<T> | null>(null);
  const read = (): T => (cache.current = keep(cache.current, mediator.getState(), select, isEqual)).value;
  return useSyncExternalStore(mediator.subscribe, read, read);
}

/** The regions a Presenter draws, re-rendering only when one of them changes. */
export function useRegions<K extends keyof UiState>(...keys: K[]): Pick<UiState, K> {
  return useSelected(regions(...keys), sameRegions);
}

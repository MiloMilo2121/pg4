import type { State } from './data';

/** What every view + modal receives from the page shell. */
export interface ViewProps {
  st: State;
  set: (patch: Partial<State>) => void;
  /** animated count-up used by the Italia map tooltip. */
  startCount: (target: number) => void;
}

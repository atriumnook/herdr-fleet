/**
 * Events bubble from a view up the component hierarchy to the Root's Mediator. A view only calls
 * the `Emit` its parent handed it; each parent on the way may add what it knows (which run, which
 * group) and pass the event on, or handle it and stop it: a Chain of Responsibility.
 */
export type Emit<E> = (event: E) => void;

/** A parent's link in the chain: what a child emits goes through `step`, which may pass it on with `pass`. */
export function relay<Child, Parent>(pass: Emit<Parent>, step: (event: Child, pass: Emit<Parent>) => void): Emit<Child> {
  return (event) => step(event, pass);
}

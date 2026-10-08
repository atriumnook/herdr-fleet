import { Droplet, type DropletEvent } from "../components/Droplet.tsx";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

/** The in-app alert's Presenter: the notice shown and how far along it is. Draws nothing while none shows. */
export function DropletPresenter({ emit }: { emit: Emit<DropletEvent> }) {
  const shown = useSelected((state) => state.droplet.shown);
  const phase = useSelected((state) => state.droplet.phase);
  if (shown === null) return null;
  return <Droplet key={shown.id} model={{ notice: shown, title: displayPaneTitle(shown.pane), phase }} emit={emit} />;
}

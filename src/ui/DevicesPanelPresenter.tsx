import { useMemo } from "react";
import type { HealthAuth } from "../../shared/protocol.ts";
import { DevicesPanel, type DevicesPanelEvent } from "../components/DevicesPanel.tsx";
import type { Emit } from "./bubble.ts";
import { devicesPanelModel } from "./devicesView.ts";
import { useSelected } from "./presenter.ts";

/** Settings → Devices' Presenter: it reads the devices region alone. */
export function DevicesPanelPresenter({ pairUrl, auth, emit }: { pairUrl: string | null; auth: HealthAuth | null; emit: Emit<DevicesPanelEvent> }) {
  const devices = useSelected((state) => state.devices);
  const model = useMemo(() => devicesPanelModel(devices, pairUrl, auth), [devices, pairUrl, auth]);
  return <DevicesPanel model={model} emit={emit} />;
}

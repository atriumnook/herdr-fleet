import type { HealthAuth, PairedDevice } from "../../shared/protocol.ts";
import type { DevicesState } from "./state.ts";

/** What Settings → Devices draws, built from the Mediator's devices region. */
export interface DevicesPanelModel {
  /** how this browser got in */
  via: HealthAuth["via"];
  list: PairedDevice[] | null;
  /** the server keeps no devices: nothing to pair here */
  unavailable: boolean;
  failure: DevicesState["failure"];
  /** the code out, spaced for reading; `link` opens the app with it filled in when a phone can reach this one */
  pairing: { code: string; spaced: string; expiresAt: string; link: string | null } | null;
  justPaired: string | null;
  renaming: DevicesState["renaming"];
  confirming: string | null;
}

export function devicesPanelModel(devices: DevicesState, pairUrl: string | null, auth: HealthAuth | null): DevicesPanelModel {
  const code = devices.code;
  return {
    via: auth?.via,
    list: devices.list,
    unavailable: devices.unavailable,
    failure: devices.failure,
    pairing: code === null ? null : {
      code: code.code,
      spaced: `${code.code.slice(0, 3)} ${code.code.slice(3)}`,
      expiresAt: code.expires_at,
      link: pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null,
    },
    justPaired: devices.justPaired,
    renaming: devices.renaming,
    confirming: devices.confirming,
  };
}

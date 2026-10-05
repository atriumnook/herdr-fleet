import { useMemo, type ReactNode } from "react";
import { SettingsDialog, type SettingsDialogEvent, type SettingsDialogProps } from "../components/SettingsDialog.tsx";
import type { Emit } from "./bubble.ts";
import { useRegions } from "./presenter.ts";
import { settingsDialogModel } from "./settingsView.ts";

export interface SettingsDialogPresenterProps {
  install: SettingsDialogProps["install"];
  alerts: ReactNode;
  /** the parent's paired devices panel, given where a phone can open this app */
  devices: (pairUrl: string | null) => ReactNode;
  emit: Emit<SettingsDialogEvent>;
}

/**
 * The Settings dialog's Presenter: it reads the settings, the dialog and the remote access, so a
 * key typed into the dialog re-renders the dialog alone. Draws nothing while the dialog is closed.
 */
export function SettingsDialogPresenter({ install, alerts, devices, emit }: SettingsDialogPresenterProps) {
  const state = useRegions("settings", "settingsDialog", "remoteAccess");
  const model = useMemo(() => settingsDialogModel(state, { protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }), [state]);
  if (!model) return null;
  return <SettingsDialog model={model} install={install} alerts={alerts} devices={devices(model.pairUrl)} emit={emit} />;
}

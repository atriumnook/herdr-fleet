import { createContext, useContext, useMemo } from "react";
import * as api from "./api.ts";
export const MachineContext = createContext("local");
export const useMachineId = () => useContext(MachineContext);
/** Bound functions retain their owner across an async upload or a fast PC switch. */
export function useMachineApi() {
  const id = useMachineId();
  return useMemo(() => ({
    uploadPaneImage: (pane: string, image: Blob) => api.uploadPaneImage(pane, image, id),
  }), [id]);
}

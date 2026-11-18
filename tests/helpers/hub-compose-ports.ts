import { hubListenerPorts } from "./hub-listener-ports.js";

/** Ports used by the compose acceptance fixture. */
export async function hubComposePorts() {
  const leases = hubListenerPorts();
  try {
    return { memberPort: await leases.next(), webPort: await leases.next(), close: leases.close };
  } catch (error) {
    await leases.close();
    throw error;
  }
}

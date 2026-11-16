import type { connectInstallInfo } from "../../connect/install.js";
export function connectorPrompt(info: ReturnType<typeof connectInstallInfo>, app: string, where: string, translate: (key: string) => string): string;
export function hubConnectorPrompt(address: string, app: string, translate: (key: string) => string): string;

/** M-3454: opt-in settings only. No I/O, providers, timers, workers or stores are created by reading them. */
export interface HostMonitoringConfig { enabled: boolean; agent_footprint: boolean }
// The first settings slice cannot claim collection exists. The collector slice
// changes this only when its production lifecycle is connected and tested.
export const HOST_MONITORING_COLLECTOR_AVAILABLE = false;
export const HOST_MONITORING_KEYS = ['enabled', 'agent_footprint'] as const;
export function monitoringProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be a mapping';
  for (const [key, setting] of Object.entries(value)) {
    if (!(HOST_MONITORING_KEYS as readonly string[]).includes(key)) return `unknown key: ${key}`;
    if (typeof setting !== 'boolean') return `${key} must be a boolean`;
  }
  return null;
}
export function monitoringConfig(value?: unknown): HostMonitoringConfig {
  if (value !== undefined) { const problem = monitoringProblem(value); if (problem) throw new Error(`monitoring: ${problem}`); }
  const v = value as Partial<HostMonitoringConfig> | undefined;
  // Explicit literals, never a changeable default or an environment override.
  return { enabled: v?.enabled === true, agent_footprint: v?.agent_footprint === true };
}
export function parseMonitoringSettings(body: unknown): { patch: Partial<HostMonitoringConfig> } | { error: string } {
  if (monitoringProblem(body) || !Object.keys(body as object).length) return { error: 'invalid_monitoring_settings' };
  return { patch: { ...body as Partial<HostMonitoringConfig> } };
}

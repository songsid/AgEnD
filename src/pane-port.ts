/** Terminal operations used by the daemon. A handle's object identity fences in-flight work. */
export interface PaneSize { columns: number; rows: number }
export type PaneKey = "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q";
export interface PaneInputProof { kind: "composer" | "dialog"; screen: string }
export interface PaneStatus { alive: boolean; exitCode?: number; pid?: number }
export interface PaneOutputEvent { paneId: string; windowId?: string; at: number }
export type PaneOutputEventName = `output:${string}`;

export interface Pane {
  createWindow(command: string, cwd: string, windowName?: string): Promise<string>;
  respawnWindow(command: string, cwd: string): Promise<void>;
  killWindow(): Promise<void>;
  killWindowConfirmed(): Promise<boolean>;
  isWindowAlive(): Promise<boolean>;
  setRemainOnExit(): Promise<void>;
  getPaneStatus(): Promise<PaneStatus | null>;
  getWindowGeometry(): Promise<PaneSize & { mode: string }>;
  getPaneInputMode(): Promise<"raw" | "cooked" | "unknown">;
  sendKeys(text: string, proof?: PaneInputProof): Promise<boolean>;
  sendKeySequence(keys: readonly string[]): Promise<boolean>;
  sendSpecialKey(key: PaneKey, timeoutMs?: number, proof?: PaneInputProof): Promise<boolean>;
  deleteBackward(count: number, timeoutMs?: number): Promise<boolean>;
  getLastSendSpecialKeyError(): string | null;
  getLastPasteError(): string | null;
  isLastPasteFailureRecoverable(): boolean;
  pasteText(text: string, opts?: { retryEnter?: boolean }): Promise<boolean>;
  pasteBuffer(text: string, opts?: { guard?: () => boolean; timeoutMs?: number; proof?: PaneInputProof }): Promise<boolean>;
  pipeOutput(logPath: string): Promise<void>;
  capturePane(timeoutMs?: number): Promise<string>;
  capturePaneWithHistory(lines?: number, timeoutMs?: number): Promise<string>;
  capturePaneJoined(lines?: number): Promise<string>;
  getWindowId(): string;
}

/** Output timestamps are wall-clock times. Unknown/blind observations never prove idle. */
export interface PaneObservation {
  start(): void;
  stop(): void;
  registerWindow(id: string): Promise<void>;
  unregisterWindow(id: string): void;
  getObservationResetAt(): number;
  isObservationBlind(): boolean;
  isIdle(id: string): boolean;
  getLastOutputAt(id: string): number | undefined;
  hasOutputSince(id: string, ts: number): boolean;
  waitForIdle(id: string, timeoutMs?: number): Promise<boolean>;
  waitUntilIdle(id: string, timeoutMs?: number, abandoned?: () => boolean): Promise<boolean>;
  waitForOutput(id: string, timeoutMs?: number): Promise<boolean>;
  on(event: PaneOutputEventName, listener: (event: PaneOutputEvent) => void): this;
  on(event: "safety_sweep", listener: (event: { at: number }) => void): this;
  removeListener(event: PaneOutputEventName, listener: (event: PaneOutputEvent) => void): this;
  removeListener(event: "safety_sweep", listener: (event: { at: number }) => void): this;
}

/** Session supervision stays with the host. PID methods refer only to host-local processes. */
export interface PaneHost {
  /** Only local hosts can prove a coordinator-local PID. */
  readonly executionHost?: "local" | "remote";
  bind(session: string, id: string, size?: PaneSize, observation?: PaneObservation): Pane;
  ensureSession(session: string): Promise<void>;
  sessionExists(session: string): Promise<boolean>;
  sessionExistsStrict(session: string): Promise<boolean>;
  killSession(session: string): Promise<void>;
  getServerPid(session: string): Promise<number | null>;
  listWindows(session: string, observation?: PaneObservation): Promise<Array<{ id: string; name: string }>>;
  listWindowsStrict(session: string, observation?: PaneObservation): Promise<Array<{ id: string; name: string }>>;
  getPanePid(session: string, id: string, timeoutMs?: number): Promise<number | null>;
  listPanePids(session: string, timeoutMs?: number): Promise<Array<{ pid: number; window: string }>>;
}

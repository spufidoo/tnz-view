export interface HostProfile {
  id: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  secure: boolean;
  verifyCert: boolean;
  luName?: string;
  tn3270e?: boolean;
  codePage: string;
  psSize: string;
  secLevel?: number;
}

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "lost";

export interface SidecarCommand {
  op: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ScreenEvent {
  op: "screen";
  sessionId: string;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  lock: boolean;
  text: string;
  fa: string;
  fg: string;
  bg: string;
  eh: string;
  extendedColor: boolean;
}

export interface StatusEvent {
  op: "status";
  sessionId: string;
  connected: boolean;
  tls: boolean;
  lu: string;
  seslost: boolean;
  lock: boolean;
}

export interface ErrorEvent {
  op: "error";
  sessionId: string;
  message: string;
  lock?: boolean;
}

export type SidecarEvent =
  | { op: "ready" }
  | ScreenEvent
  | StatusEvent
  | ErrorEvent;

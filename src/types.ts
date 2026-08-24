/** The eight 3270 colour values plus the screen background. */
export interface HostColors {
  background: string;
  black: string;
  blue: string;
  red: string;
  pink: string;
  green: string;
  turquoise: string;
  yellow: string;
  white: string;
}

/** IBM Personal Communications defaults. */
export const DEFAULT_COLORS: HostColors = {
  background: "#000000",
  black: "#000000",
  blue: "#7890f0",
  red: "#f01818",
  pink: "#ff00ff",
  green: "#24d830",
  turquoise: "#58f0f0",
  yellow: "#ffff00",
  white: "#ffffff",
};

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
  /** Advertise colour capability so the host may send extended colour orders. */
  extendedColor?: boolean;
  /** Render the extended-highlight blink attribute instead of ignoring it. */
  blink?: boolean;
  colors?: HostColors;
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
  attr: string;
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

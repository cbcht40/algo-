// Tradovate's websocket uses a SockJS-style text-frame protocol.
//
//   "o"              -> open frame (server is ready, send `authorize` next)
//   "h"              -> heartbeat from server
//   "c[...]"         -> close frame
//   "a[ {...}, ...]" -> array of messages (responses + events)
//
// A *request* we send is a 4-line string: `endpoint\nid\nquery\nbody`.
// The client must also send an empty-array frame "[]" every ~2.5s as a keep-alive.

export interface ServerMessage {
  /** request id this message answers (present on responses) */
  i?: number;
  /** http-like status code (present on responses) */
  s?: number;
  /** payload (response data or event data) */
  d?: any;
  /** event channel: "props" | "md" | "chart" | "clock" | "shutdown" ... (present on events) */
  e?: string;
}

export type ServerFrame =
  | { type: "o" }
  | { type: "h" }
  | { type: "c"; data: unknown }
  | { type: "a"; messages: ServerMessage[] };

export function parseFrame(raw: string): ServerFrame {
  const type = raw[0];
  const body = raw.slice(1);
  switch (type) {
    case "o":
      return { type: "o" };
    case "h":
      return { type: "h" };
    case "c":
      return { type: "c", data: body ? safeJson(body) : null };
    case "a":
      return { type: "a", messages: (safeJson(body) ?? []) as ServerMessage[] };
    default:
      throw new Error(`Unknown websocket frame: ${JSON.stringify(raw.slice(0, 60))}`);
  }
}

/** Build the `endpoint\nid\nquery\nbody` request frame. */
export function buildRequestFrame(
  endpoint: string,
  id: number,
  query = "",
  body = "",
): string {
  return `${endpoint}\n${id}\n${query}\n${body}`;
}

export const HEARTBEAT_FRAME = "[]";

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

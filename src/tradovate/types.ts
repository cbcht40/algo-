// Minimal, tolerant models of the Tradovate entities we actually use.
// Every entity may carry extra fields we ignore — we only type what we read.

export type Environment = "demo" | "live";

export interface AccessKey {
  name: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: number;
  sec: string;
  deviceId: string;
}

export interface TokenResponse {
  accessToken: string;
  mdAccessToken?: string;
  expirationTime: string; // ISO timestamp
  userId: number;
  userStatus?: string;
  name?: string;
  // penalty fields (present instead of a token when rate-limited)
  "p-ticket"?: string;
  "p-time"?: number;
  "p-captcha"?: boolean;
  errorText?: string;
}

export interface Account {
  id: number;
  name: string; // this is the accountSpec used in order requests
  userId: number;
  active?: boolean;
  archived?: boolean;
}

export type OrderAction = "Buy" | "Sell";
export type OrderType = "Market" | "Limit" | "Stop" | "StopLimit" | "MIT" | "TrailingStop";

export interface Order {
  id: number;
  accountId: number;
  contractId: number;
  timestamp?: string;
  action: OrderAction;
  ordStatus: string; // PendingNew | Working | Completed | Canceled | Rejected | Expired | Filled ...
  admin?: boolean;
}

export interface OrderVersion {
  id: number;
  orderId: number;
  orderQty: number;
  orderType: OrderType;
  price?: number;
  stopPrice?: number;
  timeInForce?: string; // Day | GTC | IOC | FOK ...
  maxShow?: number;
}

export interface Fill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp?: string;
  action: OrderAction;
  qty: number;
  price: number;
}

export interface Position {
  id: number;
  accountId: number;
  contractId: number;
  netPos: number;
  netPrice?: number;
}

export interface Contract {
  id: number;
  name: string;
}

/** A property/entity event pushed over the websocket after user/syncrequest. */
export interface PropsEvent {
  entityType: string; // "order" | "orderVersion" | "fill" | "position" | "account" | ...
  eventType: "Created" | "Updated" | "Deleted" | string;
  entity: Record<string, unknown>;
}

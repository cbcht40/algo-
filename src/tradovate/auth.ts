import { createHash } from "node:crypto";
import type { AccessKey, Environment, TokenResponse } from "./types";

export const REST_BASE: Record<Environment, string> = {
  demo: "https://demo.tradovateapi.com/v1",
  live: "https://live.tradovateapi.com/v1",
};

export const WS_URL: Record<Environment, string> = {
  demo: "wss://demo.tradovateapi.com/v1/websocket",
  live: "wss://live.tradovateapi.com/v1/websocket",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stable, deterministic deviceId per login. Tradovate ties MFA trust to the
 * deviceId, so keeping it stable across runs avoids repeated MFA challenges.
 */
export function deviceIdFor(name: string): string {
  const h = createHash("sha256").update(`tradovate-copier:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Exchange credentials + API key for an access token.
 * Handles Tradovate's "penalty" throttling: a 200 response that contains a
 * `p-ticket` instead of a token means "wait p-time seconds then retry with the
 * ticket". A `p-captcha` means a human must log in via the web first.
 */
export async function acquireAccessToken(
  baseUrl: string,
  key: AccessKey,
): Promise<TokenResponse> {
  const url = `${baseUrl}/auth/accesstokenrequest`;
  let body: Record<string, unknown> = { ...key };

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<TokenResponse>(res, key.name);

    if (data.accessToken) return data;

    if (data["p-ticket"]) {
      if (data["p-captcha"]) {
        throw new Error(
          `[${key.name}] Captcha required — log in once via the Tradovate web app, then retry.`,
        );
      }
      const waitSec = data["p-time"] ?? 1;
      await sleep(waitSec * 1000);
      body = { ...key, "p-ticket": data["p-ticket"] };
      continue;
    }

    throw new Error(
      `[${key.name}] Auth failed (HTTP ${res.status}): ${data.errorText ?? JSON.stringify(data)}`,
    );
  }
  throw new Error(`[${key.name}] Auth failed after repeated penalty throttling.`);
}

/**
 * Renew an access token (REST GET with the current token). Works with ANY valid
 * token — including one lifted from a logged-in web session — and needs no
 * API key. We also use it to bootstrap "token mode": it returns userId and
 * expirationTime, which validates the token and tells us who it belongs to.
 */
export async function renewAccessToken(
  baseUrl: string,
  accessToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${baseUrl}/auth/renewAccessToken`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await readJson<TokenResponse>(res, "renew");
  if (!data.accessToken) {
    throw new Error(`Token renewal failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Read a JSON body, but fail with a readable message when the endpoint returns
 * something else (gateway/proxy errors, HTML, an egress-policy block, ...).
 */
async function readJson<T>(res: Response, who: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(
      `[${who}] Expected JSON from Tradovate but got HTTP ${res.status}: "${snippet}". ` +
        `If you see "host not allowed", outbound network access to tradovateapi.com is blocked here.`,
    );
  }
}

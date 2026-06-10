// Edge-plan entitlement gate. The copier is a paid Let-Trade Journal "Edge"
// feature: it unlocks order-copying only when the user's license key maps to an
// active Edge subscription, verified against the web backend. Two safety rules:
//   1. A failed/unreachable check NEVER cuts an already-licensed session — the
//      last good unlock is honoured for a long grace window (cached on disk),
//      so a network blip or a frozen backend can't stop you mid-trade.
//   2. The lock only blocks NEW copies; the engine still lets you cancel/close
//      already-mirrored orders, so a lapsed sub can flatten its positions.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";

const log = logger("license");

const VERIFY_URL = process.env.COPIER_VERIFY_URL || "https://let-tradejournal.com/api/copier-verify";
const RECHECK_MS = 6 * 60 * 60_000; // re-verify every 6h
const GRACE_MS = 72 * 60 * 60_000; // honour last good unlock for 72h if unreachable
const STATE_FILE = resolve(process.env.COPIER_LICENSE_STATE || ".copier-license.json");

export interface VerifyResult {
  unlocked: boolean;
  reachable: boolean; // did we get a definitive answer from the backend?
  plan?: string;
  status?: string;
  email?: string;
  error?: string;
}

export async function verifyLicense(key: string): Promise<VerifyResult> {
  try {
    const r = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    // 5xx = backend trouble → treat as unreachable (grace applies), not a denial.
    if (r.status >= 500) return { unlocked: false, reachable: false, error: `server ${r.status}` };
    const d = (await r.json().catch(() => ({}))) as Record<string, any>;
    return {
      unlocked: !!d.unlocked,
      reachable: true,
      plan: d.currentPlan ?? d.plan,
      status: d.status,
      email: d.email,
      error: d.unlocked ? undefined : d.error || `plan ${d.currentPlan ?? "?"}`,
    };
  } catch (err) {
    return { unlocked: false, reachable: false, error: String(err) };
  }
}

interface GateState {
  plan?: string;
  status?: string;
  email?: string;
  lastUnlockAt?: number; // last time a check definitively returned unlocked
  checkedAt?: number;
  reachable: boolean;
  unlocked: boolean; // last definitive answer
  error?: string;
}

export class LicenseGate {
  private key?: string;
  private state: GateState = { unlocked: false, reachable: false };
  private timer?: NodeJS.Timeout;
  // Dev/owner escape hatch: skip verification entirely on this machine.
  private bypass = process.env.COPIER_LICENSE_BYPASS === "1";

  /** True when copying is allowed. A reachable check is authoritative; an
   *  unreachable one falls back to the grace window anchored on the last good
   *  unlock — so a network blip can't cut a paying session, but going offline
   *  forever still locks after GRACE_MS. */
  get licensed(): boolean {
    if (this.bypass) return true;
    if (this.state.reachable) return this.state.unlocked;
    return !!this.state.lastUnlockAt && Date.now() - this.state.lastUnlockAt < GRACE_MS;
  }

  get graceActive(): boolean {
    return !this.state.reachable && this.licensed;
  }

  async start(key?: string): Promise<void> {
    this.key = key?.trim() || undefined;
    if (this.bypass) {
      log.warn("⚠ Licence Edge BYPASS (COPIER_LICENSE_BYPASS=1) — copie autorisée sans vérification.");
      return;
    }
    this.loadState();
    await this.check();
    this.timer = setInterval(() => void this.check(), RECHECK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (!this.key) {
      this.state = { unlocked: false, reachable: true, error: "no license key", checkedAt: Date.now() };
      return;
    }
    const r = await verifyLicense(this.key);
    this.state.checkedAt = Date.now();
    this.state.error = r.error;
    if (r.reachable) {
      this.state.reachable = true;
      this.state.unlocked = r.unlocked;
      this.state.plan = r.plan;
      this.state.status = r.status;
      this.state.email = r.email;
      if (r.unlocked) this.state.lastUnlockAt = Date.now();
      this.saveState();
      log.info(r.unlocked ? "Edge vérifié ✓ — copie autorisée." : `Verrouillé — ${r.error}.`);
    } else {
      this.state.reachable = false;
      log.warn(
        `Vérif licence injoignable (${r.error}). ` +
          (this.licensed ? "Copie maintenue (grâce)." : "Copie verrouillée."),
      );
    }
  }

  /** Snapshot for the dashboard. */
  status() {
    return {
      hasKey: !!this.key,
      licensed: this.licensed,
      graceActive: this.graceActive,
      bypass: this.bypass,
      plan: this.state.plan,
      subStatus: this.state.status,
      email: this.state.email,
      reachable: this.state.reachable,
      checkedAt: this.state.checkedAt,
      error: this.state.error,
    };
  }

  private loadState(): void {
    try {
      const d = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      // Trust only the grace anchor + descriptive fields from disk; a fresh
      // check sets unlocked/reachable.
      this.state.lastUnlockAt = d.lastUnlockAt;
      this.state.plan = d.plan;
      this.state.status = d.status;
      this.state.email = d.email;
    } catch {
      /* no cached state yet */
    }
  }

  private saveState(): void {
    try {
      writeFileSync(
        STATE_FILE,
        JSON.stringify(
          {
            lastUnlockAt: this.state.lastUnlockAt,
            plan: this.state.plan,
            status: this.state.status,
            email: this.state.email,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      log.debug(`Could not persist license state: ${String(err)}`);
    }
  }
}

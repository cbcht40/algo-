// Avis IA facultatif : aucun appel ni notification quand coupé ; les décisions
// de séance et la synchronisation du journal restent indépendantes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupEngine } from "../src/copier/group";
import { JournalLink, type ScoreRequest } from "../src/journal";
import type { Config } from "../src/config";

const request: ScoreRequest = { symbol: "MNQZ6", action: "Buy", qty: 1, accounts: 1, source: "panneau", ts: Date.now() };
const originalFetch = globalThis.fetch;
let calls = 0;
try {
  const link = new JournalLink({ key: "test-key", baseUrl: "http://example.invalid", scoreEnabled: false });
  globalThis.fetch = async (_url, init) => {
    calls++;
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (String(_url).endsWith("/api/copier-sync")) resolve(new Response(JSON.stringify({ ok: true, inserted: 0, updated: 0 }), { status: 200 }));
    });
  };
  assert.equal(await link.scoreEntry(request), null);
  assert.equal(calls, 0, "IA coupée : aucun appel distant");
  assert.equal(link.state().enabled, true, "la clé et le journal restent actifs");
  assert.equal((await link.syncNow()).error, undefined, "la synchro fonctionne sans IA");

  link.setScoreEnabled(true);
  const pending = link.scoreEntry(request);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(link.state().scoring, true);
  link.setScoreEnabled(false);
  assert.equal(await pending, null, "un avis déjà lancé est annulé sans résultat tardif");
  assert.equal(link.state().lastScore, null);
  assert.deepEqual(link.state().scores, []);
  assert.equal(link.state().scoring, false);

  const config = { relay: true, relayGuard: "alert", aiScoreEnabled: true } as Config;
  const engine = new GroupEngine(config);
  const directory = mkdtempSync(join(tmpdir(), "copier-ai-toggle-"));
  try {
    const path = join(directory, "config.json");
    engine.setPersistPath(path);
    engine.setJournal(link);
    assert.equal(engine.setAiScoreEnabled(false), false);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).aiScoreEnabled, false, "choix conservé au redémarrage");
    assert.equal(config.relay, true, "le relais n'est pas modifié");
    assert.equal(config.relayGuard, "alert", "le garde-fou n'est pas modifié");

    const captured: ScoreRequest[] = [];
    engine.setJournal({
      enabled: true,
      scoreEntry: async (req: ScoreRequest) => { captured.push(req); return null; },
    } as JournalLink);
    const input = { endpoint: "order/placeorder", action: "Buy", orderType: "Market", qty: 1, netPos: 0 };
    const base = { action: "Buy", qty: 1, accounts: 1, source: "panneau" };
    const internal = engine as unknown as { scoreIfDecision: (account: undefined, symbol: string, contractId: undefined, input: typeof input, req: typeof base & { symbol: string }) => unknown };
    internal.scoreIfDecision(undefined, "MNQZ6", undefined, input, { ...base, symbol: "MNQZ6" });
    internal.scoreIfDecision(undefined, "MESZ6", undefined, input, { ...base, symbol: "MESZ6" });
    assert.deepEqual(captured.map(req => req.session?.entryRank), [1, 2], "le premier trade n'est plus annoncé comme le deuxième");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log("✓ IA facultative, annulation en cours, synchro indépendante, préférence persistante et rang de séance exact");

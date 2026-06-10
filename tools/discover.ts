// Discovery helper for adding a new prop-firm login.
//
//   npx tsx tools/discover.ts <token>
//
// Given a Tradovate web-session token, it checks BOTH networks (demo + live),
// authenticates, and lists the trading accounts found on each — so you know
// which network a firm's accounts live on and their exact names/ids.
//
// The token is read from argv (or the TOKEN env var) and used only in memory;
// nothing is written to disk.
import { TradovateClient } from "../src/tradovate/client";
import type { Environment } from "../src/tradovate/types";

async function tryHost(environment: Environment, token: string): Promise<number> {
  const client = new TradovateClient({
    label: environment.toUpperCase(),
    environment,
    appId: "MacCopier",
    appVersion: "0.1",
    accessToken: token,
  });
  try {
    await client.start();
    return client.accounts.length;
  } catch (err) {
    console.error(`  [${environment}] could not connect: ${String(err)}`);
    return 0;
  } finally {
    await client.stop();
  }
}

async function main(): Promise<void> {
  const token = process.argv[2] ?? process.env.TOKEN;
  if (!token) {
    console.error("Usage: npx tsx tools/discover.ts <token>");
    process.exit(1);
  }
  console.log("\nChecking both Tradovate networks for this login's accounts…\n");
  const demo = await tryHost("demo", token);
  const live = await tryHost("live", token);

  const net =
    demo > 0 && live === 0 ? "demo" : live > 0 && demo === 0 ? "live" : null;
  console.log("\n──────────────────────────────────────────────");
  console.log(`  demo: ${demo} account(s)   |   live: ${live} account(s)`);
  if (net) {
    console.log(`  → Use  "environment": "${net}"  for this login's accounts.`);
  } else if (demo > 0 && live > 0) {
    console.log("  → Accounts on BOTH networks (unusual) — tell me both.");
  } else {
    console.log("  → No accounts found: token expired (grab a fresh one) or wrong login.");
  }
  console.log("──────────────────────────────────────────────\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

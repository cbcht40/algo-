// Interactive setup for a multi-login copier config — no fragile giant paste.
//
//   npx tsx tools/setup.ts
//
// Paste each prop-firm token one per line. For every token it auto-detects the
// network (demo/live) and lists the login's accounts. Then you pick the master,
// and it writes a correct config.json (every login gets its own token; logins on
// a different network than the master get a per-account "environment").
//
// Tokens are entered at the prompt and only the resulting config.json is written.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
import { TradovateClient } from "../src/tradovate/client";
import type { Account, Environment } from "../src/tradovate/types";
import { setLogLevel } from "../src/logger";

interface Login {
  token: string;
  env: Environment;
  accounts: Account[];
}

async function discover(token: string): Promise<{ env: Environment; accounts: Account[] } | null> {
  for (const env of ["demo", "live"] as Environment[]) {
    const c = new TradovateClient({
      label: env,
      environment: env,
      appId: "MacCopier",
      appVersion: "0.1",
      accessToken: token,
    });
    try {
      await c.start();
      const accounts = c.accounts;
      await c.stop();
      if (accounts.length > 0) return { env, accounts };
    } catch {
      await c.stop();
    }
  }
  return null;
}

async function main(): Promise<void> {
  setLogLevel("warn"); // keep the prompts readable
  const rl = createInterface({ input, output });

  const logins: Login[] = [];
  console.log("\nPaste each prop-firm token, one per line. Empty line when done.\n");
  for (let i = 1; ; i++) {
    const raw = (await rl.question(`  Token #${i} (Enter to finish): `))
      .trim()
      .replace(/^Bearer\s+/i, "");
    if (!raw) break;
    process.stdout.write("    → discovering… ");
    const found = await discover(raw);
    if (!found) {
      console.log("no accounts (token expired/invalid?) — skipped.");
      continue;
    }
    console.log(`${found.accounts.length} account(s) on "${found.env}": ${found.accounts.map((a) => a.name).join(", ")}`);
    logins.push({ token: raw, ...found });
  }

  const all = logins.flatMap((l, li) => l.accounts.map((a) => ({ name: a.name, li })));
  if (all.length === 0) {
    console.log("\nNo accounts found. Grab fresh tokens and retry.");
    rl.close();
    process.exit(1);
  }

  console.log("\nAll accounts found:");
  all.forEach((a, idx) =>
    console.log(`  [${idx}]  ${a.name}   (login #${a.li + 1}, ${logins[a.li]!.env})`),
  );
  const ans = (await rl.question("\nWhich number is your MASTER (the account you trade on)? ")).trim();
  rl.close();

  const pick = Number(ans);
  const master = all[pick];
  if (!Number.isInteger(pick) || !master) {
    console.log("Invalid number — nothing written.");
    process.exit(1);
  }

  const masterLogin = logins[master.li]!;
  const followers = all
    .filter((_, idx) => idx !== pick)
    .map((a) => {
      const f: Record<string, unknown> = { label: a.name, accountSpec: a.name, multiplier: 1 };
      // Followers on a different login than the master need that login's token…
      if (a.li !== master.li) f.accessToken = logins[a.li]!.token;
      // …and its network, if it differs from the master's.
      if (logins[a.li]!.env !== masterLogin.env) f.environment = logins[a.li]!.env;
      return f;
    });

  const config = {
    environment: masterLogin.env,
    appId: "MacCopier",
    appVersion: "0.1",
    dryRun: true,
    auth: { mode: "token", accessToken: masterLogin.token },
    master: { label: master.name, accountSpec: master.name },
    followers,
  };
  writeFileSync("config.json", JSON.stringify(config, null, 2));
  console.log(
    `\n✓ Wrote config.json — master "${master.name}" + ${followers.length} follower(s), dryRun:true.`,
  );
  console.log("  Start it with:  LOG_LEVEL=debug npm start\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

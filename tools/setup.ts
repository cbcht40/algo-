// One-time calibration for a set-and-forget copier.
//
//   npm run setup        (or: npx tsx tools/setup.ts)
//
// For each prop firm, enter the Tradovate username+password of that login.
// The tool verifies the login (demo then live), lists its accounts, lets you
// pick the master, and writes config.json in "credentials" mode — after which
// the copier mints and renews its own tokens forever (no DevTools, no pasting).
//
// If a login refuses password auth (captcha…), you can paste a web-session
// token for that firm instead — everything else stays automatic.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
import { TradovateClient } from "../src/tradovate/client";
import type { Account, Environment } from "../src/tradovate/types";
import { setLogLevel } from "../src/logger";

interface Login {
  // exactly one of (name+password) | token
  name?: string;
  password?: string;
  token?: string;
  env: Environment;
  accounts: Account[];
}

type Creds = { name: string; password: string } | { token: string };

async function discover(creds: Creds): Promise<{ env: Environment; accounts: Account[] } | string> {
  let lastError = "no accounts found on demo or live";
  for (const env of ["demo", "live"] as Environment[]) {
    const c = new TradovateClient({
      label: env,
      environment: env,
      appId: "MacCopier",
      appVersion: "0.1",
      ...("token" in creds ? { accessToken: creds.token } : creds),
    });
    try {
      await c.start();
      const accounts = c.accounts;
      await c.stop();
      if (accounts.length > 0) return { env, accounts };
    } catch (err) {
      lastError = String(err);
      await c.stop();
    }
  }
  return lastError;
}

async function main(): Promise<void> {
  setLogLevel("error"); // keep the prompts readable
  const rl = createInterface({ input, output });
  console.log(
    "\n── Calibration du copieur ─────────────────────────────────────\n" +
      "Pour chaque firme (Tradovate, Lucid, Apex…), entre l'email/login et\n" +
      "le mot de passe du compte Tradovate correspondant. Une fois calibré,\n" +
      "le copieur se connecte et se renouvelle tout seul.\n",
  );

  const logins: Login[] = [];
  for (let i = 1; ; i++) {
    const name = (await rl.question(`  Login/email firme #${i} (Entrée pour terminer) : `)).trim();
    if (!name) break;
    const password = (await rl.question(`  Mot de passe ${name} : `)).trim();
    process.stdout.write("    → connexion… ");
    const found = await discover({ name, password });
    if (typeof found === "string") {
      console.log(`ÉCHEC : ${found}`);
      const tok = (
        await rl.question("    Token de session en secours pour cette firme (ou Entrée pour passer) : ")
      )
        .trim()
        .replace(/^Bearer\s+/i, "");
      if (!tok) continue;
      process.stdout.write("    → connexion par token… ");
      const viaTok = await discover({ token: tok });
      if (typeof viaTok === "string") {
        console.log(`ÉCHEC : ${viaTok} — firme ignorée.`);
        continue;
      }
      console.log(`${viaTok.accounts.length} compte(s) [${viaTok.env}] : ${viaTok.accounts.map((a) => a.name).join(", ")}`);
      logins.push({ token: tok, ...viaTok });
      continue;
    }
    console.log(`${found.accounts.length} compte(s) [${found.env}] : ${found.accounts.map((a) => a.name).join(", ")}`);
    logins.push({ name, password, ...found });
  }

  const all = logins.flatMap((l, li) => l.accounts.map((a) => ({ name: a.name, li })));
  if (all.length === 0) {
    console.log("\nAucun compte trouvé — rien d'écrit.");
    rl.close();
    process.exit(1);
  }

  console.log("\nComptes trouvés :");
  all.forEach((a, idx) =>
    console.log(`  [${idx}]  ${a.name}   (firme #${a.li + 1}, ${logins[a.li]!.env})`),
  );
  const ans = (await rl.question("\nNuméro du compte MAÎTRE (celui sur lequel tu trades) : ")).trim();
  const pick = Number(ans);
  const master = all[pick];
  if (!Number.isInteger(pick) || !master) {
    console.log("Numéro invalide — rien d'écrit.");
    rl.close();
    process.exit(1);
  }

  const real =
    (await rl.question("Activer le mode RÉEL tout de suite ? (o/N — N = simulation [DRY]) : "))
      .trim()
      .toLowerCase() === "o";
  rl.close();

  const masterLogin = logins[master.li]!;
  const credsOf = (l: Login) =>
    l.token ? { accessToken: l.token } : { name: l.name, password: l.password };

  const followers = all
    .filter((_, idx) => idx !== pick)
    .map((a) => {
      const l = logins[a.li]!;
      return {
        label: a.name,
        accountSpec: a.name,
        multiplier: 1,
        ...credsOf(l),
        ...(l.env !== masterLogin.env ? { environment: l.env } : {}),
      };
    });

  const config = {
    environment: masterLogin.env,
    appId: "MacCopier",
    appVersion: "0.1",
    dryRun: !real,
    auth: { mode: "credentials" },
    master: { label: master.name, accountSpec: master.name, ...credsOf(masterLogin) },
    followers,
  };
  writeFileSync("config.json", JSON.stringify(config, null, 2));
  console.log(
    `\n✓ config.json écrit — maître "${master.name}" + ${followers.length} follower(s), ` +
      (real ? "mode RÉEL." : "simulation [DRY]."),
  );
  console.log("  Démarrer :            npm start");
  console.log("  Service 24/7 (Mac) :  npm run service:install\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// One-time calibration for a set-and-forget copier.
//
//   npm run setup
//
// For each prop firm you add a login (a session token — recommended — or, if
// that firm allows plain password auth, username+password). The tool verifies
// it (demo then live), lists the accounts, lets you pick the master, and writes
// config.json. A token login stays autonomous while the service runs (tokens
// renew themselves and survive restarts via the on-disk cache).
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
import { TradovateClient } from "../src/tradovate/client";
import type { Account, Environment } from "../src/tradovate/types";
import { setLogLevel } from "../src/logger";

interface Login {
  name?: string;
  password?: string;
  token?: string;
  env: Environment;
  accounts: Account[];
}

type Creds = { name: string; password: string } | { token: string };

async function discover(creds: Creds): Promise<{ env: Environment; accounts: Account[] } | string> {
  let lastError = "aucun compte sur demo ni live";
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
      "Ajoute une firme à la fois. Pour chacune, colle un TOKEN de session\n" +
      "(recommandé), ou choisis le mot de passe si ta firme l'autorise.\n",
  );

  const logins: Login[] = [];
  for (let i = 1; ; i++) {
    const choice = (
      await rl.question(`Firme #${i} — [t]oken, [m]ot de passe, ou Entrée pour terminer : `)
    )
      .trim()
      .toLowerCase();
    if (!choice) break;

    let creds: Creds;
    if (choice.startsWith("m")) {
      const name = (await rl.question("  Login/email : ")).trim();
      const password = (await rl.question("  Mot de passe : ")).trim();
      if (!name || !password) {
        console.log("  (vide) — ignoré.");
        continue;
      }
      creds = { name, password };
    } else {
      const token = (await rl.question("  Colle le token : ")).trim().replace(/^Bearer\s+/i, "");
      if (!token) {
        console.log("  (vide) — ignoré.");
        continue;
      }
      creds = { token };
    }

    process.stdout.write("    → connexion… ");
    const found = await discover(creds);
    if (typeof found === "string") {
      console.log(`ÉCHEC : ${found}`);
      continue;
    }
    console.log(`${found.accounts.length} compte(s) [${found.env}] : ${found.accounts.map((a) => a.name).join(", ")}`);
    logins.push({ ...("token" in creds ? { token: creds.token } : creds), ...found });
  }

  const all = logins.flatMap((l, li) => l.accounts.map((a) => ({ name: a.name, li })));
  if (all.length === 0) {
    console.log("\nAucun compte — rien d'écrit.");
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
  console.log("  Démarrer maintenant : npm start");
  console.log("  Service 24/7 (Mac)  : npm run service:install\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

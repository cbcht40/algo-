// Intention d'un ordre intercepté : est-ce une DÉCISION (qui mérite un avis IA) ou un GESTE DE
// GESTION (stop posé après coup, objectif, sortie) qui ne doit surtout pas relancer une analyse ?
//
// Le cas décrit par le fondateur : « la plupart des gens rentrent au marché et ne mettent qu'un SL
// après ». Ces deux ordres arrivent tous les deux par le relais, et jusqu'ici les deux
// déclenchaient une notation — deux notes contradictoires pour une seule décision.
//
// Module PUR, sans dépendance : toute la logique est testable sans Tradovate (tools/test-intent.ts).

export type OrderIntent = "entry" | "add" | "reverse" | "protection" | "exit" | "unknown";

export interface IntentInput {
  endpoint: string;
  action: "Buy" | "Sell";
  orderType: string;
  qty: number;
  /** L'ordre porte-t-il un second volet (OCO) et de quel type ? */
  hasOther?: boolean;
  otherOrderType?: string;
  /** Position nette du compte SOURCE sur CE contrat. null = inconnue (contrat non résolu). */
  netPos: number | null;
  /** Position présumée depuis une entrée toute fraîche dont le fill n'est pas encore revenu. */
  presumedDir?: 1 | -1;
  presumedQty?: number;
  /** Une entrée a-t-elle été relayée sur ce compte + ce symbole il y a moins de 25 s ? */
  recentEntry?: boolean;
  /** Une SORTIE a-t-elle été vue depuis cette entrée ? (invalide la présomption) */
  exitedSince?: boolean;
}

export interface IntentResult {
  intent: OrderIntent;
  role?: "stop" | "target" | "bracket";
  netBefore: number | null;
  reason: string;
  /** Faut-il demander un avis IA ? */
  score: boolean;
}

const STOP_TYPES = new Set(["stop", "stoplimit", "trailingstop"]);
const TARGET_TYPES = new Set(["limit", "mit"]);
const BRACKETED = new Set(["orderstrategy/startorderstrategy", "order/placeoso"]);

const lower = (v?: string) => String(v || "").toLowerCase().replace(/\s+/g, "");
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Un ordre qui porte À LA FOIS un stop et un objectif est forcément une entrée protégée. */
function isBracketPair(a?: string, b?: string): boolean {
  const x = lower(a), y = lower(b);
  return (STOP_TYPES.has(x) && TARGET_TYPES.has(y)) || (TARGET_TYPES.has(x) && STOP_TYPES.has(y));
}

export function classifyOrderIntent(i: IntentInput): IntentResult {
  const ep = lower(i.endpoint);
  const dir = i.action === "Buy" ? 1 : -1;
  const qty = Math.abs(Number(i.qty) || 0);
  const decide = (intent: OrderIntent, reason: string, netBefore: number | null, role?: IntentResult["role"]): IntentResult =>
    ({ intent, role, netBefore, reason, score: intent === "entry" || intent === "add" || intent === "reverse" });

  // R0 — un envoi qui contient déjà ses protections est une décision, jamais une protection.
  if (BRACKETED.has(ep)) {
    const net = i.netPos ?? 0;
    return sign(net) === dir && net !== 0
      ? decide("add", "entrée protégée sur une position déjà ouverte", net)
      : decide("entry", "entrée protégée (stop et objectif dans le même envoi)", i.netPos);
  }

  // Position présumée : uniquement depuis une entrée récente, et invalidée si on est ressorti.
  let net = i.netPos;
  let source: "position" | "presumed" | "none" = net === null ? "none" : "position";
  if ((net === null || net === 0) && i.presumedDir && !i.exitedSince) {
    net = i.presumedDir * Math.abs(Number(i.presumedQty) || 0);
    source = "presumed";
  }

  // R1 — contrat non résolu ET une entrée vient de partir : dans le doute, on ne note rien.
  // Mieux vaut un avis manquant que deux notes contradictoires sur la même décision.
  if (net === null) {
    return i.recentEntry
      ? decide("unknown", "position inconnue juste après une entrée — on n'analyse pas deux fois", null)
      : decide("entry", "aucune position connue sur ce contrat", null);
  }

  // R2 — à plat : un Stop ou une Limite est un ordre d'ENTRÉE (breakout, limite), pas une protection.
  if (net === 0) return decide("entry", "aucune position ouverte : c'est une entrée", 0);

  // R4 — même sens que la position : renfort.
  if (sign(net) === dir) return decide("add", `renfort sur une position de ${Math.abs(net)}`, net);

  // R5 — sens opposé et plus gros que la position : retournement, c'est une nouvelle décision.
  if (qty > Math.abs(net)) return decide("reverse", `retournement (${qty} contre ${Math.abs(net)} ouverts)`, net);

  // R6 — sens opposé, taille ≤ position : geste de gestion.
  const ot = lower(i.orderType);
  const via = source === "presumed" ? " (position déduite de l'entrée qui vient de partir)" : "";
  if (ep === "order/placeoco" && i.hasOther && isBracketPair(i.orderType, i.otherOrderType)) {
    return decide("protection", `stop et objectif posés après l'entrée${via}`, net, "bracket");
  }
  if (STOP_TYPES.has(ot)) return decide("protection", `stop posé après l'entrée${via}`, net, "stop");
  if (TARGET_TYPES.has(ot)) return decide("protection", `objectif posé après l'entrée${via}`, net, "target");
  if (ot === "market") return decide("exit", `sortie au marché${via}`, net);
  return decide("unknown", `ordre opposé non identifié (${i.orderType})${via}`, net);
}

/** Libellé court pour le journal du panneau — une suppression n'est jamais silencieuse. */
export function intentNote(r: IntentResult): string {
  if (r.score) return "";
  const quoi = r.role === "stop" ? "Stop" : r.role === "target" ? "Objectif" : r.role === "bracket" ? "Stop et objectif" : r.intent === "exit" ? "Sortie" : "Ordre";
  return `${quoi} détecté${r.role === "bracket" ? "s" : ""} — pas de nouvelle analyse (${r.reason})`;
}

/**
 * Regroupement par mois — logique pure, sans DOM ni localStorage.
 * main.js branche ces fonctions à la persistance (localStorage) et au rendu.
 */

export const NO_DATE_KEY = "__nodate__";

export const MONTH_NAMES = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

export function monthKey(dateStr) {
  if (!dateStr) return NO_DATE_KEY;
  return dateStr.slice(0, 7); // "YYYY-MM"
}

export function monthLabel(key) {
  if (key === NO_DATE_KEY) return "Sans date prévue";
  const [year, month] = key.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * Replié par défaut sauf le mois en cours, les mois futurs, et "sans date".
 * `overrides` est un Set de clés : "YYYY-MM" force replié, "!YYYY-MM" force ouvert.
 * currentMonthKey doit être au format "YYYY-MM" (ex: todayIso().slice(0, 7)).
 */
export function isMonthCollapsed(key, currentMonthKey, overrides) {
  if (overrides.has(key)) return true;
  if (overrides.has(`!${key}`)) return false;
  if (key === NO_DATE_KEY) return false;
  return key < currentMonthKey;
}

/**
 * Retourne un NOUVEAU Set avec le mois basculé (pure — ne mute pas `overrides`).
 */
export function toggleMonthOverride(key, currentMonthKey, overrides) {
  const wasCollapsed = isMonthCollapsed(key, currentMonthKey, overrides);
  const next = new Set(overrides);
  next.delete(key);
  next.delete(`!${key}`);
  next.add(wasCollapsed ? `!${key}` : key);
  return next;
}

/**
 * Groupe une liste d'expéditions (déjà triée) par mois de expected_date,
 * en préservant l'ordre de première rencontre. Retourne un tableau
 * [{ key, items }] plutôt qu'une Map pour rester facile à itérer/tester.
 */
export function groupByMonth(shipments) {
  const order = [];
  const byKey = new Map();
  for (const s of shipments) {
    const key = monthKey(s.expected_date);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key).push(s);
  }
  return order.map((key) => ({ key, items: byKey.get(key) }));
}

/**
 * Formate une date "YYYY-MM-DD" (format de stockage SQLite/HTML date input)
 * en "JJ/MM/AAAA" pour l'affichage français. Ne touche jamais la valeur
 * stockée/triée/éditée (toujours ISO) — uniquement l'affichage dans le
 * tableau. Retourne "" pour une date vide/invalide (jamais une exception).
 */
export function formatDateFr(isoDate) {
  if (!isoDate) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate; // valeur inattendue : on l'affiche telle quelle plutôt que de la masquer
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

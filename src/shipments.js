/**
 * Tri, filtrage et matching technicien — logique pure, sans DOM.
 * main.js branche ces fonctions aux valeurs lues dans le formulaire de filtres.
 */

export function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "string") return a.localeCompare(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortShipments(list, sortKey, sortDir) {
  const sorted = [...list].sort((a, b) => compareValues(a[sortKey], b[sortKey]));
  return sortDir === "desc" ? sorted.reverse() : sorted;
}

/**
 * Vérifie si les notes d'une expédition indiquent qu'elle a été traitée par
 * le technicien donné. Cherche le motif "Traité par: X" de façon insensible
 * à la casse/accents — pas de colonne dédiée, c'est du texte libre historique.
 *
 * Le nom doit correspondre à un technicien ENTIER de la liste, pas une simple
 * sous-chaîne : sans ça, filtrer sur "Julie" matcherait aussi "Julien" (faux
 * positif — deux personnes différentes). Les données réelles contiennent
 * aussi plusieurs techniciens sur la même ligne séparés par "/" (ex:
 * "Traité par: jp / julie", "Marie / Julie") : on découpe sur "/" et compare
 * chaque nom individuellement, à n'importe quelle position. On coupe aussi
 * sur "|", séparateur utilisé pour ajouter d'autres informations aux notes
 * (import Excel historique : "Traité par: X | vérification...").
 */
export function matchesTechnician(shipment, techName, normalizeFn) {
  if (!techName) return true;
  const notes = normalizeFn(shipment.notes ?? "");
  const needle = normalizeFn(techName.trim());
  const match = notes.match(/trait[eé]{1,2}\s*par\s*:\s*([^|]*)/i);
  if (!match) return false;
  const names = match[1].split("/").map((n) => n.trim());
  return names.includes(needle);
}

/**
 * Filtre une liste d'expéditions selon statut / recherche texte.
 * `normalizedSearch` doit déjà être passé par normalizeAccents et trim()
 * par l'appelant (ce module ne connaît pas la logique d'accents).
 */
export function filterShipments(
  shipments,
  { statusFilter, normalizedSearch, normalizeFn, technicianFilter } = {}
) {
  return shipments.filter((s) => {
    if (statusFilter && s.status !== statusFilter) return false;
    if (technicianFilter && !matchesTechnician(s, technicianFilter, normalizeFn)) return false;
    if (!normalizedSearch) return true;
    const haystack = normalizeFn(
      `${s.supplier} ${s.material} ${s.tracking_number ?? ""} ${s.recipient ?? ""} ${s.carrier ?? ""}`
    );
    return haystack.includes(normalizedSearch);
  });
}

/**
 * Tri, filtrage et statut "en retard" — logique pure, sans DOM.
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
 * En retard : une date prévue dans le passé sur une expédition pas encore
 * reçue/vérifiée. `referenceDate` est injectable pour les tests (par défaut
 * "maintenant"), et on ne considère que la date du jour (pas l'heure).
 */
export function isLate(shipment, referenceDate = new Date()) {
  if (!shipment.expected_date || shipment.status === "received" || shipment.status === "verified") {
    return false;
  }
  return new Date(shipment.expected_date) < new Date(referenceDate.toDateString());
}

/**
 * Vérifie si les notes d'une expédition indiquent qu'elle a été traitée par
 * le technicien donné. Cherche le motif "Traité par: X" de façon insensible
 * à la casse/accents — pas de colonne dédiée, c'est du texte libre historique.
 */
export function matchesTechnician(shipment, techName, normalizeFn) {
  if (!techName) return true;
  const notes = shipment.notes ?? "";
  const needle = normalizeFn(`traité par: ${techName}`.trim());
  return normalizeFn(notes).includes(needle);
}

/**
 * Filtre une liste d'expéditions selon statut / "en retard uniquement" / recherche
 * texte. `normalizedSearch` doit déjà être passé par normalizeAccents et trim()
 * par l'appelant (ce module ne connaît pas la logique d'accents).
 */
export function filterShipments(
  shipments,
  { statusFilter, lateOnly, normalizedSearch, normalizeFn, referenceDate, technicianFilter } = {}
) {
  return shipments.filter((s) => {
    if (statusFilter && s.status !== statusFilter) return false;
    if (lateOnly && !isLate(s, referenceDate)) return false;
    if (technicianFilter && !matchesTechnician(s, technicianFilter, normalizeFn)) return false;
    if (!normalizedSearch) return true;
    const haystack = normalizeFn(
      `${s.supplier} ${s.material} ${s.tracking_number ?? ""} ${s.recipient ?? ""} ${s.carrier ?? ""}`
    );
    return haystack.includes(normalizedSearch);
  });
}

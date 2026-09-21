/**
 * Génération de liens de suivi 17TRACK — aucune donnée n'est envoyée à aucune
 * API depuis l'application : on construit une simple URL vers 17track.net,
 * ouverte dans le navigateur par défaut de l'utilisateur (via tauri-plugin-opener).
 * L'application elle-même ne fait aucun appel réseau.
 */

/**
 * Construit l'URL de suivi 17TRACK pour un numéro donné.
 * Retourne null si le numéro est vide/invalide (pas de lien à afficher).
 */
export function buildTrackingUrl(trackingNumber) {
  if (!trackingNumber) return null;
  const cleaned = trackingNumber.trim();
  if (!cleaned) return null;
  return `https://t.17track.net/fr#nums=${encodeURIComponent(cleaned)}`;
}

/**
 * Validation du champ "N° de suivi" : le texte libre y est interdit. Seules
 * trois formes sont acceptées :
 *  - vide (pas encore de numéro connu — affiché "À éditer" dans le tableau)
 *  - un numéro conforme TNT/DPD : uniquement des chiffres, 8 à 20 caractères
 *    (couvre les formats réels observés, ~15-16 chiffres selon transporteur).
 *    Plusieurs numéros pour un envoi à plusieurs colis restent acceptés,
 *    séparés par un espace, une virgule ou un tiret.
 *  - le texte exact "Non sécurisé" (insensible à la casse/accents), pour les
 *    petits envois qui ne nécessitent pas de destinataire nominatif.
 *
 * N'affecte QUE les nouvelles saisies/modifications : les données historiques
 * déjà en base (tnt, dpd, "à programmer", texte libre divers) ne sont jamais
 * touchées automatiquement par cette fonction.
 */
const TRACKING_SPECIAL_VALUES = ["a editer", "non securise"];

export function isValidTrackingValue(value, normalizeFn) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return true; // vide = valide, affiché "À éditer"

  const normalized = normalizeFn(trimmed);
  if (TRACKING_SPECIAL_VALUES.includes(normalized)) return true;

  const parts = trimmed.split(/[\s,-]+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^\d{8,20}$/.test(p));
}

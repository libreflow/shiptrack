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

/**
 * Thème clair/sombre — logique pure isolée de main.js pour être testable
 * sans DOM lourd (comme normalize.js / months.js). Les fonctions DOM
 * (application sur documentElement, localStorage) restent minces :
 * elles délèguent ici pour les décisions.
 */

export const THEME_STORAGE_KEY = "shiptrack.theme";

/** Thème à appliquer au chargement : celui mémorisé si valide, sinon null
 *  (null = suivre prefers-color-scheme, aucun data-theme posé). */
export function storedTheme(stored) {
  return stored === "dark" || stored === "light" ? stored : null;
}

/** Prochain thème à actuer au clic sur le bouton de bascule. */
export function nextTheme(currentEffective) {
  return currentEffective === "dark" ? "light" : "dark";
}

/** Thème réellement appliqué : celui du data-theme, sinon déduit de
 *  prefers-color-scheme (le média n'est évalué que par l'appelant). */
export function effectiveTheme(datasetTheme, prefersDark) {
  if (datasetTheme) return datasetTheme;
  return prefersDark ? "dark" : "light";
}

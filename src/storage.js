/**
 * Couche de persistance localStorage versionnée — chaque payload embarque sa
 * version de schéma (`v`) ; une version inconnue (app downgradée, format
 * changé sans bump) est ignorée silencieusement plutôt que d'injecter un
 * état corrompu dans l'UI. Les clés restent gérées par main.js (contrat
 * stable avec les tests DOM), ces helpers n'apportent que la version.
 */

export const STORAGE_SCHEMA_VERSION = 1;

/** Lit un payload versionné ; null si absent, illisible, ou d'une autre
 *  version de schéma. Toute erreur de parse est avalée : localStorage
 *  n'est jamais une source de vérité critique. */
export function readStoredJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== STORAGE_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Écrit un payload en y injectant la version courante du schéma. */
export function writeStoredJson(storage, key, value) {
  storage.setItem(key, JSON.stringify({ v: STORAGE_SCHEMA_VERSION, ...value }));
}

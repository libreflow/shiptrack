/**
 * Module de normalisation des données de saisie — source unique de vérité.
 *
 * Toute création/édition d'expédition doit passer par `normalizeShipmentPayload`
 * plutôt que de dupliquer la logique de nettoyage à chaque point d'entrée
 * (saisie rapide, dialog d'édition, futur import...).
 */

export function normalizeAccents(str) {
  // Retire les accents pour une comparaison/recherche insensible ("recu" == "reçu")
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeWhitespace(str) {
  return str.trim().replace(/\s+/g, " ");
}

const TITLE_CASE_LOWERCASE_WORDS = new Set(["de", "du", "des", "la", "le", "les", "et", "sur", "en", "pour"]);
const TITLE_CASE_UPPERCASE_EXCEPTIONS = new Set(["IS", "BTP", "ADS", "PC", "TEL", "SFR", "TP", "HUB"]);

export function titleCaseFr(str) {
  const cleaned = normalizeWhitespace(str);
  if (!cleaned) return cleaned;
  return cleaned
    .split(" ")
    .map((word, i) => {
      const upper = word.toUpperCase();
      if (TITLE_CASE_UPPERCASE_EXCEPTIONS.has(upper)) return upper;
      if (i !== 0 && TITLE_CASE_LOWERCASE_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      return word
        .split("-")
        .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
        .join("-");
    })
    .join(" ");
}

/**
 * Normalise une valeur de champ texte libre : nettoie les espaces, et si une valeur
 * déjà en base correspond (insensible casse/accents), réutilise EXACTEMENT cette
 * forme canonique au lieu d'en créer une nouvelle variante.
 */
export function normalizeAgainstExisting(value, existingValues, { titleCase = false } = {}) {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return cleaned;

  const key = normalizeAccents(cleaned);
  const existingMatch = existingValues.find((v) => normalizeAccents(v) === key);
  if (existingMatch) return existingMatch;

  return titleCase ? titleCaseFr(cleaned) : cleaned;
}

/**
 * Distance de Levenshtein classique (nombre minimal d'insertions/suppressions/
 * substitutions pour passer de a à b).
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Détecte les erreurs de frappe humaines sur un champ texte libre : cherche,
 * parmi les valeurs déjà en base, celles très proches (mais PAS identiques —
 * l'identique exact est déjà géré par normalizeAgainstExisting) de la saisie.
 * Seuil calibré et vérifié sur les 563 agences réelles de la base (avant
 * intégration) : distance de Levenshtein <= 3, ratio <= 20% de la longueur,
 * et longueur minimale de 6 caractères (sous ce seuil, deux noms courts très
 * différents peuvent n'être qu'à 1 caractère d'écart — ex: "Poissy"/"Roissy",
 * deux vraies villes distinctes — le risque de faux positif devient trop
 * élevé pour rester utile).
 * Ne bloque jamais : sert uniquement à afficher un avertissement dismissable
 * ("Vouliez-vous dire … ?"), l'utilisateur garde toujours la main.
 */
export function findSimilarValue(value, existingValues) {
  const cleaned = normalizeWhitespace(value ?? "");
  if (!cleaned) return null;
  const needle = normalizeAccents(cleaned);
  if (needle.length < 6) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const existing of existingValues) {
    const candidate = normalizeAccents(existing);
    if (candidate === needle) continue; // identique : pas une "erreur", géré ailleurs
    if (Math.abs(candidate.length - needle.length) > 3) continue;
    const distance = levenshteinDistance(needle, candidate);
    if (distance === 0 || distance > 3) continue;
    const ratio = distance / Math.max(needle.length, candidate.length);
    if (ratio > 0.2) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = existing;
    }
  }
  return best;
}

/**
 * Schéma déclaratif des champs texte libre d'une expédition.
 * Ajouter/modifier un champ ici suffit à propager le comportement partout
 * (saisie rapide, dialog d'édition, tout futur point d'entrée).
 */
export const SHIPMENT_FIELD_CONFIG = {
  supplier: { titleCase: true, required: true, label: "Agence" },
  material: { titleCase: false, required: true, label: "Matériel" },
  carrier: { titleCase: false, required: false, label: "Transporteur" },
  recipient: { titleCase: false, required: false, label: "Destinataire" },
};

/**
 * Construit l'index des valeurs distinctes déjà en base pour chaque champ
 * texte libre, utilisé par normalizeAgainstExisting. À appeler une fois par
 * soumission (pas à chaque frappe) pour rester performant sur un gros volume.
 */
export function buildShipmentIndex(shipments) {
  const index = {};
  for (const key of Object.keys(SHIPMENT_FIELD_CONFIG)) {
    index[key] = [...new Set(shipments.map((s) => s[key]).filter(Boolean))];
  }
  return index;
}

/**
 * Normalise un objet de valeurs brutes (issues du formulaire) selon le schéma,
 * et retourne { values, errors }. `errors` liste les champs requis manquants
 * (label lisible), à afficher tel quel à l'utilisateur.
 */
export function normalizeShipmentPayload(rawValues, index) {
  const values = {};
  const errors = [];

  for (const [key, config] of Object.entries(SHIPMENT_FIELD_CONFIG)) {
    const raw = rawValues[key] ?? "";
    const normalized = normalizeAgainstExisting(raw, index[key] ?? [], { titleCase: config.titleCase });
    values[key] = normalized || null;

    if (config.required && !normalized) {
      errors.push(config.label);
    }
  }

  return { values, errors };
}

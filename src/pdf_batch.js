/**
 * Logique pure pour la page "Import PDF (lot)" — transforme les résultats
 * bruts de la commande Tauri `parse_shipping_notes_pdfs` en lignes éditables
 * pour le tableau d'aperçu, sans toucher au DOM ni à Tauri : testable en
 * isolation, comme shipments.js/tracking.js/months.js.
 */

/** Valeur par défaut du champ Matériel — jamais présent sur un bon TNT (le
 * bon ne décrit pas le contenu du colis), voir décision utilisateur du
 * 2026-09-23 : créer quand même la ligne plutôt que bloquer l'import, à
 * corriger ensuite dans le tableau principal comme n'importe quel champ. */
export const DEFAULT_MATERIAL_PLACEHOLDER = "Non renseigné";

/**
 * Convertit un `BatchParseResult` (backend) en ligne d'aperçu éditable.
 * Une ligne en erreur garde `error` renseigné et des champs vides — jamais
 * de tentative de deviner quoi que ce soit sur un fichier illisible.
 */
export function batchResultToRow(result) {
  const parsed = result.parsed ?? {};
  return {
    file_name: result.file_name,
    file_path: result.file_path,
    error: result.error ?? null,
    supplier: parsed.agency ?? "",
    material: "", // jamais extrait du bon — l'utilisateur peut le renseigner ici avant création
    tracking_number: parsed.tracking_number ?? "",
    carrier: parsed.carrier ?? "",
    recipient: parsed.recipient ?? "",
    expected_date: parsed.expected_date ?? "",
    notes: "", // jamais extrait du bon — l'utilisateur précise le contenu du colis à la main
    warnings: parsed.warnings ?? [],
    // Décochée par défaut pour une ligne en erreur (rien à créer), cochée
    // sinon — l'utilisateur peut décocher une ligne valide qu'il veut sauter.
    included: !result.error,
  };
}

export function batchResultsToRows(results) {
  return results.map(batchResultToRow);
}

/**
 * Construit le payload `NewShipment` prêt pour `create_shipment` à partir
 * d'une ligne d'aperçu — applique le placeholder Matériel, normalise les
 * chaînes vides en `null` (cohérent avec le reste de l'app, voir
 * normalize.js/buildUpdatePayload dans main.js).
 *
 * Contrairement à Matériel (jamais présent sur un bon TNT, placeholder
 * accepté par décision utilisateur), l'Agence n'a PAS de valeur de repli :
 * c'est le champ pivot de toute l'app (obligatoire partout ailleurs, sert
 * aux filtres/doublons) — appeler cette fonction avec une agence vide est
 * une erreur de l'appelant, voir `rowIsCreatable` pour filtrer en amont.
 */
export function rowToNewShipmentPayload(row, { technician = null } = {}) {
  const supplier = row.supplier.trim();
  if (!supplier) {
    throw new Error("rowToNewShipmentPayload: agence manquante — vérifier rowIsCreatable() avant l'appel");
  }
  return {
    supplier,
    material: row.material.trim() || DEFAULT_MATERIAL_PLACEHOLDER,
    tracking_number: row.tracking_number.trim() || null,
    carrier: row.carrier.trim() || null,
    recipient: row.recipient.trim() || null,
    expected_date: row.expected_date || null,
    pickup_option: null, // jamais extrait du bon PDF (voir pdf_import.rs) — à renseigner ensuite si TNT
    notes: row.notes.trim() || (technician ? `Traité par: ${technician}` : null),
  };
}

/**
 * Une ligne cochée, sans erreur d'extraction, ET avec une Agence renseignée
 * (à la main si besoin) peut être créée. L'Agence est le seul champ
 * réellement bloquant — Matériel a un placeholder, tout le reste est
 * optionnel en base (voir models.rs).
 */
export function rowIsCreatable(row) {
  return row.included && !row.error && row.supplier.trim().length > 0;
}

/** Lignes prêtes à être envoyées à la création (voir rowIsCreatable). */
export function includedRows(rows) {
  return rows.filter(rowIsCreatable);
}

/** Lignes cochées, sans erreur, mais bloquées faute d'Agence renseignée —
 * distinct de `errors` (échec d'extraction PDF) pour un message ciblé. */
export function rowsMissingSupplier(rows) {
  return rows.filter((r) => r.included && !r.error && !r.supplier.trim());
}

/**
 * Résumé chiffré pour l'en-tête de la page ("12 fichiers, 9 prêts, 2 en
 * erreur, 1 décochée, 1 sans agence") — recalculé à chaque rendu plutôt que
 * maintenu à la main en parallèle de l'état, pour ne jamais désynchroniser
 * l'affichage.
 */
export function summarizeRows(rows) {
  const total = rows.length;
  const errors = rows.filter((r) => r.error).length;
  const missingSupplier = rowsMissingSupplier(rows).length;
  const excluded = rows.filter((r) => !r.error && !r.included).length;
  const ready = includedRows(rows).length;
  return { total, errors, missingSupplier, excluded, ready };
}

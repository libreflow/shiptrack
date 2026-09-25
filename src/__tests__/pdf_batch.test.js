import { describe, it, expect } from "vitest";
import {
  DEFAULT_MATERIAL_PLACEHOLDER,
  batchResultToRow,
  batchResultsToRows,
  rowToNewShipmentPayload,
  rowIsCreatable,
  includedRows,
  rowsMissingSupplier,
  summarizeRows,
} from "../pdf_batch.js";

function makeBatchResult(overrides = {}) {
  return {
    file_name: "bon.pdf",
    file_path: "C:/bons/bon.pdf",
    parsed: {
      carrier: "TNT",
      tracking_number: "2417777334853446",
      agency: "Agence Adéquat Perigueux",
      recipient: "MAZEAU Renaud",
      expected_date: "2026-09-08",
      warnings: [],
    },
    error: null,
    ...overrides,
  };
}

describe("batchResultToRow", () => {
  it("mappe un résultat valide vers une ligne éditable, cochée par défaut", () => {
    const row = batchResultToRow(makeBatchResult());
    expect(row).toEqual({
      file_name: "bon.pdf",
      file_path: "C:/bons/bon.pdf",
      error: null,
      supplier: "Agence Adéquat Perigueux",
      material: "",
      tracking_number: "2417777334853446",
      carrier: "TNT",
      recipient: "MAZEAU Renaud",
      expected_date: "2026-09-08",
      warnings: [],
      included: true,
    });
  });

  it("une ligne en erreur (PDF illisible) est décochée par défaut, champs vides", () => {
    const row = batchResultToRow(
      makeBatchResult({ parsed: null, error: "Le PDF ne contient aucun texte exploitable (scan image ?)." })
    );
    expect(row.included).toBe(false);
    expect(row.error).toBe("Le PDF ne contient aucun texte exploitable (scan image ?).");
    expect(row.supplier).toBe("");
    expect(row.material).toBe("");
  });

  it("un champ non extrait (null) devient une chaîne vide, jamais 'null' littéral", () => {
    const row = batchResultToRow(
      makeBatchResult({
        parsed: { carrier: "TNT", tracking_number: null, agency: null, recipient: null, expected_date: null, warnings: ["Agence non trouvée dans le document."] },
      })
    );
    expect(row.supplier).toBe("");
    expect(row.tracking_number).toBe("");
    expect(row.recipient).toBe("");
    expect(row.expected_date).toBe("");
    expect(row.warnings).toEqual(["Agence non trouvée dans le document."]);
  });

  it("le Matériel n'est jamais pré-rempli même si le backend en fournissait un un jour", () => {
    const row = batchResultToRow(makeBatchResult());
    expect(row.material).toBe(""); // jamais extrait d'un bon TNT, voir commentaire module
  });
});

describe("batchResultsToRows", () => {
  it("mappe une liste de résultats en conservant l'ordre", () => {
    const rows = batchResultsToRows([
      makeBatchResult({ file_name: "a.pdf" }),
      makeBatchResult({ file_name: "b.pdf", parsed: null, error: "boom" }),
    ]);
    expect(rows.map((r) => r.file_name)).toEqual(["a.pdf", "b.pdf"]);
    expect(rows[1].included).toBe(false);
  });

  it("liste vide -> tableau vide", () => {
    expect(batchResultsToRows([])).toEqual([]);
  });
});

describe("rowIsCreatable", () => {
  it("cochée + sans erreur + agence renseignée -> créable", () => {
    const row = batchResultToRow(makeBatchResult());
    expect(rowIsCreatable(row)).toBe(true);
  });

  it("décochée manuellement -> non créable même si tout le reste est valide", () => {
    const row = { ...batchResultToRow(makeBatchResult()), included: false };
    expect(rowIsCreatable(row)).toBe(false);
  });

  it("en erreur -> non créable même si cochée", () => {
    const row = { ...batchResultToRow(makeBatchResult()), included: true, error: "boom" };
    expect(rowIsCreatable(row)).toBe(false);
  });

  it("agence vide (non extraite et non corrigée à la main) -> non créable", () => {
    const row = batchResultToRow(makeBatchResult({ parsed: { ...makeBatchResult().parsed, agency: null } }));
    expect(row.included).toBe(true); // cochée par défaut (pas d'erreur d'extraction)
    expect(rowIsCreatable(row)).toBe(false); // mais bloquée faute d'agence
  });

  it("agence vide puis corrigée à la main -> créable", () => {
    const row = batchResultToRow(makeBatchResult({ parsed: { ...makeBatchResult().parsed, agency: null } }));
    row.supplier = "Agence Adéquat Lyon";
    expect(rowIsCreatable(row)).toBe(true);
  });

  it("agence uniquement des espaces -> non créable", () => {
    const row = batchResultToRow(makeBatchResult());
    row.supplier = "   ";
    expect(rowIsCreatable(row)).toBe(false);
  });
});

describe("includedRows", () => {
  it("ne garde que les lignes créables", () => {
    const rows = [
      batchResultToRow(makeBatchResult({ file_name: "ok.pdf" })),
      batchResultToRow(makeBatchResult({ file_name: "err.pdf", parsed: null, error: "boom" })),
      { ...batchResultToRow(makeBatchResult({ file_name: "decochee.pdf" })), included: false },
    ];
    expect(includedRows(rows).map((r) => r.file_name)).toEqual(["ok.pdf"]);
  });
});

describe("rowsMissingSupplier", () => {
  it("identifie les lignes cochées sans erreur mais sans agence", () => {
    const withoutAgency = batchResultToRow(
      makeBatchResult({ file_name: "sans_agence.pdf", parsed: { ...makeBatchResult().parsed, agency: null } })
    );
    const ok = batchResultToRow(makeBatchResult({ file_name: "ok.pdf" }));
    const rows = [withoutAgency, ok];
    expect(rowsMissingSupplier(rows).map((r) => r.file_name)).toEqual(["sans_agence.pdf"]);
  });

  it("une ligne en erreur d'extraction n'est PAS comptée comme 'sans agence' (message distinct)", () => {
    const errRow = batchResultToRow(makeBatchResult({ parsed: null, error: "boom" }));
    expect(rowsMissingSupplier([errRow])).toEqual([]);
  });

  it("une ligne décochée sans agence n'est pas remontée (l'utilisateur a choisi de l'exclure)", () => {
    const row = batchResultToRow(makeBatchResult({ parsed: { ...makeBatchResult().parsed, agency: null } }));
    row.included = false;
    expect(rowsMissingSupplier([row])).toEqual([]);
  });
});

describe("rowToNewShipmentPayload", () => {
  it("construit le payload complet à partir d'une ligne bien remplie", () => {
    const row = batchResultToRow(makeBatchResult());
    row.material = "Écran 24 pouces";
    const payload = rowToNewShipmentPayload(row, { technician: "Julie" });
    expect(payload).toEqual({
      supplier: "Agence Adéquat Perigueux",
      material: "Écran 24 pouces",
      tracking_number: "2417777334853446",
      carrier: "TNT",
      recipient: "MAZEAU Renaud",
      expected_date: "2026-09-08",
      pickup_option: null,
      notes: "Traité par: Julie",
    });
  });

  it("Matériel vide -> placeholder DEFAULT_MATERIAL_PLACEHOLDER", () => {
    const row = batchResultToRow(makeBatchResult());
    const payload = rowToNewShipmentPayload(row);
    expect(payload.material).toBe(DEFAULT_MATERIAL_PLACEHOLDER);
    expect(payload.material).toBe("Non renseigné");
  });

  it("champs optionnels vides -> null, jamais chaîne vide", () => {
    const row = batchResultToRow(makeBatchResult({ parsed: { ...makeBatchResult().parsed, tracking_number: null, carrier: null, recipient: null, expected_date: null } }));
    const payload = rowToNewShipmentPayload(row);
    expect(payload.tracking_number).toBeNull();
    expect(payload.carrier).toBeNull();
    expect(payload.recipient).toBeNull();
    expect(payload.expected_date).toBeNull();
  });

  it("sans technicien -> notes null", () => {
    const row = batchResultToRow(makeBatchResult());
    expect(rowToNewShipmentPayload(row).notes).toBeNull();
  });

  it("pickup_option est toujours null (jamais extrait d'un bon PDF)", () => {
    const row = batchResultToRow(makeBatchResult());
    expect(rowToNewShipmentPayload(row).pickup_option).toBeNull();
  });

  it("agence vide -> lève une erreur explicite plutôt qu'un placeholder silencieux", () => {
    const row = batchResultToRow(makeBatchResult({ parsed: { ...makeBatchResult().parsed, agency: null } }));
    expect(() => rowToNewShipmentPayload(row)).toThrow(/agence manquante/i);
  });

  it("agence avec espaces superflus -> trim appliqué", () => {
    const row = batchResultToRow(makeBatchResult());
    row.supplier = "  Agence Adéquat Perigueux  ";
    expect(rowToNewShipmentPayload(row).supplier).toBe("Agence Adéquat Perigueux");
  });
});

describe("summarizeRows", () => {
  it("compte total / prêtes / erreurs / décochées / sans agence indépendamment", () => {
    const rows = [
      batchResultToRow(makeBatchResult({ file_name: "ok1.pdf" })), // prête
      batchResultToRow(makeBatchResult({ file_name: "ok2.pdf" })), // prête
      batchResultToRow(makeBatchResult({ file_name: "err.pdf", parsed: null, error: "boom" })), // erreur
      { ...batchResultToRow(makeBatchResult({ file_name: "off.pdf" })), included: false }, // décochée
      batchResultToRow(makeBatchResult({ file_name: "sans_agence.pdf", parsed: { ...makeBatchResult().parsed, agency: null } })), // sans agence
    ];
    expect(summarizeRows(rows)).toEqual({
      total: 5,
      errors: 1,
      missingSupplier: 1,
      excluded: 1,
      ready: 2,
    });
  });

  it("liste vide -> tous les compteurs à 0", () => {
    expect(summarizeRows([])).toEqual({ total: 0, errors: 0, missingSupplier: 0, excluded: 0, ready: 0 });
  });
});

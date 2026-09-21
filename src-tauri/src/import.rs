use crate::db::DbState;
use crate::models::Shipment;
use calamine::{open_workbook, Reader, Xlsx};
use rusqlite::params;
use tauri::State;
use uuid::Uuid;

/// Parse une date au format "JJ/MM/AAAA" (ou variantes JJ-MM-AA, année à 2/3/4
/// chiffres) vue dans le fichier Excel source, ou une date native Excel déjà
/// convertie en "AAAA-MM-JJ" par calamine. Corrige aussi le cas rencontré dans
/// les données réelles où l'année est tronquée à 3 chiffres (ex: "28/01/206"
/// -> "2026"). Retourne None si la valeur n'est pas une date exploitable.
pub fn parse_excel_date(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // Déjà au format ISO (ex: sorti directement d'une cellule date Excel).
    if raw.len() == 10 && raw.as_bytes().get(4) == Some(&b'-') && raw.as_bytes().get(7) == Some(&b'-') {
        return Some(raw.to_string());
    }

    let parts: Vec<&str> = raw.splitn(3, |c| c == '/' || c == '-').collect();
    if parts.len() != 3 {
        return None;
    }
    let day: u32 = parts[0].trim().parse().ok()?;
    let month: u32 = parts[1].trim().parse().ok()?;
    let mut year: i32 = parts[2].trim().parse().ok()?;

    if year < 100 {
        year += 2000;
    }
    // Années à 3 chiffres (ex: "206") : artefact de saisie ambigu rencontré dans les
    // données historiques, sans règle de correction fiable (impossible de savoir quel
    // chiffre a été omis). On les rejette plutôt que d'inventer une date — cohérent
    // avec le comportement de l'import historique où ces lignes restaient sans date.
    if (100..1000).contains(&year) {
        return None;
    }

    if !(1..=31).contains(&day) || !(1..=12).contains(&month) || !(2000..=2100).contains(&year) {
        return None;
    }

    chrono::NaiveDate::from_ymd_opt(year, month, day).map(|d| d.format("%Y-%m-%d").to_string())
}

/// Mappe la colonne "Type" (envoi/ramasse, texte libre) sur un statut ShipTrack.
/// Même mapping que le script d'import historique : envoi -> shipped, tout le
/// reste (dont "ramasse") -> ordered.
pub fn status_from_type(type_val: &str) -> &'static str {
    let t = type_val.trim().to_lowercase();
    if t.contains("envoi") {
        "shipped"
    } else {
        "ordered"
    }
}

fn clean(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

#[derive(serde::Serialize)]
pub struct ImportResult {
    pub inserted: usize,
    pub skipped: usize,
    pub duplicates: usize,
    pub imported: Vec<Shipment>,
}

/// Importe une feuille au format "Suivi Expéditions" (DATE, AGENCE, Expéditeur,
/// Type, N° Suivi, Matériel envoyé, Vérification) — mêmes colonnes que le script
/// Python historique (scripts/import_excel.py), réimplémenté nativement pour
/// être accessible depuis l'UI sans dépendance Python.
fn import_sheet_impl(
    conn: &rusqlite::Connection,
    rows: &[Vec<calamine::Data>],
) -> Result<(usize, usize, usize), String> {
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let mut duplicates = 0usize;

    // N° de suivi déjà en base avant cet import, pour détecter les ré-imports
    // accidentels du même fichier (aucune contrainte UNIQUE en base : un n° de
    // suivi peut légitimement être vide/partagé sur du texte libre historique
    // comme "tnt"/"dpd", donc on avertit sans jamais bloquer l'import).
    let mut existing_tracking: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT tracking_number FROM shipments WHERE tracking_number IS NOT NULL AND tracking_number != ''")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    for row in rows.iter().skip(1) {
        // skip header row
        let get = |i: usize| -> String {
            row.get(i).map(|c| c.to_string()).unwrap_or_default()
        };

        let date_raw = get(0);
        let agence = clean(&get(1));
        let technicien = clean(&get(2));
        let type_val = clean(&get(3));
        let tracking = clean(&get(4));
        let material = clean(&get(5));
        let verif = clean(&get(6));

        if agence.is_none() && material.is_none() {
            skipped += 1;
            continue;
        }

        if let Some(t) = &tracking {
            if existing_tracking.contains(t) {
                duplicates += 1;
            } else {
                existing_tracking.insert(t.clone());
            }
        }

        let expected_date = parse_excel_date(&date_raw);
        let status = status_from_type(type_val.as_deref().unwrap_or(""));

        let mut notes_parts = Vec::new();
        if let Some(t) = &technicien {
            notes_parts.push(format!("Traité par: {t}"));
        }
        if let Some(v) = &verif {
            notes_parts.push(v.clone());
        }
        let notes = if notes_parts.is_empty() {
            None
        } else {
            Some(notes_parts.join(" | "))
        };

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, notes)
             VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7)",
            params![
                id,
                agence.unwrap_or_else(|| "(agence non renseignée)".to_string()),
                tracking,
                material.unwrap_or_else(|| "(matériel non renseigné)".to_string()),
                status,
                expected_date,
                notes,
            ],
        )
        .map_err(|e| e.to_string())?;
        inserted += 1;
    }

    Ok((inserted, skipped, duplicates))
}

#[tauri::command]
pub fn import_excel_sheet(
    state: State<DbState>,
    file_path: String,
    sheet_name: String,
) -> Result<ImportResult, String> {
    let mut workbook: Xlsx<std::io::BufReader<std::fs::File>> =
        open_workbook::<Xlsx<_>, _>(&file_path).map_err(|e| e.to_string())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;

    let rows: Vec<Vec<calamine::Data>> = range.rows().map(|r| r.to_vec()).collect();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let before_ids: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM shipments")
            .map_err(|e| e.to_string())?;
        let ids: std::collections::HashSet<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };

    let (inserted, skipped, duplicates) = import_sheet_impl(&conn, &rows)?;

    let mut stmt = conn
        .prepare("SELECT * FROM shipments")
        .map_err(|e| e.to_string())?;
    let all: Vec<Shipment> = stmt
        .query_map([], crate::commands::row_to_shipment)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let imported = all.into_iter().filter(|s| !before_ids.contains(&s.id)).collect();

    Ok(ImportResult { inserted, skipped, duplicates, imported })
}

#[tauri::command]
pub fn list_excel_sheets(file_path: String) -> Result<Vec<String>, String> {
    let workbook: Xlsx<std::io::BufReader<std::fs::File>> =
        open_workbook::<Xlsx<_>, _>(&file_path).map_err(|e| e.to_string())?;
    Ok(workbook.sheet_names().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_excel_date_handles_standard_format() {
        assert_eq!(parse_excel_date("28/01/2026"), Some("2026-01-28".to_string()));
    }

    #[test]
    fn parse_excel_date_handles_two_digit_year() {
        assert_eq!(parse_excel_date("05/03/26"), Some("2026-03-05".to_string()));
    }

    #[test]
    fn parse_excel_date_rejects_three_digit_year_as_ambiguous() {
        // Cas réel rencontré dans les données historiques : "28/01/206" — année
        // ambiguë, impossible à corriger fiablement. Comportement historique :
        // ces lignes restent sans date plutôt que d'en inventer une.
        assert_eq!(parse_excel_date("28/01/206"), None);
    }

    #[test]
    fn parse_excel_date_accepts_iso_format() {
        assert_eq!(parse_excel_date("2026-01-28"), Some("2026-01-28".to_string()));
    }

    #[test]
    fn parse_excel_date_rejects_garbage() {
        assert_eq!(parse_excel_date("pas une date"), None);
        assert_eq!(parse_excel_date(""), None);
    }

    #[test]
    fn parse_excel_date_rejects_impossible_day() {
        assert_eq!(parse_excel_date("32/01/2026"), None);
    }

    #[test]
    fn status_from_type_maps_envoi_to_shipped() {
        assert_eq!(status_from_type("Envoi"), "shipped");
        assert_eq!(status_from_type("  ENVOI  "), "shipped");
    }

    #[test]
    fn status_from_type_maps_everything_else_to_ordered() {
        assert_eq!(status_from_type("Ramasse"), "ordered");
        assert_eq!(status_from_type(""), "ordered");
        assert_eq!(status_from_type("autre chose"), "ordered");
    }

    fn test_db() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("run migrations on in-memory db");
        conn
    }

    fn data_str(s: &str) -> calamine::Data {
        calamine::Data::String(s.to_string())
    }

    fn data_empty() -> calamine::Data {
        calamine::Data::Empty
    }

    #[test]
    fn import_sheet_impl_inserts_rows_and_skips_header() {
        let conn = test_db();
        let rows = vec![
            vec![
                data_str("DATE"),
                data_str("AGENCE"),
                data_str("Expéditeur"),
                data_str("Type"),
                data_str("N° Suivi"),
                data_str("Matériel envoyé"),
                data_str("Vérification"),
            ], // en-tête, doit être ignoré
            vec![
                data_str("28/01/2026"),
                data_str("Voiron"),
                data_str("Julie"),
                data_str("Envoi"),
                data_str("TRK-1"),
                data_str("PC portable"),
                data_empty(),
            ],
        ];

        let (inserted, skipped, duplicates) = import_sheet_impl(&conn, &rows).unwrap();
        assert_eq!(inserted, 1);
        assert_eq!(skipped, 0);
        assert_eq!(duplicates, 0);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM shipments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let (supplier, status, notes): (String, String, Option<String>) = conn
            .query_row(
                "SELECT supplier, status, notes FROM shipments",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(supplier, "Voiron");
        assert_eq!(status, "shipped");
        assert_eq!(notes.as_deref(), Some("Traité par: Julie"));
    }

    #[test]
    fn import_sheet_impl_skips_rows_without_agence_or_material() {
        let conn = test_db();
        let rows = vec![
            vec![data_str("DATE"), data_str("AGENCE")], // en-tête
            vec![data_empty(), data_empty(), data_empty(), data_empty(), data_empty(), data_empty()],
        ];

        let (inserted, skipped, _) = import_sheet_impl(&conn, &rows).unwrap();
        assert_eq!(inserted, 0);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn import_sheet_impl_rejects_corrupted_date_but_still_imports_row() {
        let conn = test_db();
        let rows = vec![
            vec![data_str("DATE"), data_str("AGENCE")], // en-tête
            vec![
                data_str("garbage"),
                data_str("Vannes"),
                data_empty(),
                data_empty(),
                data_empty(),
                data_str("Écran"),
            ],
        ];

        let (inserted, _, _) = import_sheet_impl(&conn, &rows).unwrap();
        assert_eq!(inserted, 1);

        let expected_date: Option<String> = conn
            .query_row("SELECT expected_date FROM shipments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(expected_date, None);
    }

    #[test]
    fn import_sheet_impl_detects_duplicate_tracking_numbers_already_in_db() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO shipments (id, supplier, tracking_number, material, status) VALUES ('existing', 'Voiron', 'TRK-1', 'Écran', 'shipped')",
            [],
        )
        .unwrap();

        let rows = vec![
            vec![data_str("DATE"), data_str("AGENCE")], // en-tête
            vec![
                data_str("28/01/2026"),
                data_str("Vannes"),
                data_empty(),
                data_str("Envoi"),
                data_str("TRK-1"), // même n° de suivi -> réimport probable
                data_str("PC portable"),
            ],
        ];

        let (inserted, skipped, duplicates) = import_sheet_impl(&conn, &rows).unwrap();
        assert_eq!(inserted, 1); // la ligne est quand même importée, juste signalée
        assert_eq!(skipped, 0);
        assert_eq!(duplicates, 1);
    }

    #[test]
    fn import_sheet_impl_detects_duplicates_within_the_same_import() {
        let conn = test_db();
        let rows = vec![
            vec![data_str("DATE"), data_str("AGENCE")], // en-tête
            vec![
                data_str("28/01/2026"),
                data_str("Vannes"),
                data_empty(),
                data_str("Envoi"),
                data_str("TRK-2"),
                data_str("PC portable"),
            ],
            vec![
                data_str("29/01/2026"),
                data_str("Voiron"),
                data_empty(),
                data_str("Envoi"),
                data_str("TRK-2"), // dupliqué dans le même fichier
                data_str("Écran"),
            ],
        ];

        let (inserted, skipped, duplicates) = import_sheet_impl(&conn, &rows).unwrap();
        assert_eq!(inserted, 2);
        assert_eq!(skipped, 0);
        assert_eq!(duplicates, 1);
    }
}

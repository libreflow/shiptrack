use crate::commands::row_to_shipment;
use crate::models::Shipment;
use rusqlite::{params, Connection};
use tauri::{Manager, State};

use crate::db::DbState;

/// Année minimale/maximale plausible pour `keep_year` — même plage que
/// `clean_date` dans commands.rs, pour rejeter une valeur absurde envoyée
/// par erreur (défense en profondeur, même si le frontend borne déjà l'input).
fn validate_keep_year(keep_year: i32) -> Result<(), String> {
    if !(2015..=2035).contains(&keep_year) {
        return Err(format!("Année invalide : {keep_year}"));
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct ArchiveResult {
    pub archived: usize,
    pub kept: usize,
    pub archive_path: String,
    pub archive_file_name: String,
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct ArchiveInfo {
    pub path: String,
    pub file_name: String,
    pub count: usize,
}

fn count_total(conn: &Connection) -> Result<usize, String> {
    conn.query_row("SELECT COUNT(*) FROM shipments", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Lignes archivables : `expected_date` renseignée ET antérieure à `keep_year`.
/// Les lignes SANS date prévue ne sont JAMAIS archivées, même si `keep_year`
/// est élevé — décision produit explicite : on ne veut jamais risquer de
/// masquer un envoi en cours faute d'une date simplement non saisie (voir
/// discussion du 2026-09-23). Seul un vrai historique daté et révolu part
/// dans l'archive.
fn count_archivable_impl(conn: &Connection, keep_year: i32) -> Result<usize, String> {
    let cutoff = keep_year.to_string();
    conn.query_row(
        "SELECT COUNT(*) FROM shipments WHERE expected_date IS NOT NULL AND substr(expected_date,1,4) < ?1",
        params![cutoff],
        |r| r.get::<_, usize>(0),
    )
    .map_err(|e| e.to_string())
}

/// Copie les lignes archivables de `conn` vers `archive_conn` (nouvelle base,
/// même schéma que la principale), puis les retire de `conn`. Les deux étapes
/// sont chacune transactionnelles ; la suppression dans `conn` n'a lieu
/// qu'après le COMMIT réussi de la copie, pour ne jamais perdre une ligne si
/// l'écriture de l'archive échoue en cours de route.
fn archive_before_year_impl(
    conn: &mut Connection,
    archive_conn: &mut Connection,
    keep_year: i32,
) -> Result<(usize, usize), String> {
    let cutoff = keep_year.to_string();

    let rows: Vec<Shipment> = {
        let mut stmt = conn
            .prepare("SELECT * FROM shipments WHERE deleted_at IS NULL AND expected_date IS NOT NULL AND substr(expected_date,1,4) < ?1")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![cutoff], row_to_shipment)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        mapped
    };

    if rows.is_empty() {
        return Ok((0, count_total(conn)?));
    }

    let tx = archive_conn.transaction().map_err(|e| e.to_string())?;
    for s in &rows {
        tx.execute(
            "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, received_date, notes, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                s.id, s.supplier, s.tracking_number, s.carrier, s.recipient, s.material, s.status,
                s.expected_date, s.received_date, s.notes, s.created_at, s.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // Suppression uniquement après confirmation que l'archive a bien tout reçu.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM shipments WHERE deleted_at IS NULL AND expected_date IS NOT NULL AND substr(expected_date,1,4) < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let kept = count_total(conn)?;
    Ok((rows.len(), kept))
}

/// Remplacement COMPLET du contenu de `conn` par celui de `archive_conn` —
/// décision produit explicite (voir discussion du 2026-09-23) : plus simple et
/// plus fiable qu'une fusion, au prix de devoir ressaisir ce qui aurait été
/// ajouté entre-temps. L'appelant est responsable de faire sauvegarder l'état
/// actuel AVANT d'appeler cette fonction (voir `db::backup_db_now`).
fn reload_archive_impl(conn: &mut Connection, archive_conn: &Connection) -> Result<usize, String> {
    let rows: Vec<Shipment> = {
        let mut stmt = archive_conn.prepare("SELECT * FROM shipments").map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], row_to_shipment)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        mapped
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM shipments", []).map_err(|e| e.to_string())?;
    for s in &rows {
        tx.execute(
            "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, received_date, notes, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                s.id, s.supplier, s.tracking_number, s.carrier, s.recipient, s.material, s.status,
                s.expected_date, s.received_date, s.notes, s.created_at, s.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(rows.len())
}

fn archives_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data_dir.join("archives");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn count_archivable(state: State<DbState>, keep_year: i32) -> Result<usize, String> {
    validate_keep_year(keep_year)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    count_archivable_impl(&conn, keep_year)
}

#[tauri::command]
pub fn archive_shipments_before(
    app: tauri::AppHandle,
    state: State<DbState>,
    keep_year: i32,
) -> Result<ArchiveResult, String> {
    validate_keep_year(keep_year)?;
    let dir = archives_dir(&app)?;

    let timestamp = chrono::Local::now().format("%Y-%m-%d_%Hh%M%S").to_string();
    let file_name = format!("shiptrack-archive-avant-{keep_year}-{timestamp}.sqlite3");
    let archive_path = dir.join(&file_name);

    let mut archive_conn = Connection::open(&archive_path).map_err(|e| e.to_string())?;
    crate::db::migrations()
        .to_latest(&mut archive_conn)
        .map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (archived, kept) = archive_before_year_impl(&mut conn, &mut archive_conn, keep_year)?;

    Ok(ArchiveResult {
        archived,
        kept,
        archive_path: archive_path.to_string_lossy().to_string(),
        archive_file_name: file_name,
    })
}

#[tauri::command]
pub fn list_archives(app: tauri::AppHandle) -> Result<Vec<ArchiveInfo>, String> {
    let dir = archives_dir(&app)?;
    let mut result = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("sqlite3") {
            continue;
        }
        let count = Connection::open(&path)
            .ok()
            .and_then(|c| c.query_row("SELECT COUNT(*) FROM shipments", [], |r| r.get::<_, usize>(0)).ok())
            .unwrap_or(0);
        result.push(ArchiveInfo {
            path: path.to_string_lossy().to_string(),
            file_name: path.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string(),
            count,
        });
    }
    // Nom de fichier commence par l'horodatage -> ordre alphabétique décroissant = plus récent d'abord.
    result.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(result)
}

#[tauri::command]
pub fn reload_archive(app: tauri::AppHandle, state: State<DbState>, archive_path: String) -> Result<usize, String> {
    let app_data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    // Filet de sécurité inconditionnel : reload_archive remplace TOUT le
    // contenu actif, donc on sauvegarde l'état actuel juste avant, même si un
    // backup quotidien a déjà eu lieu aujourd'hui (backup_db normal ne le
    // referait pas dans ce cas).
    crate::db::backup_db_now(&app_data_dir, "pre-reload")?;

    let archive_conn =
        Connection::open(&archive_path).map_err(|e| format!("Impossible d'ouvrir l'archive : {e}"))?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    reload_archive_impl(&mut conn, &archive_conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::migrations().to_latest(&mut conn).expect("run migrations on in-memory db");
        conn
    }

    fn insert(conn: &Connection, id: &str, supplier: &str, expected_date: Option<&str>) {
        conn.execute(
            "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, received_date, notes)
             VALUES (?1, ?2, 'TRK', 'TNT', 'Quelqu-un', 'PC portable', 'shipped', ?3, NULL, 'une note')",
            params![id, supplier, expected_date],
        )
        .unwrap();
    }

    #[test]
    fn count_archivable_counts_only_dated_rows_before_keep_year() {
        let conn = test_db();
        insert(&conn, "a", "Ales", Some("2023-02-23"));
        insert(&conn, "b", "Nimes", Some("2025-01-12"));
        insert(&conn, "c", "Angers", Some("2026-01-01"));
        insert(&conn, "d", "Reims", None); // pas de date -> jamais compté

        assert_eq!(count_archivable_impl(&conn, 2026).unwrap(), 2);
        assert_eq!(count_archivable_impl(&conn, 2024).unwrap(), 1);
        assert_eq!(count_archivable_impl(&conn, 2015).unwrap(), 0);
    }

    #[test]
    fn archive_before_year_moves_only_old_dated_rows() {
        let mut conn = test_db();
        let mut archive_conn = test_db();
        insert(&conn, "a", "Ales", Some("2023-02-23"));
        insert(&conn, "b", "Nimes", Some("2025-01-12"));
        insert(&conn, "c", "Angers", Some("2026-01-01"));
        insert(&conn, "d", "Reims", None);

        let (archived, kept) = archive_before_year_impl(&mut conn, &mut archive_conn, 2026).unwrap();
        assert_eq!(archived, 2);
        assert_eq!(kept, 2); // "Angers" (2026) + "Reims" (pas de date) restent actives

        assert_eq!(count_total(&conn).unwrap(), 2);
        assert_eq!(count_total(&archive_conn).unwrap(), 2);

        let remaining_suppliers: Vec<String> = {
            let mut stmt = conn.prepare("SELECT supplier FROM shipments ORDER BY supplier").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(remaining_suppliers, vec!["Angers", "Reims"]);
    }

    #[test]
    fn archive_before_year_preserves_all_fields_in_the_archive() {
        let mut conn = test_db();
        let mut archive_conn = test_db();
        insert(&conn, "a", "Ales", Some("2023-02-23"));

        archive_before_year_impl(&mut conn, &mut archive_conn, 2026).unwrap();

        let (tracking, carrier, recipient, material, status, notes): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
        ) = archive_conn
            .query_row(
                "SELECT tracking_number, carrier, recipient, material, status, notes FROM shipments WHERE id='a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(tracking.as_deref(), Some("TRK"));
        assert_eq!(carrier.as_deref(), Some("TNT"));
        assert_eq!(recipient.as_deref(), Some("Quelqu-un"));
        assert_eq!(material, "PC portable");
        assert_eq!(status, "shipped");
        assert_eq!(notes.as_deref(), Some("une note"));
    }

    #[test]
    fn archive_before_year_no_matching_rows_is_a_safe_noop() {
        let mut conn = test_db();
        let mut archive_conn = test_db();
        insert(&conn, "a", "Angers", Some("2026-05-01"));

        let (archived, kept) = archive_before_year_impl(&mut conn, &mut archive_conn, 2026).unwrap();
        assert_eq!(archived, 0);
        assert_eq!(kept, 1);
        assert_eq!(count_total(&conn).unwrap(), 1);
        assert_eq!(count_total(&archive_conn).unwrap(), 0);
    }

    #[test]
    fn reload_archive_replaces_all_active_content() {
        let mut conn = test_db();
        insert(&conn, "old1", "DoitDisparaitre", Some("2026-01-01"));
        insert(&conn, "old2", "DoitDisparaitreAussi", None);

        let archive_conn = test_db();
        insert(&archive_conn, "arch1", "Ales", Some("2023-02-23"));
        insert(&archive_conn, "arch2", "Nimes", Some("2025-01-12"));

        let count = reload_archive_impl(&mut conn, &archive_conn).unwrap();
        assert_eq!(count, 2);
        assert_eq!(count_total(&conn).unwrap(), 2);

        let suppliers: Vec<String> = {
            let mut stmt = conn.prepare("SELECT supplier FROM shipments ORDER BY supplier").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(suppliers, vec!["Ales", "Nimes"]);
    }

    #[test]
    fn reload_archive_with_empty_archive_empties_active_db() {
        let mut conn = test_db();
        insert(&conn, "old1", "DoitDisparaitre", Some("2026-01-01"));
        let archive_conn = test_db(); // vide

        let count = reload_archive_impl(&mut conn, &archive_conn).unwrap();
        assert_eq!(count, 0);
        assert_eq!(count_total(&conn).unwrap(), 0);
    }

    #[test]
    fn archive_then_reload_round_trip_preserves_data_exactly() {
        let mut conn = test_db();
        insert(&conn, "a", "Ales", Some("2023-02-23"));
        insert(&conn, "b", "Nimes", Some("2025-01-12"));
        insert(&conn, "c", "Angers", Some("2026-01-01")); // ne doit pas partir dans l'archive

        let mut archive_conn = test_db();
        archive_before_year_impl(&mut conn, &mut archive_conn, 2026).unwrap();
        assert_eq!(count_total(&conn).unwrap(), 1); // reste "Angers"

        // Un autre "conn" simule la base active au moment du rechargement.
        let mut conn2 = test_db();
        insert(&conn2, "c", "Angers", Some("2026-01-01"));
        let reloaded = reload_archive_impl(&mut conn2, &archive_conn).unwrap();
        assert_eq!(reloaded, 2);

        let suppliers: Vec<String> = {
            let mut stmt = conn2.prepare("SELECT supplier FROM shipments ORDER BY supplier").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(suppliers, vec!["Ales", "Nimes"]);
    }

    #[test]
    fn validate_keep_year_rejects_implausible_values() {
        assert!(validate_keep_year(2026).is_ok());
        assert!(validate_keep_year(2014).is_err());
        assert!(validate_keep_year(2036).is_err());
    }
}

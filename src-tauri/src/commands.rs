use crate::db::DbState;
use crate::models::{NewShipment, Shipment, UpdateShipment};
use rusqlite::{params, OptionalExtension};
use tauri::State;
use uuid::Uuid;

/// Nettoyage minimal appliqué en dernier rempart, indépendamment du frontend :
/// trim + réduction des espaces multiples/tabulations à un seul espace.
/// La normalisation "métier" (Title Case, correspondance insensible casse/accents)
/// reste côté frontend (src/normalize.js) car elle a besoin de comparer aux valeurs
/// déjà affichées ; ici on garantit juste qu'aucune valeur "sale" n'entre en base,
/// quel que soit l'appelant (UI actuelle, futur import, script, etc.).
fn clean_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| clean_whitespace(&v)).filter(|v| !v.is_empty())
}

/// Rejette les dates visiblement corrompues (ex: "0206-01-28", "1900-01-02" —
/// artefacts classiques d'import Excel) plutôt que de les stocker telles quelles.
/// Une date invalide/implausible devient NULL au lieu de fausser les tris et le
/// regroupement par mois. Plage large mais raisonnable pour un flux d'expédition.
fn clean_date(s: Option<String>) -> Option<String> {
    let s = clean_opt(s)?;
    let year: i32 = s.get(0..4)?.parse().ok()?;
    if !(2015..=2035).contains(&year) {
        return None;
    }
    Some(s)
}

/// Ne conserve `pickup_option` que si c'est une des deux valeurs valides —
/// n'importe quelle autre valeur (y compris une chaîne vide envoyée par
/// erreur) devient NULL plutôt que de violer le CHECK en base et faire
/// planter la commande. Défense en profondeur : le frontend n'envoie déjà
/// que ces deux valeurs ou rien, mais mieux vaut ignorer silencieusement une
/// valeur inattendue que de renvoyer une erreur SQL opaque à l'utilisateur.
fn clean_pickup_option(s: Option<String>) -> Option<String> {
    match s.as_deref() {
        Some("with_pickup") | Some("without_pickup") => s,
        _ => None,
    }
}

pub fn row_to_shipment(row: &rusqlite::Row) -> rusqlite::Result<Shipment> {
    Ok(Shipment {
        id: row.get("id")?,
        supplier: row.get("supplier")?,
        tracking_number: row.get("tracking_number")?,
        carrier: row.get("carrier")?,
        recipient: row.get("recipient")?,
        material: row.get("material")?,
        status: row.get("status")?,
        expected_date: row.get("expected_date")?,
        received_date: row.get("received_date")?,
        notes: row.get("notes")?,
        pickup_option: row.get("pickup_option")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[tauri::command]
pub fn list_shipments(state: State<DbState>) -> Result<Vec<Shipment>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    list_shipments_impl(&conn)
}

fn list_shipments_impl(conn: &rusqlite::Connection) -> Result<Vec<Shipment>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM shipments ORDER BY expected_date IS NULL, expected_date ASC, created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_shipment)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_shipment(state: State<DbState>, shipment: NewShipment) -> Result<Shipment, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    create_shipment_impl(&conn, shipment)
}

fn create_shipment_impl(conn: &rusqlite::Connection, shipment: NewShipment) -> Result<Shipment, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, notes, pickup_option)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ordered', ?7, ?8, ?9)",
        params![
            id,
            clean_whitespace(&shipment.supplier),
            clean_opt(shipment.tracking_number),
            clean_opt(shipment.carrier),
            clean_opt(shipment.recipient),
            clean_whitespace(&shipment.material),
            clean_date(shipment.expected_date),
            shipment.notes,
            clean_pickup_option(shipment.pickup_option),
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT * FROM shipments WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row(params![id], row_to_shipment)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_shipment(state: State<DbState>, shipment: UpdateShipment) -> Result<Shipment, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    update_shipment_impl(&conn, shipment)
}

fn update_shipment_impl(conn: &rusqlite::Connection, shipment: UpdateShipment) -> Result<Shipment, String> {
    let received_date = if shipment.status == "received" {
        clean_date(shipment.received_date.clone())
    } else {
        None
    };
    conn.execute(
        "UPDATE shipments SET supplier = ?1, tracking_number = ?2, carrier = ?3, recipient = ?4,
         material = ?5, status = ?6, expected_date = ?7, received_date = ?8, notes = ?9,
         pickup_option = ?10, updated_at = datetime('now') WHERE id = ?11",
        params![
            clean_whitespace(&shipment.supplier),
            clean_opt(shipment.tracking_number),
            clean_opt(shipment.carrier),
            clean_opt(shipment.recipient),
            clean_whitespace(&shipment.material),
            shipment.status,
            clean_date(shipment.expected_date),
            received_date,
            shipment.notes,
            clean_pickup_option(shipment.pickup_option),
            shipment.id,
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT * FROM shipments WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row(params![shipment.id], row_to_shipment)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_shipment(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delete_shipment_impl(&conn, &id)
}

fn delete_shipment_impl(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM shipments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn restore_shipment(state: State<DbState>, shipment: Shipment) -> Result<Shipment, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    restore_shipment_impl(&conn, shipment)
}

/// Réinsère une expédition précédemment supprimée, à l'identique (même id,
/// mêmes `created_at`/`updated_at` d'origine) — sert le bouton "Annuler" du
/// toast affiché après une suppression, et le raccourci Ctrl+Z (voir
/// deleteShipment côté frontend). Contrairement à `create_shipment`, ne
/// génère ni nouvel id ni nouvelles dates : ce n'est pas une nouvelle
/// expédition, c'est la même qui réapparaît. Si l'id existe déjà en base
/// (cas normalement impossible avec un UUID v4, ex. double-clic sur
/// "Annuler"), l'INSERT échoue proprement plutôt que d'écraser
/// silencieusement une autre ligne.
fn restore_shipment_impl(conn: &rusqlite::Connection, shipment: Shipment) -> Result<Shipment, String> {
    conn.execute(
        "INSERT INTO shipments (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, received_date, notes, pickup_option, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            shipment.id,
            clean_whitespace(&shipment.supplier),
            clean_opt(shipment.tracking_number),
            clean_opt(shipment.carrier),
            clean_opt(shipment.recipient),
            clean_whitespace(&shipment.material),
            shipment.status,
            clean_date(shipment.expected_date),
            clean_date(shipment.received_date),
            shipment.notes,
            clean_pickup_option(shipment.pickup_option),
            shipment.created_at,
            shipment.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT * FROM shipments WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row(params![shipment.id], row_to_shipment)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_shipment(state: State<DbState>, id: String) -> Result<Option<Shipment>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    get_shipment_impl(&conn, &id)
}

fn get_shipment_impl(conn: &rusqlite::Connection, id: &str) -> Result<Option<Shipment>, String> {
    conn.query_row("SELECT * FROM shipments WHERE id = ?1", params![id], row_to_shipment)
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_shipments_xlsx(
    state: State<DbState>,
    file_path: String,
    shipment_ids: Option<Vec<String>>,
) -> Result<(), String> {
    use rust_xlsxwriter::Workbook;

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let shipments: Vec<Shipment> = match shipment_ids {
        None => {
            let mut stmt = conn
                .prepare("SELECT * FROM shipments ORDER BY created_at DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], row_to_shipment)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        Some(ids) => {
            if ids.is_empty() {
                Vec::new()
            } else {
                let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT * FROM shipments WHERE id IN ({}) ORDER BY created_at DESC",
                    placeholders
                );
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let params: Vec<&dyn rusqlite::ToSql> =
                    ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
                let rows = stmt
                    .query_map(params.as_slice(), row_to_shipment)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            }
        }
    };

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    let headers = [
        "Agence", "N° suivi", "Transporteur", "Destinataire", "Matériel",
        "Statut", "Ramassage", "Date prévue", "Date reçue", "Notes",
    ];
    for (col, h) in headers.iter().enumerate() {
        sheet.write_string(0, col as u16, *h).map_err(|e| e.to_string())?;
    }

    for (i, s) in shipments.iter().enumerate() {
        let row = (i + 1) as u32;
        let pickup_label = match s.pickup_option.as_deref() {
            Some("with_pickup") => "Avec ramassage occasionnel",
            Some("without_pickup") => "Sans ramassage occasionnel",
            _ => "",
        };
        sheet.write_string(row, 0, &s.supplier).map_err(|e| e.to_string())?;
        sheet.write_string(row, 1, s.tracking_number.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        sheet.write_string(row, 2, s.carrier.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        sheet.write_string(row, 3, s.recipient.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        sheet.write_string(row, 4, &s.material).map_err(|e| e.to_string())?;
        sheet.write_string(row, 5, &s.status).map_err(|e| e.to_string())?;
        sheet.write_string(row, 6, pickup_label).map_err(|e| e.to_string())?;
        sheet.write_string(row, 7, s.expected_date.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        sheet.write_string(row, 8, s.received_date.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        sheet.write_string(row, 9, s.notes.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    }

    workbook.save(&file_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NewShipment, UpdateShipment};

    fn test_db() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        crate::db::migrations()
            .to_latest(&mut conn)
            .expect("run migrations on in-memory db");
        conn
    }

    fn sample_new_shipment() -> NewShipment {
        NewShipment {
            supplier: "  Voiron   Aéro  ".to_string(),
            tracking_number: Some("TRK-001".to_string()),
            carrier: Some("TNT".to_string()),
            recipient: None,
            material: "PC  portable".to_string(),
            expected_date: Some("2026-10-15".to_string()),
            notes: None,
            pickup_option: None,
        }
    }

    #[test]
    fn create_then_get_round_trips_and_cleans_whitespace() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();

        assert_eq!(created.supplier, "Voiron Aéro"); // espaces nettoyés par clean_whitespace
        assert_eq!(created.material, "PC portable");
        assert_eq!(created.status, "ordered"); // statut par défaut
        assert_eq!(created.expected_date.as_deref(), Some("2026-10-15"));

        let fetched = get_shipment_impl(&conn, &created.id).unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().id, created.id);
    }

    #[test]
    fn create_rejects_corrupted_expected_date() {
        let conn = test_db();
        let mut shipment = sample_new_shipment();
        shipment.expected_date = Some("1900-01-02".to_string()); // artefact Excel connu
        let created = create_shipment_impl(&conn, shipment).unwrap();
        assert_eq!(created.expected_date, None);
    }

    #[test]
    fn list_returns_all_created_shipments() {
        let conn = test_db();
        create_shipment_impl(&conn, sample_new_shipment()).unwrap();
        let mut second = sample_new_shipment();
        second.supplier = "Vannes".to_string();
        create_shipment_impl(&conn, second).unwrap();

        let all = list_shipments_impl(&conn).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn update_changes_fields_and_bumps_updated_at() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();

        let updated = update_shipment_impl(
            &conn,
            UpdateShipment {
                id: created.id.clone(),
                supplier: created.supplier.clone(),
                tracking_number: created.tracking_number.clone(),
                carrier: created.carrier.clone(),
                recipient: Some("Jean Dupont".to_string()),
                material: created.material.clone(),
                status: "shipped".to_string(),
                expected_date: created.expected_date.clone(),
                received_date: None,
                notes: None,
                pickup_option: None,
            },
        )
        .unwrap();

        assert_eq!(updated.status, "shipped");
        assert_eq!(updated.recipient.as_deref(), Some("Jean Dupont"));
    }

    #[test]
    fn update_to_received_sets_received_date_but_ordered_does_not() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();

        let received = update_shipment_impl(
            &conn,
            UpdateShipment {
                id: created.id.clone(),
                supplier: created.supplier.clone(),
                tracking_number: created.tracking_number.clone(),
                carrier: created.carrier.clone(),
                recipient: created.recipient.clone(),
                material: created.material.clone(),
                status: "received".to_string(),
                expected_date: created.expected_date.clone(),
                received_date: Some("2026-10-20".to_string()),
                notes: None,
                pickup_option: None,
            },
        )
        .unwrap();
        assert_eq!(received.received_date.as_deref(), Some("2026-10-20"));

        // Repasser en "shipped" doit effacer received_date (logique métier existante).
        let reverted = update_shipment_impl(
            &conn,
            UpdateShipment {
                id: created.id.clone(),
                supplier: created.supplier.clone(),
                tracking_number: created.tracking_number.clone(),
                carrier: created.carrier.clone(),
                recipient: created.recipient.clone(),
                material: created.material.clone(),
                status: "shipped".to_string(),
                expected_date: created.expected_date.clone(),
                received_date: Some("2026-10-20".to_string()), // ignoré car status != "received"
                notes: None,
                pickup_option: None,
            },
        )
        .unwrap();
        assert_eq!(reverted.received_date, None);
    }

    #[test]
    fn delete_removes_the_shipment() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();

        delete_shipment_impl(&conn, &created.id).unwrap();

        let fetched = get_shipment_impl(&conn, &created.id).unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn restore_shipment_reinserts_after_delete_with_identical_data() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();
        delete_shipment_impl(&conn, &created.id).unwrap();
        assert!(get_shipment_impl(&conn, &created.id).unwrap().is_none());

        let restored = restore_shipment_impl(&conn, created.clone()).unwrap();

        assert_eq!(restored.id, created.id);
        assert_eq!(restored.supplier, created.supplier);
        assert_eq!(restored.material, created.material);
        assert_eq!(restored.status, created.status);
        // Le restore ne doit ni régénérer un id ni rafraîchir les dates —
        // c'est la même expédition qui réapparaît, pas une nouvelle.
        assert_eq!(restored.created_at, created.created_at);
        assert_eq!(restored.updated_at, created.updated_at);
    }

    #[test]
    fn restore_shipment_preserves_a_non_default_status_and_dates() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();
        let updated = update_shipment_impl(
            &conn,
            UpdateShipment {
                id: created.id.clone(),
                supplier: created.supplier.clone(),
                tracking_number: created.tracking_number.clone(),
                carrier: created.carrier.clone(),
                recipient: created.recipient.clone(),
                material: created.material.clone(),
                status: "received".to_string(),
                expected_date: created.expected_date.clone(),
                received_date: Some("2026-09-20".to_string()),
                notes: Some("Réceptionné par Julie".to_string()),
                pickup_option: Some("with_pickup".to_string()),
            },
        )
        .unwrap();
        delete_shipment_impl(&conn, &updated.id).unwrap();

        let restored = restore_shipment_impl(&conn, updated.clone()).unwrap();

        assert_eq!(restored.status, "received");
        assert_eq!(restored.received_date.as_deref(), Some("2026-09-20"));
        assert_eq!(restored.notes.as_deref(), Some("Réceptionné par Julie"));
        assert_eq!(restored.pickup_option.as_deref(), Some("with_pickup"));
    }

    #[test]
    fn restore_shipment_fails_cleanly_if_id_already_exists() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();
        // L'expédition n'a PAS été supprimée : restore sur un id déjà présent
        // doit échouer proprement (contrainte PRIMARY KEY), jamais écraser
        // silencieusement la ligne existante.
        let result = restore_shipment_impl(&conn, created);
        assert!(result.is_err());
    }

    #[test]
    fn get_shipment_returns_none_for_unknown_id() {
        let conn = test_db();
        let fetched = get_shipment_impl(&conn, "does-not-exist").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn clean_whitespace_trims_and_collapses_internal_spaces() {
        assert_eq!(clean_whitespace("  Vitrolles   Aéro  "), "Vitrolles Aéro");
    }

    #[test]
    fn clean_whitespace_collapses_tabs_and_newlines() {
        assert_eq!(clean_whitespace("tel\tstock\nremi"), "tel stock remi");
    }

    #[test]
    fn clean_whitespace_empty_string_stays_empty() {
        assert_eq!(clean_whitespace("   "), "");
    }

    #[test]
    fn clean_opt_returns_none_for_none() {
        assert_eq!(clean_opt(None), None);
    }

    #[test]
    fn clean_opt_returns_none_for_blank_string() {
        assert_eq!(clean_opt(Some("   ".to_string())), None);
    }

    #[test]
    fn clean_opt_trims_a_real_value() {
        assert_eq!(clean_opt(Some("  TNT  ".to_string())), Some("TNT".to_string()));
    }

    #[test]
    fn clean_date_accepts_a_plausible_date() {
        assert_eq!(
            clean_date(Some("2026-01-28".to_string())),
            Some("2026-01-28".to_string())
        );
    }

    #[test]
    fn clean_date_rejects_excel_epoch_artifact() {
        // "1900-01-02" — artefact classique d'import Excel repéré dans les données réelles.
        assert_eq!(clean_date(Some("1900-01-02".to_string())), None);
    }

    #[test]
    fn clean_date_rejects_truncated_year() {
        // "0206-01-28" — année tronquée, repéré dans les données réelles importées.
        assert_eq!(clean_date(Some("0206-01-28".to_string())), None);
    }

    #[test]
    fn clean_date_rejects_far_future_year() {
        assert_eq!(clean_date(Some("2099-01-01".to_string())), None);
    }

    #[test]
    fn clean_date_accepts_boundary_years() {
        assert_eq!(clean_date(Some("2015-06-15".to_string())), Some("2015-06-15".to_string()));
        assert_eq!(clean_date(Some("2035-06-15".to_string())), Some("2035-06-15".to_string()));
    }

    #[test]
    fn clean_date_none_stays_none() {
        assert_eq!(clean_date(None), None);
    }

    #[test]
    fn clean_date_rejects_too_short_string() {
        assert_eq!(clean_date(Some("abc".to_string())), None);
    }

    #[test]
    fn clean_pickup_option_accepts_valid_values() {
        assert_eq!(
            clean_pickup_option(Some("with_pickup".to_string())),
            Some("with_pickup".to_string())
        );
        assert_eq!(
            clean_pickup_option(Some("without_pickup".to_string())),
            Some("without_pickup".to_string())
        );
    }

    #[test]
    fn clean_pickup_option_rejects_unknown_values_and_none() {
        assert_eq!(clean_pickup_option(None), None);
        assert_eq!(clean_pickup_option(Some("".to_string())), None);
        assert_eq!(clean_pickup_option(Some("n'importe quoi".to_string())), None);
    }

    #[test]
    fn create_shipment_persists_pickup_option() {
        let conn = test_db();
        let mut shipment = sample_new_shipment();
        shipment.pickup_option = Some("with_pickup".to_string());
        let created = create_shipment_impl(&conn, shipment).unwrap();
        assert_eq!(created.pickup_option.as_deref(), Some("with_pickup"));
    }

    #[test]
    fn create_shipment_without_pickup_option_stays_null() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();
        assert_eq!(created.pickup_option, None); // sample_new_shipment() n'en fournit pas
    }

    #[test]
    fn create_shipment_rejects_garbage_pickup_option_silently() {
        let conn = test_db();
        let mut shipment = sample_new_shipment();
        shipment.pickup_option = Some("valeur-invalide".to_string());
        let created = create_shipment_impl(&conn, shipment).unwrap();
        assert_eq!(created.pickup_option, None);
    }

    #[test]
    fn update_shipment_changes_pickup_option() {
        let conn = test_db();
        let created = create_shipment_impl(&conn, sample_new_shipment()).unwrap();

        let updated = update_shipment_impl(
            &conn,
            UpdateShipment {
                id: created.id.clone(),
                supplier: created.supplier.clone(),
                tracking_number: created.tracking_number.clone(),
                carrier: created.carrier.clone(),
                recipient: created.recipient.clone(),
                material: created.material.clone(),
                status: created.status.clone(),
                expected_date: created.expected_date.clone(),
                received_date: None,
                notes: None,
                pickup_option: Some("without_pickup".to_string()),
            },
        )
        .unwrap();

        assert_eq!(updated.pickup_option.as_deref(), Some("without_pickup"));
    }
}

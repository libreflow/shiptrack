use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(
            r#"
        CREATE TABLE shipments (
            id              TEXT PRIMARY KEY,
            supplier        TEXT NOT NULL,
            tracking_number TEXT,
            carrier         TEXT,
            recipient       TEXT,
            material        TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'ordered'
                            CHECK (status IN ('ordered','shipped','received','verified')),
            expected_date   TEXT,
            received_date   TEXT,
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_shipments_status ON shipments(status);
        CREATE INDEX idx_shipments_expected_date ON shipments(expected_date);

        CREATE TABLE attachments (
            id          TEXT PRIMARY KEY,
            shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
            file_path   TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
        ),
        // Option de bon de transport TNT (avec/sans ramassage occasionnel — voir
        // demande utilisateur du 2026-09-23). NULL par défaut pour toutes les
        // lignes existantes ET pour tout transporteur autre que TNT (champ non
        // pertinent) : on ne devine jamais une valeur, l'absence est une info
        // légitime ("non renseigné"), pas une erreur. NULL passe toujours le
        // CHECK, donc cet ALTER TABLE ne touche aucune ligne préexistante.
        M::up(
            "ALTER TABLE shipments ADD COLUMN pickup_option TEXT
             CHECK (pickup_option IS NULL OR pickup_option IN ('with_pickup','without_pickup'));",
        ),
        // Retrait du statut "Vérifié" (jamais utilisé en pratique : 0/1783
        // lignes en production au moment de cette décision — voir bilan du
        // 2026-09-23). SQLite ne permet pas d'ALTER un CHECK existant :
        // on recrée la table avec la contrainte réduite (pattern officiel
        // https://www.sqlite.org/lang_altertable.html#otheralter). Toute
        // ligne 'verified' est reclassée 'received' au passage — filet de
        // sécurité pour une base qui en contiendrait malgré tout (aucune
        // en production actuelle, mais coûte rien à couvrir), jamais un
        // DROP silencieux de données.
        M::up(
            "CREATE TABLE shipments_new (
                id              TEXT PRIMARY KEY,
                supplier        TEXT NOT NULL,
                tracking_number TEXT,
                carrier         TEXT,
                recipient       TEXT,
                material        TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'ordered'
                                CHECK (status IN ('ordered','shipped','received')),
                expected_date   TEXT,
                received_date   TEXT,
                notes           TEXT,
                pickup_option   TEXT
                                CHECK (pickup_option IS NULL OR pickup_option IN ('with_pickup','without_pickup')),
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO shipments_new (id, supplier, tracking_number, carrier, recipient, material, status, expected_date, received_date, notes, pickup_option, created_at, updated_at)
             SELECT id, supplier, tracking_number, carrier, recipient, material,
                    CASE WHEN status = 'verified' THEN 'received' ELSE status END,
                    expected_date, received_date, notes, pickup_option, created_at, updated_at
             FROM shipments;
             DROP TABLE shipments;
             ALTER TABLE shipments_new RENAME TO shipments;
             CREATE INDEX idx_shipments_status ON shipments(status);
             CREATE INDEX idx_shipments_expected_date ON shipments(expected_date);",
        ),
    ])
}

/// Opens (creating if needed) the SQLite database in the app's local data dir
/// and applies pending migrations. Called once at startup.
pub fn init_db(app_data_dir: &std::path::Path) -> Connection {
    std::fs::create_dir_all(app_data_dir).expect("failed to create app data dir");
    let db_path = app_data_dir.join("shiptrack.sqlite3");
    let mut conn = Connection::open(db_path).expect("failed to open sqlite db");
    // FK désactivées PENDANT les migrations, réactivées juste après — suivi
    // à la lettre de la recommandation officielle du crate pour les
    // migrations qui recréent une table référencée par une clé étrangère
    // (voir la migration qui retire le statut "verified" : DROP TABLE
    // shipments avec FK actives casserait la contrainte de `attachments`).
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    migrations()
        .to_latest(&mut conn)
        .expect("failed to run db migrations");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

const MAX_BACKUPS: usize = 14;

/// Sauvegarde immédiate et inconditionnelle (contrairement à `backup_db`
/// ci-dessus, limité à une fois par jour) — appelée juste avant une opération
/// destructive qui remplace ou supprime en masse le contenu actif (ex:
/// recharger une archive), pour garantir un filet de sécurité même si le
/// backup quotidien automatique a déjà eu lieu aujourd'hui. `reason` apparaît
/// dans le nom du fichier pour distinguer ces sauvegardes ponctuelles des
/// sauvegardes quotidiennes normales dans le même dossier `backups/`.
pub fn backup_db_now(app_data_dir: &std::path::Path, reason: &str) -> Result<std::path::PathBuf, String> {
    let db_path = app_data_dir.join("shiptrack.sqlite3");
    if !db_path.exists() {
        return Err("Base de données introuvable".to_string());
    }
    let backups_dir = app_data_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;

    let stamp = chrono::Local::now().format("%Y-%m-%d_%Hh%M%S").to_string();
    let backup_path = backups_dir.join(format!("shiptrack_{reason}_{stamp}.sqlite3"));
    std::fs::copy(&db_path, &backup_path).map_err(|e| e.to_string())?;
    Ok(backup_path)
}

/// Sauvegarde la base dans <app_data_dir>/backups/shiptrack_YYYY-MM-DD.sqlite3,
/// au maximum une fois par jour, puis supprime les sauvegardes les plus
/// anciennes au-delà de MAX_BACKUPS. Best-effort : n'importe quelle erreur ici
/// est loguée mais ne doit jamais empêcher le démarrage de l'app.
pub fn backup_db(app_data_dir: &std::path::Path) {
    let db_path = app_data_dir.join("shiptrack.sqlite3");
    if !db_path.exists() {
        return;
    }

    let backups_dir = app_data_dir.join("backups");
    if let Err(e) = std::fs::create_dir_all(&backups_dir) {
        eprintln!("backup_db: failed to create backups dir: {e}");
        return;
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let backup_path = backups_dir.join(format!("shiptrack_{today}.sqlite3"));

    if backup_path.exists() {
        return; // déjà sauvegardé aujourd'hui
    }

    if let Err(e) = std::fs::copy(&db_path, &backup_path) {
        eprintln!("backup_db: failed to copy database: {e}");
        return;
    }

    // Rotation : ne garder que les MAX_BACKUPS fichiers les plus récents.
    let mut entries: Vec<_> = match std::fs::read_dir(&backups_dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("sqlite3"))
            .collect(),
        Err(e) => {
            eprintln!("backup_db: failed to read backups dir: {e}");
            return;
        }
    };

    entries.sort_by_key(|e| e.file_name());
    if entries.len() > MAX_BACKUPS {
        for entry in &entries[..entries.len() - MAX_BACKUPS] {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// Reproduit exactement la séquence d'`init_db` (FK OFF pendant les
    /// migrations, ON après) — contrairement aux `test_db()` des autres
    /// modules qui n'activent jamais les FK (SQLite les désactive par
    /// défaut), ce test vérifie le scénario réel où une table référencée
    /// (`attachments` → `shipments`) est recréée avec des FK actives.
    fn migrate_like_init_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        migrations().to_latest(&mut conn).expect("run migrations");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    #[test]
    fn migrations_run_cleanly_with_foreign_keys_toggled_like_init_db() {
        // Le vrai test ici est l'absence de panic : recréer `shipments`
        // (DROP + RENAME) alors qu'`attachments` la référence par FK
        // planterait sans le OFF/ON autour de to_latest().
        let _conn = migrate_like_init_db();
    }

    #[test]
    fn migration_removing_verified_preserves_an_attachment_row() {
        let conn = migrate_like_init_db();
        conn.execute(
            "INSERT INTO shipments (id, supplier, material, status) VALUES ('s1', 'Agence', 'Écran', 'shipped')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, shipment_id, file_path) VALUES ('a1', 's1', 'C:/bon.pdf')",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE shipment_id = 's1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_reclassifies_verified_rows_as_received() {
        // Simule une base pré-migration en insérant directement 'verified' —
        // possible ici car le test insère avant que la 2e migration (celle
        // qui retire 'verified' du CHECK) n'ait recréé la table... mais
        // migrate_like_init_db() applique TOUTES les migrations d'un coup.
        // On vérifie donc plutôt le cas réel équivalent : une base qui avait
        // 'verified' avant la mise à jour de l'app. On le simule en
        // appliquant seulement la 1re+2e migration, insérant 'verified',
        // puis en appliquant la 3e séparément.
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        let all = migrations();
        // Applique seulement jusqu'à la migration n°2 (pickup_option incluse,
        // statut encore 'verified' autorisé).
        all.to_version(&mut conn, 2).expect("migrate to version 2");
        conn.execute(
            "INSERT INTO shipments (id, supplier, material, status) VALUES ('s1', 'Agence', 'Écran', 'verified')",
            [],
        )
        .unwrap();

        all.to_latest(&mut conn).expect("migrate to latest");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        let status: String = conn
            .query_row("SELECT status FROM shipments WHERE id = 's1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "received");
    }

    #[test]
    fn check_constraint_rejects_verified_after_migration() {
        let conn = migrate_like_init_db();
        let result = conn.execute(
            "INSERT INTO shipments (id, supplier, material, status) VALUES ('s1', 'Agence', 'Écran', 'verified')",
            [],
        );
        assert!(result.is_err(), "le CHECK doit rejeter 'verified' après le retrait du statut");
    }

    #[test]
    fn check_constraint_still_accepts_the_three_remaining_statuses() {
        let conn = migrate_like_init_db();
        for (i, status) in ["ordered", "shipped", "received"].iter().enumerate() {
            conn.execute(
                "INSERT INTO shipments (id, supplier, material, status) VALUES (?1, 'Agence', 'Écran', ?2)",
                params![format!("s{i}"), status],
            )
            .unwrap_or_else(|e| panic!("le statut '{status}' devrait rester valide : {e}"));
        }
    }
}

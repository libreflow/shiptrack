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
    ])
}

/// Opens (creating if needed) the SQLite database in the app's local data dir
/// and applies pending migrations. Called once at startup.
pub fn init_db(app_data_dir: &std::path::Path) -> Connection {
    std::fs::create_dir_all(app_data_dir).expect("failed to create app data dir");
    let db_path = app_data_dir.join("shiptrack.sqlite3");
    let mut conn = Connection::open(db_path).expect("failed to open sqlite db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations()
        .to_latest(&mut conn)
        .expect("failed to run db migrations");
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

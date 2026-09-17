mod commands;
mod db;
mod import;
mod models;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .expect("failed to resolve app local data dir");

            // Sauvegarde quotidienne best-effort avant d'ouvrir la connexion de la session.
            db::backup_db(&app_data_dir);

            let conn = db::init_db(&app_data_dir);

            // Notifie au démarrage s'il y a des expéditions en retard.
            let late_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM shipments
                     WHERE status NOT IN ('received','verified')
                     AND expected_date IS NOT NULL
                     AND date(expected_date) < date('now')",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            if late_count > 0 {
                let body = if late_count == 1 {
                    "1 expédition est en retard.".to_string()
                } else {
                    format!("{late_count} expéditions sont en retard.")
                };
                let _ = app
                    .notification()
                    .builder()
                    .title("ShipTrack")
                    .body(body)
                    .show();
            }

            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_shipments,
            commands::create_shipment,
            commands::update_shipment,
            commands::delete_shipment,
            commands::get_shipment,
            commands::count_late_shipments,
            commands::export_shipments_xlsx,
            import::list_excel_sheets,
            import::import_excel_sheet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

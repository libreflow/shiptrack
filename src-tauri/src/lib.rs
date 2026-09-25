mod archive;
mod commands;
mod db;
mod import;
mod models;
mod pdf_import;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .expect("failed to resolve app local data dir");

            // Sauvegarde quotidienne best-effort avant d'ouvrir la connexion de la session.
            db::backup_db(&app_data_dir);

            let conn = db::init_db(&app_data_dir);

            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_shipments,
            commands::create_shipment,
            commands::update_shipment,
            commands::delete_shipment,
            commands::restore_shipment,
            commands::get_shipment,
            commands::export_shipments_xlsx,
            import::list_excel_sheets,
            import::import_excel_sheet,
            pdf_import::parse_shipping_note_pdf,
            pdf_import::parse_shipping_notes_pdfs,
            archive::count_archivable,
            archive::archive_shipments_before,
            archive::list_archives,
            archive::reload_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

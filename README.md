# Shiptrack

Suivi d'expéditions et de réception de matériel IT — application desktop **Tauri 2** (front JavaScript vanilla + Vite, back Rust dans `src-tauri`, interface en français).

## Fonctionnalités

- **Suivi des expéditions** : CRUD complet, statuts (Commandé / Expédié / Reçu) avec cycle rapide au clic sur le badge, groupement par mois, recherche et filtres (fournisseur, destinataire, statut…).
- **Lien de suivi** : transporteur inféré depuis le numéro, ouverture directe du lien de suivi.
- **Import Excel** : sélection de la feuille à importer, dédoublonnage et normalisation (accents, valeurs similaires).
- **Import batch de bons de transport PDF** : scan d'un dossier ou sélection de fichiers, prévisualisation éditable, création en masse.
- **Export Excel** (`rust_xlsxwriter`) des expéditions.
- **Archivage** : archivage des expéditions antérieures à une date, rechargement possible d'une archive.
- **Persistance** : base **SQLite** (`rusqlite` + migrations `rusqlite_migration`) dans le dossier de données de l'app, avec **sauvegarde quotidienne** best-effort au démarrage.
- Plugins Tauri officiels : `dialog`, `opener`, `notification`, `clipboard-manager`.

## Prérequis

- [Node.js](https://nodejs.org/) + npm
- [Rust](https://rustup.rs/) stable (outillage Tauri 2)
- Windows, macOS ou Linux

## Développement

```sh
npm install
npm run tauri dev
```

## Tests

```sh
npm test           # Vitest (front)
npm run check      # Vitest + cargo test (back)
```

Depuis `src-tauri` :

```sh
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

## Build

```sh
npm run tauri build
```

## Structure

- `src/` — front vanilla JS (modules `main.js`, `shipments.js`, `tracking.js`, `months.js`, `normalize.js`, `pdf_batch.js`) + tests Vitest.
- `src-tauri/src/` — back Rust : `commands.rs` (IPC), `db.rs` (SQLite + sauvegardes), `models.rs`, `import.rs` (Excel), `pdf_import.rs` (bons PDF), `archive.rs`.
- `AGENTS.md` — règles de contribution et conventions du repo.

## Licence

MIT — voir [LICENSE](LICENSE).

# ShipTrack

Application desktop de suivi des expéditions et réceptions de colis TNT / DPD — remplace le tableau Excel historique de suivi du matériel.

## Fonctionnalités

- **Tableau de suivi** : une ligne par expédition (agence, matériel, n° de suivi, transporteur, destinataire, dates, notes), tri multi-colonnes, regroupement par mois, colonnes redimensionnables.
- **Saisie rapide** en bas de tableau, avec détection de doublons d'agence et de n° de suivi déjà utilisés.
- **Édition inline** (double-clic sur une cellule), édition groupée transporteur/destinataire sur sélection multiple.
- **Import de bons de transport PDF (TNT)** : un fichier ou un dossier entier (`Scanner un dossier…`). Chaque bon devient une ligne pré-remplie (n° de suivi, transporteur, agence, destinataire, date prévue). Le champ **Notes** permet de préciser le contenu du colis à la main.
- **Lien de suivi** : génération d'une URL 17TRACK depuis le n° de suivi — aucun appel réseau depuis l'app.
- **Export Excel** (tout ou vue filtrée), **import Excel** historique.
- **Archivage** : une année active + archives rechargeables.
- **Annulation** : suppression avec toast « Annuler » et Ctrl+Z, sauvegarde quotidienne automatique (rotation de 14 backups).

## Stack

| Couche | Techno |
|---|---|
| Frontend | Vanilla JS + HTML + CSS (aucun framework), tests [Vitest](https://vitest.dev) |
| Backend | Rust + [Tauri 2](https://tauri.app), SQLite via `rusqlite` + `rusqlite_migration` |
| PDF | `pdf-extract` (parsing des bons TNT) |

## Développement

```bash
npm install
npm test              # tests frontend (Vitest, jsdom)
npm run check         # tests frontend + backend (cargo test)

npm run tauri dev     # lance l'app en mode dev
npm run tauri build   # build de production
```

Le backend Rust nécessite les dépendances système usuelles de Tauri (Linux : `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `pkg-config`).

## Modèle de données (SQLite)

Table `shipments` :

| Champ | Rôle |
|---|---|
| `id` | UUID v4 |
| `supplier` | Agence expéditrice (champ pivot, obligatoire) |
| `material` | Matériel suivi (jamais présent sur un bon PDF → placeholder « Non renseigné ») |
| `tracking_number` | N° de suivi TNT/DPD, ou « Non sécurisé » |
| `carrier` | TNT / DPD (déduit du n° de suivi si absent) |
| `recipient` | Destinataire |
| `status` | `ordered` / `shipped` / `received` |
| `expected_date`, `received_date` | Dates prévue / de réception (ISO) |
| `notes` | Notes libres (ex. contenu du colis) |
| `pickup_option` | Option de ramassage occasionnel TNT (`with_pickup` / `without_pickup`) |

Table `attachments` : pièces jointes liées par FK (`shipment_id`), effacées en cascade.

La base vit dans le répertoire de données local de l'app (`shiptrack.sqlite3`), avec sauvegarde quotidienne dans `backups/`.

## Architecture du code

```
src/
  main.js        # contrôleur UI principal (tableau, filtres, édition, import)
  shipments.js   # tri + filtres (pur, testé)
  normalize.js   # normalisation accents/casse, détection de doublons (pur)
  tracking.js    # URL de suivi, validation n° (pur)
  months.js      # regroupement par mois (pur)
  pdf_batch.js   # transformation bons PDF → lignes (pur)
  __tests__/     # tests Vitest (269 tests)
src-tauri/src/
  commands.rs    # commandes Tauri CRUD + export
  db.rs          # migrations SQLite + backups
  import.rs      # import Excel (calamine)
  pdf_import.rs  # parsing des bons TNT + scan de dossier
  archive.rs     # archivage annuel
```

La logique métier pure est isolée dans des modules testables ; `main.js` orchestre le DOM et les appels IPC.

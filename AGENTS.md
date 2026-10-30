# AGENTS.md — shiptrack

Règles de référence pour tout agent de code IA travaillant sur ce repo.

## Projet
Suivi d'expéditions IT — app desktop Tauri 2 (front JS vanilla + Vite, back Rust dans `src-tauri`), tests Vitest.

## Commandes
- `npm run tauri dev` — dev
- `npm run build` — build front
- `npm test` — Vitest
- Rust (depuis `src-tauri`) : `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`

## Règles Tauri 2 (non négociables)
- Toute commande IPC Rust est `async fn` et déclarée dans `generate_handler!` (les commandes sync gèlent l'UI).
- Capabilities au moindre privilège : pas d'élargissement de permissions ni de wildcard sans justification dans la PR.
- Ne pas modifier `tauri.conf.json` sans accord explicite du mainteneur.
- Plugins officiels privilégiés (dialog, fs, opener, log, http) plutôt que du custom.

## Sécurité
- Jamais de secret ni de clé d'API dans le code front ou le back ; les credentials passent par la config système.
- Toute nouvelle dépendance (npm ou crate) doit être auditée avant ajout (maintenance, alertes sécurité).

## Workflow
- Une tâche = une issue = une petite PR focalisée.
- Spécification courte (contexte + critères d'acceptation) écrite avant de coder.
- CI verte obligatoire avant tout merge ; vérification manuelle (`npm run tauri dev`) requise avant toute release.

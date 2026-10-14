use serde::Serialize;

/// Adresse du siège Adéquat, utilisée pour distinguer le sens d'un bon de
/// transport TNT : soit le siège EXPÉDIE vers une agence, soit une agence
/// RETOURNE du matériel au siège. Le bloc qui n'est PAS le siège est la
/// véritable "Agence" à renseigner dans ShipTrack. Marqueur volontairement
/// spécifique (numéro de rue + mot rare) pour éviter un faux positif sur un
/// nom de rue générique ("Rue de la République" existe dans plein de villes).
const SIEGE_MARKERS: [&str; 2] = ["vendome", "adequat service informatique"];

/// Résultat de l'extraction d'un bon de transport TNT en PDF — champs prêts à
/// pré-remplir la ligne de saisie rapide. Chaque champ est `None` si non
/// trouvé/non fiable : on ne devine jamais, l'utilisateur complète à la main
/// ce qui manque (voir aussi `warnings` pour expliquer pourquoi).
#[derive(Debug, Serialize, PartialEq, Eq, Default)]
pub struct ParsedShippingNote {
    pub carrier: Option<String>,
    pub tracking_number: Option<String>,
    pub agency: Option<String>,
    pub recipient: Option<String>,
    pub expected_date: Option<String>,
    /// Explications lisibles pour l'utilisateur quand un champ n'a pas pu
    /// être déduit avec confiance (ex: sens du document ambigu) — jamais une
    /// erreur bloquante, juste un contexte affiché à côté du formulaire.
    pub warnings: Vec<String>,
}

fn normalize_ascii_lower(s: &str) -> String {
    // Retrait simple des accents courants (pas d'unicode-normalization ici :
    // dépendance déjà tirée par ailleurs si besoin, mais évitée pour ce
    // module volontairement minimal — voir Cargo.toml).
    s.chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'û' | 'ü' | 'ù' => 'u',
            'ç' => 'c',
            other => other,
        })
        .collect::<String>()
        .to_lowercase()
}

fn is_siege_block(lines: &[String]) -> bool {
    let blob = normalize_ascii_lower(&lines.join(" "));
    SIEGE_MARKERS.iter().any(|m| blob.contains(m))
}

/// Lignes de bruit connues sur les bons TNT réels : codes agence internes à
/// 2 lettres (MW, PW, BJ...), mentions fixes, codes postaux/tri isolés. Ne
/// JAMAIS y mettre un vrai nom de ville/agence : calibré sur des exemplaires
/// réels TNT (voir tests), à étendre seulement avec de nouveaux exemplaires.
fn is_noise_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    let low = normalize_ascii_lower(t);
    if matches!(low.as_str(), "mw" | "pw" | "bj" | "bew" | "fml" | "fr") {
        return true;
    }
    // Ligne uniquement numérique (code postal/tri isolé, 4 à 7 chiffres).
    if t.len() <= 7 && t.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    false
}

/// Une ligne "ressemble" à un nom de personne : 1 à 4 mots, pas de chiffre,
/// aucun mot-clé d'adresse/société. Sert à isoler le destinataire nominatif
/// dans un bloc adresse qui contient aussi rue/ville/société.
fn looks_like_person_name(line: &str) -> bool {
    let low = normalize_ascii_lower(line);
    const ADDRESS_WORDS: [&str; 8] = [
        "agence", "rue", "avenue", "boulevard", "batiment", "service", "informatique", "cedex",
    ];
    if ADDRESS_WORDS.iter().any(|w| low.contains(w)) {
        return false;
    }
    if line.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    let word_count = line.split_whitespace().count();
    (1..=4).contains(&word_count)
}

/// Extrait la plus longue suite de chiffres consécutifs du document, puis en
/// garde les 16 derniers caractères. Nécessaire car `pdf_extract` concatène
/// parfois des blocs de texte adjacents sans espace côte à côte (ex. un code
/// de tri interne collé juste avant le vrai numéro de suivi) — un numéro
/// TNT/DPD fait 16 chiffres, toujours à la fin de la plus longue suite
/// observée sur les bons réels. Retourne None si aucune suite ne fait au
/// moins 16 chiffres.
fn extract_tracking_number(text: &str) -> Option<String> {
    text.split(|c: char| !c.is_ascii_digit())
        .filter(|run| run.len() >= 16)
        .max_by_key(|run| run.len())
        .map(|run| run[run.len() - 16..].to_string())
}

fn extract_date(text: &str) -> Option<String> {
    // "Le  : 08/09/2026" — le nombre d'espaces avant/après ':' varie selon
    // les exemplaires réels, d'où le split large plutôt qu'un pattern figé.
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Le") {
            let rest = rest.trim_start_matches([' ', ':']).trim();
            if rest.len() >= 10 {
                let candidate = &rest[..10];
                let parts: Vec<&str> = candidate.split('/').collect();
                if parts.len() == 3 && parts[0].len() == 2 && parts[1].len() == 2 && parts[2].len() == 4 {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}

/// Convertit "JJ/MM/AAAA" (format affiché sur le bon) en "AAAA-MM-JJ" (format
/// de stockage ShipTrack) — jamais l'inverse, cohérent avec `formatDateFr`
/// côté frontend qui fait la conversion retour pour l'affichage.
fn to_iso_date(fr_date: &str) -> Option<String> {
    let parts: Vec<&str> = fr_date.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    Some(format!("{}-{}-{}", parts[2], parts[1], parts[0]))
}

/// Découpe le texte brut en blocs "Exp" (expéditeur) et "Adresse de
/// livraison" (destinataire), lignes de bruit déjà filtrées. Chaque bloc
/// s'arrête à la première ligne vide, "---", ou en-tête du bloc suivant —
/// tel qu'observé sur tous les exemplaires réels (voir tests).
fn extract_address_blocks(text: &str) -> (Vec<String>, Vec<String>) {
    let mut exp_lines = Vec::new();
    let mut delivery_lines = Vec::new();
    #[derive(PartialEq)]
    enum Mode {
        None,
        Exp,
        Delivery,
    }
    let mut mode = Mode::None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        let low = normalize_ascii_lower(line);

        if low.starts_with("exp") {
            mode = Mode::Exp;
            // "Exp : ADEQUAT SERVICE INFORMATIQUE" -> garde la partie après ':'.
            if let Some((_, rest)) = line.split_once(':') {
                let rest = rest.trim();
                if !rest.is_empty() && !is_noise_line(rest) {
                    exp_lines.push(rest.to_string());
                }
            }
            continue;
        }
        if low.contains("adresse") && low.contains("livraison") {
            mode = Mode::Delivery;
            continue;
        }
        if line.starts_with("---") {
            mode = Mode::None;
            continue;
        }
        // Le bloc Exp s'arrête à la première ligne vide OU dès la ligne
        // Tél/Web (colonne de droite qui suit immédiatement dans le flux de
        // texte linéaire). Le bloc Delivery, lui, NE s'arrête PAS sur une
        // ligne vide : sur les bons réels, le nom du destinataire apparaît
        // après une ligne vide À L'INTÉRIEUR du bloc adresse de livraison
        // (ex: "...FR\n\nMAZEAU Renaud") — seul "---" marque sa fin.
        if mode == Mode::Exp && (line.is_empty() || low.starts_with("tel") || low.starts_with("web") || low.starts_with("ref")) {
            mode = Mode::None;
            continue;
        }
        if line.is_empty() {
            continue; // ligne vide à l'intérieur d'un bloc Delivery : ignorée, ne coupe rien
        }

        match mode {
            Mode::Exp if !is_noise_line(line) => exp_lines.push(line.to_string()),
            Mode::Delivery if !is_noise_line(line) => delivery_lines.push(line.to_string()),
            _ => {}
        }
    }

    (exp_lines, delivery_lines)
}

/// Parse le texte brut extrait d'un bon de transport TNT (`pdf_extract`) en
/// champs exploitables par ShipTrack. Fonction pure — aucun accès fichier —
/// pour rester testable avec du texte figé, sans dépendre de vrais PDF dans
/// le dépôt. Ne gère QUE le format TNT pour l'instant (voir warning) : DPD
/// et les autres transporteurs n'ont pas été vus sur un exemplaire réel, un
/// parsing spéculatif serait plus dangereux qu'utile (fausse confiance sur
/// des champs mal extraits).
pub fn parse_shipping_note(text: &str) -> ParsedShippingNote {
    let mut result = ParsedShippingNote::default();

    let low_text = normalize_ascii_lower(text);
    if !low_text.contains("tnt") {
        result
            .warnings
            .push("Format non reconnu (seuls les bons TNT sont supportés actuellement) — remplissez manuellement.".to_string());
        return result;
    }
    result.carrier = Some("TNT".to_string());

    result.tracking_number = extract_tracking_number(text);
    if result.tracking_number.is_none() {
        result
            .warnings
            .push("N° de suivi non trouvé dans le document.".to_string());
    }

    if let Some(fr_date) = extract_date(text) {
        result.expected_date = to_iso_date(&fr_date);
    }

    let (exp_lines, delivery_lines) = extract_address_blocks(text);
    let exp_is_siege = is_siege_block(&exp_lines);
    let delivery_is_siege = is_siege_block(&delivery_lines);

    let (agency_lines, recipient_source): (&[String], Option<&[String]>) = if exp_is_siege && !delivery_is_siege {
        (&delivery_lines, Some(&delivery_lines))
    } else if delivery_is_siege && !exp_is_siege {
        // Retour agence -> siège : le "destinataire" est le siège lui-même,
        // pas une personne — inutile et trompeur d'extraire un nom ici.
        (&exp_lines, None)
    } else {
        result.warnings.push(
            "Sens du bon (envoi/retour) ambigu : agence déduite du bloc \"Adresse de livraison\", à vérifier."
                .to_string(),
        );
        (&delivery_lines, Some(&delivery_lines))
    };

    result.agency = agency_lines.first().cloned();
    if result.agency.is_none() {
        result.warnings.push("Agence non trouvée dans le document.".to_string());
    }

    if let Some(source) = recipient_source {
        result.recipient = source.iter().rev().find(|l| looks_like_person_name(l)).cloned();
    }

    result
}

#[tauri::command]
pub fn parse_shipping_note_pdf(file_path: String) -> Result<ParsedShippingNote, String> {
    let text = pdf_extract::extract_text(&file_path)
        .map_err(|e| format!("Impossible de lire le PDF : {e}"))?;
    if text.trim().is_empty() {
        return Err("Le PDF ne contient aucun texte exploitable (scan image ?).".to_string());
    }
    Ok(parse_shipping_note(&text))
}

/// Résultat d'un fichier au sein d'un lot — jamais d'erreur globale : un PDF
/// illisible/non-TNT ne doit pas empêcher les autres du même lot d'être
/// traités (voir page "Import PDF (lot)"). Exactement un des deux champs
/// `parsed`/`error` est renseigné.
#[derive(Debug, Serialize, PartialEq)]
pub struct BatchParseResult {
    pub file_name: String,
    pub file_path: String,
    pub parsed: Option<ParsedShippingNote>,
    pub error: Option<String>,
}

fn parse_one_for_batch(file_path: &str) -> BatchParseResult {
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path)
        .to_string();

    match pdf_extract::extract_text(file_path) {
        Ok(text) if !text.trim().is_empty() => BatchParseResult {
            file_name,
            file_path: file_path.to_string(),
            parsed: Some(parse_shipping_note(&text)),
            error: None,
        },
        Ok(_) => BatchParseResult {
            file_name,
            file_path: file_path.to_string(),
            parsed: None,
            error: Some("Le PDF ne contient aucun texte exploitable (scan image ?).".to_string()),
        },
        Err(e) => BatchParseResult {
            file_name,
            file_path: file_path.to_string(),
            parsed: None,
            error: Some(format!("Impossible de lire le PDF : {e}")),
        },
    }
}

/// Traite un lot de bons PDF en une seule commande — un fichier en échec
/// (scan image, PDF corrompu...) n'empêche jamais le traitement des autres,
/// contrairement à `parse_shipping_note_pdf` qui échoue tout ou rien pour un
/// seul fichier à la fois.
#[tauri::command]
pub fn parse_shipping_notes_pdfs(file_paths: Vec<String>) -> Vec<BatchParseResult> {
    file_paths.iter().map(|p| parse_one_for_batch(p)).collect()
}

/// Liste récursive des fichiers PDF d'un dossier (tri par nom, chemins tels
/// que trouvés) — pour le bouton "Scanner un dossier" de la page "Import PDF
/// (lot)". Les fichiers non-PDF sont ignorés ; les erreurs par fichier restent
/// le travail de `parse_shipping_notes_pdfs`, ce scan ne fait que découvrir.
#[tauri::command]
pub fn scan_pdfs_in_directory(directory: String) -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&directory);
    if !dir.is_dir() {
        return Err(format!("Le dossier n'existe pas ou n'est pas un dossier : {directory}"));
    }
    let mut paths = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current)
            .map_err(|e| format!("Impossible de lire le dossier {} : {e}", current.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Impossible de lire une entrée de {} : {e}", current.display()))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
            {
                paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    paths.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Textes bruts réels, extraits via `pdf_extract::extract_text` de 4 bons
    // de transport TNT authentiques (Adéquat Service Informatique). Figés ici
    // en tant que texte plutôt que PDF binaire dans le dépôt — mêmes données,
    // sans embarquer de fichier binaire ni dépendre d'un chemin externe.

    const BON_ENVOI_PERIGUEUX: &str = "\n\nN° Compte : 06393475\nExp : ADEQUAT SERVICE INFORMATIQUE\n139 Rue Vendome\nBatiment C\n69006 - LYON 06\nTél : 0426726688 Web  : www.tnt.fr\n\nRéf.  :\nColis  : 1/1\nPoids : 1,0 Kgs\nLe  : 08/09/2026\n\nAdresse de livraison : Tél : 0553099060\nAgence Adéquat Perigueux\n51 rue Président Wilson MWLMF : 300826\n24000 - PERIGUEUX\nFR\n\nMAZEAU  Renaud\n\n--- SOUMIS AUX CONDITIONS GENERALES DE VENTE ET DE TRANSPORT TNT ---\n\n24A\n\n24000MW000002417777334853446WEB : 3.0\n";

    const BON_RETOUR_NIMES: &str = "\n\nN° Compte : 06393475\nExp : Agence Adéquat Nîmes\n226 rue Goerges Besse\nPARC GEORGES BESSE L'ALLIANCE\n30000 - NIMES\nTél : 0466363535 Web  : www.tnt.fr\n\nRéf.  :\nColis  : 1/1\nPoids : 1,0 Kgs\nLe  : 10/09/2026\n\nAdresse de livraison : Tél : 0426726688\nADEQUAT SERVICE INFORMATIQUE\n139 Rue Vendome\nBatiment C MWLMF : 300826\n69006 - LYON 06\nFR\n\nBJ\n--- SOUMIS AUX CONDITIONS GENERALES DE VENTE ET DE TRANSPORT TNT ---\n\n69A\n\n69006MW000006917777435216386WEB : 3.0\n";

    const BON_ENVOI_ROMANS: &str = "\n\nN° Compte : 06393475\nExp : ADEQUAT SERVICE INFORMATIQUE\n139 Rue Vendome\nBatiment C\n69006 - LYON 06\nTél : 0426726688 Web  : www.tnt.fr\n\nRéf.  :\nColis  : 1/1\nPoids : 5,0 Kgs\nLe  : 10/09/2026\n\nAdresse de livraison : Tél : 0475711200\nAgence Adéquat Romans\n2 avenue Duchesne PWLMF : 300826\n26100 - ROMANS SUR ISERE\nFR\n\nHillairet Marion\n\n--- SOUMIS AUX CONDITIONS GENERALES DE VENTE ET DE TRANSPORT TNT ---\n\n26A\n\n26100PW000002617777334951219WEB : 3.0\n";

    #[test]
    fn parses_envoi_siege_vers_agence() {
        let r = parse_shipping_note(BON_ENVOI_PERIGUEUX);
        assert_eq!(r.carrier.as_deref(), Some("TNT"));
        assert_eq!(r.tracking_number.as_deref(), Some("2417777334853446"));
        assert_eq!(r.agency.as_deref(), Some("Agence Adéquat Perigueux"));
        assert_eq!(r.recipient.as_deref(), Some("MAZEAU  Renaud"));
        assert_eq!(r.expected_date.as_deref(), Some("2026-09-08"));
        assert!(r.warnings.is_empty(), "warnings inattendus : {:?}", r.warnings);
    }

    #[test]
    fn parses_retour_agence_vers_siege_sans_destinataire_nominatif() {
        let r = parse_shipping_note(BON_RETOUR_NIMES);
        assert_eq!(r.carrier.as_deref(), Some("TNT"));
        assert_eq!(r.tracking_number.as_deref(), Some("6917777435216386"));
        assert_eq!(r.agency.as_deref(), Some("Agence Adéquat Nîmes"));
        // Retour au siège : pas de destinataire nominatif à extraire.
        assert_eq!(r.recipient, None);
        assert_eq!(r.expected_date.as_deref(), Some("2026-09-10"));
    }

    #[test]
    fn parses_deuxieme_envoi_agence_differente() {
        let r = parse_shipping_note(BON_ENVOI_ROMANS);
        assert_eq!(r.tracking_number.as_deref(), Some("2617777334951219"));
        assert_eq!(r.agency.as_deref(), Some("Agence Adéquat Romans"));
        assert_eq!(r.recipient.as_deref(), Some("Hillairet Marion"));
    }

    #[test]
    fn format_non_tnt_renvoie_un_avertissement_sans_planter() {
        let r = parse_shipping_note("Un texte quelconque sans rapport avec un bon de transport.");
        assert_eq!(r.carrier, None);
        assert_eq!(r.tracking_number, None);
        assert!(!r.warnings.is_empty());
    }

    #[test]
    fn texte_vide_ne_panique_pas() {
        let r = parse_shipping_note("");
        assert_eq!(r.carrier, None);
        assert!(!r.warnings.is_empty());
    }

    #[test]
    fn extract_tracking_number_prend_les_16_derniers_chiffres_du_plus_long_run() {
        assert_eq!(
            extract_tracking_number("24000MW000002417777334853446WEB"),
            Some("2417777334853446".to_string())
        );
    }

    #[test]
    fn extract_tracking_number_none_si_aucune_suite_assez_longue() {
        assert_eq!(extract_tracking_number("12345 67890 courte"), None);
    }

    #[test]
    fn to_iso_date_convertit_fr_vers_iso() {
        assert_eq!(to_iso_date("08/09/2026"), Some("2026-09-08".to_string()));
    }

    #[test]
    fn looks_like_person_name_rejette_les_lignes_adresse() {
        assert!(!looks_like_person_name("Agence Adéquat Perigueux"));
        assert!(!looks_like_person_name("51 rue Président Wilson"));
        assert!(looks_like_person_name("MAZEAU Renaud"));
        assert!(looks_like_person_name("Hillairet Marion"));
    }

    #[test]
    fn is_noise_line_filtre_les_codes_internes_connus() {
        assert!(is_noise_line("MW"));
        assert!(is_noise_line("BJ"));
        assert!(is_noise_line("FR"));
        assert!(is_noise_line("628003"));
        assert!(!is_noise_line("Agence Adéquat Nîmes"));
    }

    #[test]
    fn parse_one_for_batch_gere_un_bon_valide() {
        // Simule via parse_shipping_note directement (parse_one_for_batch
        // fait juste l'extraction PDF autour, non testable sans vrai fichier
        // — voir jetable_verifie_extraction_reelle_depuis_un_vrai_fichier_pdf
        // dans une session précédente pour la couverture disque réelle).
        let r = parse_shipping_note(BON_ENVOI_PERIGUEUX);
        assert_eq!(r.agency.as_deref(), Some("Agence Adéquat Perigueux"));
    }

    #[test]
    fn parse_one_for_batch_fichier_introuvable_renvoie_une_erreur_pas_de_panic() {
        let result = parse_one_for_batch("Z:/chemin/qui/n/existe/manifestement/pas.pdf");
        assert!(result.parsed.is_none());
        assert!(result.error.is_some());
        assert_eq!(result.file_name, "pas.pdf");
    }

    #[test]
    fn parse_shipping_notes_pdfs_traite_chaque_fichier_independamment() {
        // Un chemin invalide au milieu du lot ne doit ni paniquer ni bloquer
        // le traitement des autres — c'est la garantie centrale de cette
        // commande par rapport à parse_shipping_note_pdf (tout-ou-rien).
        let results = parse_shipping_notes_pdfs(vec![
            "Z:/introuvable1.pdf".to_string(),
            "Z:/introuvable2.pdf".to_string(),
        ]);
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.error.is_some() && r.parsed.is_none()));
    }

    #[test]
    fn scan_trouve_les_pdf_recursivement_et_les_trie() {
        let root = std::env::temp_dir().join("shiptrack_scan_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sous-doss")).unwrap();
        std::fs::write(root.join("b.pdf"), b"x").unwrap();
        std::fs::write(root.join("a.PDF"), b"x").unwrap();
        std::fs::write(root.join("sous-doss/c.pdf"), b"x").unwrap();
        std::fs::write(root.join("ignore.txt"), b"x").unwrap();
        let paths = scan_pdfs_in_directory(root.to_string_lossy().into_owned()).unwrap();
        let names: Vec<&str> = paths
            .iter()
            .map(|p| std::path::Path::new(p).file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a.PDF", "b.pdf", "c.pdf"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_dossier_inexistant_echoue() {
        assert!(scan_pdfs_in_directory("/inexistant/xyz".to_string()).is_err());
    }

    #[test]
    fn scan_dossier_sans_pdf_renvoie_liste_vide() {
        let root = std::env::temp_dir().join("shiptrack_scan_empty");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.txt"), b"x").unwrap();
        assert!(scan_pdfs_in_directory(root.to_string_lossy().into_owned())
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_shipping_notes_pdfs_liste_vide_renvoie_liste_vide() {
        assert_eq!(parse_shipping_notes_pdfs(vec![]), Vec::new());
    }
}

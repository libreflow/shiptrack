"""Extrait les noms/prénoms de destinataires depuis le champ 'material' (texte libre)
vers le champ 'recipient', avec des règles à haute confiance uniquement.

Patterns pris en charge (dans cet ordre de priorité) :
  1. "... pour <Nom Prénom>"          -> "Ecran pour Delphine MOULIS"
  2. "<description> - <Nom Prénom>"   -> "PC 15\" LENOVO - LARGERON Nadege"
  3. Nom en fin de chaîne avec un mot TOUT EN MAJUSCULES adjacent à un mot Title Case
     (signal fort de nom de famille), en tout début OU toute fin de la chaîne.

Les lignes à faible confiance (ex: noms tout en minuscules mêlés au texte, comme
"tel guillot marjory") ne sont PAS touchées automatiquement : impossible de les
distinguer fiablement d'une description de matériel sans base de prénoms. Elles sont
listées en fin de rapport pour une revue manuelle éventuelle.

Usage: python scripts/extract_recipients.py [--dry-run]
"""
import re
import sqlite3
import sys

DB_PATH = (
    r"C:\Users\robin.diberardini\AppData\Local\com.robindiberardini.shiptrack\shiptrack.sqlite3"
)

# Mots qui ressemblent à un nom (Title Case / MAJUSCULES) mais n'en sont pas -> à exclure
NON_NAME_WORDS = {
    "PC", "TEL", "SIM", "HUB", "TP", "LINK", "RECO", "NEW", "OLD", "HS", "BTP", "IS",
    "ADS", "USB", "HDMI", "VGA", "DP", "SFR", "WIFI", "STOCK", "TEST", "FIXE",
    "PORTABLE", "ECRAN", "ÉCRAN", "CASQUE", "SOURIS", "CLAVIER", "CABLE", "CÂBLE",
    "CARTOUCHE", "CHARGEUR", "ROUTEUR", "SWITCH", "BORNE", "SCAN", "SCANNER",
    "TABLETTE", "ALIM", "DOCK", "STATION", "VIDEOPRO", "LENOVO", "ASUS", "DELL", "HP",
    "CANON", "RICOH", "LOGITECH", "JABRA", "NON", "SECU", "SÉCU", "X2", "X3", "X4",
    # Mots-outils / statuts pouvant ressembler à un nom mais n'en étant pas
    "SAV", "TAG", "OK", "STAGIAIRE", "ADV", "PRO", "RDC",
    # Faux positifs ponctuels identifiés en revue manuelle (lieux confondus avec des noms)
    "VENDARGUE",
}


def looks_like_name_word(word: str) -> bool:
    core = re.sub(r"[^\wÀ-ÿ-]", "", word)
    if len(core) < 2:
        return False
    if core.upper() in NON_NAME_WORDS:
        return False
    return core[0].isupper()


def extract_pour_pattern(material: str, known_places: set, known_place_tokens: set):
    m = re.search(r"\bpour\s+([A-ZÀ-Ÿ][\wÀ-ÿ'-]*(?:\s+[A-ZÀ-Ÿ][\wÀ-ÿ'-]*){0,2})\s*$", material)
    if not m:
        return None
    name = m.group(1).strip()
    words = name.split()
    if not all(looks_like_name_word(w) for w in words):
        return None
    # Exclut les faux positifs géographiques : "pour Serris" (Serris = fragment d'agence)
    if name.strip().lower() in known_places:
        return None
    if any(w.lower() in known_place_tokens for w in words):
        return None
    remainder = material[: m.start()].strip()
    remainder = re.sub(r"\bpour\s*$", "", remainder, flags=re.I).strip()
    return name, remainder


def extract_dash_pattern(material: str):
    # Le dernier segment après un " - " isolé, s'il ressemble à un nom (1 à 3 mots)
    parts = material.rsplit(" - ", 1)
    if len(parts) != 2:
        return None
    remainder, candidate = parts
    candidate = candidate.strip()
    words = candidate.split()
    if not (1 <= len(words) <= 3):
        return None
    if not all(looks_like_name_word(w) for w in words):
        return None
    # Doit contenir au moins un mot TOUT EN MAJUSCULES (signal nom de famille)
    if not any(w.isupper() and len(w) > 1 for w in words):
        return None
    return candidate, remainder.strip()


def extract_trailing_caps_name(material: str):
    # "<...> NOM Prénom" ou "<...> Prénom NOM" en toute fin de chaîne, sans séparateur dédié
    m = re.search(
        r"(?:^|\s)((?:[A-ZÀ-Ÿ]{2,}(?:-[A-ZÀ-Ÿ]{2,})?)\s+[A-ZÀ-Ÿ][a-zà-ÿ]+|[A-ZÀ-Ÿ][a-zà-ÿ]+\s+(?:[A-ZÀ-Ÿ]{2,}(?:-[A-ZÀ-Ÿ]{2,})?))\s*$",
        material,
    )
    if not m:
        return None
    name = m.group(1).strip()
    words = name.split()
    if any(w.upper() in NON_NAME_WORDS for w in words):
        return None
    remainder = material[: m.start()].strip()
    remainder = re.sub(r"[-|:]\s*$", "", remainder).strip()
    remainder = re.sub(r"\bpour\s*$", "", remainder, flags=re.I).strip()
    return name, remainder


def main():
    dry_run = "--dry-run" in sys.argv

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    rows = cur.execute(
        "SELECT id, material, recipient FROM shipments WHERE recipient IS NULL OR recipient = ''"
    ).fetchall()

    known_places = {
        s.strip().lower()
        for (s,) in cur.execute("SELECT DISTINCT supplier FROM shipments").fetchall()
    }
    # Ajoute aussi les tokens individuels des noms d'agence (ex: "Serris" dans "IS Fm Serris")
    # pour exclure les faux positifs "pour <lieu>" détectés comme noms de personne.
    known_place_tokens = set()
    for place in known_places:
        for token in re.findall(r"[a-zà-ÿ'-]+", place):
            if len(token) >= 4:  # évite les faux exclus type "de", "st", "is"
                known_place_tokens.add(token)

    extractions = []  # (id, name, new_material, pattern_label)
    skipped_low_confidence = []

    for row_id, material, _ in rows:
        result = extract_pour_pattern(material, known_places, known_place_tokens)
        label = "pour"
        if not result:
            result = extract_dash_pattern(material)
            label = "dash"
        if not result:
            result = extract_trailing_caps_name(material)
            label = "trailing_caps"

        if result:
            name, remainder = result
            if len(remainder) < 2:
                # Le matériel deviendrait vide/trop court : trop risqué, on laisse tel quel
                skipped_low_confidence.append((row_id, material, "remainder_too_short"))
                continue
            extractions.append((row_id, name, remainder, label))

    print(f"Lignes sans destinataire déjà renseigné : {len(rows)}")
    print(f"Extractions à haute confiance : {len(extractions)}")
    print(f"  dont pattern 'pour X' : {sum(1 for e in extractions if e[3] == 'pour')}")
    print(f"  dont pattern '- X' en fin : {sum(1 for e in extractions if e[3] == 'dash')}")
    print(f"  dont pattern nom en fin (MAJ+Titlecase) : {sum(1 for e in extractions if e[3] == 'trailing_caps')}")
    print(f"Ignorées (matériel deviendrait vide) : {len(skipped_low_confidence)}")

    if dry_run:
        print("\n--- DRY RUN : aucun changement appliqué ---")
        print("\nExemples d'extractions :")
        for row_id, name, remainder, label in extractions[:30]:
            print(f"  [{label}] material={remainder!r:60} recipient={name!r}")
        return

    for row_id, name, remainder, _ in extractions:
        cur.execute(
            "UPDATE shipments SET recipient = ?, material = ? WHERE id = ?",
            (name, remainder, row_id),
        )
    conn.commit()

    total_recipients = cur.execute(
        "SELECT COUNT(*) FROM shipments WHERE recipient IS NOT NULL AND recipient != ''"
    ).fetchone()[0]
    print(f"\nLignes mises à jour : {len(extractions)}")
    print(f"Total avec destinataire renseigné : {total_recipients}")


if __name__ == "__main__":
    main()

"""Nettoyage des données ShipTrack : uniformise agences/fournisseurs (Title Case),
fusionne les doublons de matériel par casse, et supprime les espaces parasites.

Usage: python scripts/clean_data.py [--dry-run]
"""
import re
import sqlite3
import sys
import unicodedata

DB_PATH = (
    r"C:\Users\robin.diberardini\AppData\Local\com.robindiberardini.shiptrack\shiptrack.sqlite3"
)

# Mots qui doivent rester en minuscule/majuscule spécifique en Title Case français
LOWERCASE_WORDS = {"de", "du", "des", "la", "le", "les", "et", "sur", "en", "pour", "d'", "l'"}
UPPERCASE_EXCEPTIONS = {"IS", "BTP", "ADS", "PC", "TEL", "SFR", "TP", "HUB"}


def clean_whitespace(s: str) -> str:
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    s = s.replace("_x000D_", "")  # artefact Excel rencontré dans les données sources
    return s


def norm_key(s: str) -> str:
    s = clean_whitespace(s)
    nfkd = unicodedata.normalize("NFD", s)
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    no_accents = no_accents.lower()
    no_accents = re.sub(r"[^\w\s]", "", no_accents)  # ignore la ponctuation (parenthèses, tirets, points...)
    no_accents = re.sub(r"\s+", " ", no_accents).strip()
    return no_accents


def title_case_fr(s: str) -> str:
    s = clean_whitespace(s)
    words = s.split(" ")
    out = []
    for i, w in enumerate(words):
        if not w:
            continue
        upper_w = w.upper()
        if upper_w in UPPERCASE_EXCEPTIONS:
            out.append(upper_w)
        elif w.lower() in LOWERCASE_WORDS and i != 0:
            out.append(w.lower())
        else:
            # gère les mots avec tiret : "saint-jean" -> "Saint-Jean"
            parts = w.split("-")
            out.append("-".join(p[:1].upper() + p[1:].lower() if p else p for p in parts))
    return " ".join(out)


def main():
    dry_run = "--dry-run" in sys.argv

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # --- 1. Nettoyage supplier (agence) : Title Case + fusion par clé normalisée ---
    rows = cur.execute("SELECT DISTINCT supplier FROM shipments").fetchall()
    supplier_map = {}
    for (raw,) in rows:
        canonical = title_case_fr(raw)
        if canonical != raw:
            supplier_map[raw] = canonical

    # --- 2. Nettoyage material : whitespace only (texte libre, pas de Title Case) ---
    rows = cur.execute("SELECT DISTINCT material FROM shipments").fetchall()
    material_map = {}
    for (raw,) in rows:
        cleaned = clean_whitespace(raw)
        if cleaned != raw:
            material_map[raw] = cleaned

    # --- 3. Fusion des doublons de matériel par casse (garder la variante la plus fréquente) ---
    rows = cur.execute("SELECT material, COUNT(*) as n FROM shipments GROUP BY material").fetchall()
    groups = {}
    for mat, n in rows:
        cleaned = material_map.get(mat, mat)
        key = norm_key(cleaned)
        groups.setdefault(key, []).append((cleaned, n, mat))

    material_merge_map = {}  # raw_original -> canonical
    merge_group_count = 0
    for key, variants in groups.items():
        if len(variants) <= 1:
            continue
        merge_group_count += 1

        def quality_score(v):
            text, n, _ = v
            has_accents = any(unicodedata.combining(unicodedata.normalize("NFD", ch)[-1:] or " ") for ch in text)
            # Pénalise le TOUT MAJUSCULE et le tout-minuscule-sans-espace-initial-capitalisé,
            # favorise les accents corrects et la fréquence en dernier recours.
            all_upper_penalty = 1 if text.isupper() and len(text) > 3 else 0
            weird_case_penalty = sum(1 for i, c in enumerate(text) if c.isupper() and i > 0 and text[i - 1].isalpha() and text[i - 1].islower())
            return (has_accents, -all_upper_penalty, -weird_case_penalty, n)

        variants.sort(key=quality_score, reverse=True)
        canonical = variants[0][0]
        for _, _, raw_original in variants:
            material_merge_map[raw_original] = canonical

    print(f"Agences à renommer (Title Case) : {len(supplier_map)}")
    print(f"Matériaux avec espaces à nettoyer : {len(material_map)}")
    print(f"Groupes de matériaux fusionnés par casse : {merge_group_count} ({len(material_merge_map)} lignes affectées)")

    if dry_run:
        print("\n--- DRY RUN : aucun changement appliqué ---")
        print("\nExemples agences :")
        for raw, canon in list(supplier_map.items())[:10]:
            print(f"  {raw!r} -> {canon!r}")
        print("\nExemples fusions matériel :")
        for raw, canon in list(material_merge_map.items())[:10]:
            print(f"  {raw!r} -> {canon!r}")
        return

    # --- Application ---
    updated_supplier = 0
    for raw, canonical in supplier_map.items():
        cur.execute("UPDATE shipments SET supplier = ? WHERE supplier = ?", (canonical, raw))
        updated_supplier += cur.rowcount

    # Fusionne d'abord les doublons de casse/ponctuation, puis applique le nettoyage
    # d'espaces restant (ex: tabulations internes) sur toutes les valeurs concernées.
    final_material_map = dict(material_map)
    final_material_map.update(material_merge_map)

    updated_material = 0
    for raw, canonical in final_material_map.items():
        cur.execute("UPDATE shipments SET material = ? WHERE material = ?", (canonical, raw))
        updated_material += cur.rowcount

    conn.commit()

    final_suppliers = cur.execute("SELECT COUNT(DISTINCT supplier) FROM shipments").fetchone()[0]
    final_materials = cur.execute("SELECT COUNT(DISTINCT material) FROM shipments").fetchone()[0]

    print(f"\nLignes mises à jour (agence) : {updated_supplier}")
    print(f"Lignes mises à jour (matériel) : {updated_material}")
    print(f"Agences distinctes après nettoyage : {final_suppliers}")
    print(f"Matériaux distincts après nettoyage : {final_materials}")


if __name__ == "__main__":
    main()

"""Audit des doublons d'agence (colonne `supplier`) dans la DB ShipTrack.

Détecte les groupes de valeurs proches par :
1. Normalisation stricte (accents, casse, espaces) -> doublons quasi-certains
2. Similarité floue (difflib) sur les valeurs normalisées -> candidats à revue manuelle

N'écrit rien en base par défaut (--dry-run implicite). Avec --apply, fusionne
chaque groupe de doublons EXACTS (après normalisation) vers la forme la plus
fréquente (ou la plus longue en cas d'égalité), jamais les candidats flous.
"""
import argparse
import difflib
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict

DB_PATH = r"C:\Users\robin.diberardini\AppData\Local\com.robindiberardini.shiptrack\shiptrack.sqlite3"


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def normalize_strict(s):
    """Normalisation pour détecter les doublons EXACTS (accents/casse/espaces)."""
    s = strip_accents(s).lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Applique la fusion des doublons exacts en base")
    parser.add_argument("--fuzzy-threshold", type=float, default=0.88)
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT supplier, COUNT(*) FROM shipments GROUP BY supplier ORDER BY supplier")
    rows = cur.fetchall()
    values = [r[0] for r in rows]
    counts = {r[0]: r[1] for r in rows}

    # --- 1. Doublons EXACTS après normalisation stricte ---
    groups = defaultdict(list)
    for v in values:
        groups[normalize_strict(v)].append(v)

    exact_dupe_groups = {k: v for k, v in groups.items() if len(v) > 1}

    print(f"=== {len(values)} valeurs distinctes en base ===\n")
    print(f"=== Doublons EXACTS (accents/casse/espaces) : {len(exact_dupe_groups)} groupes ===")
    merge_plan = {}  # variante -> forme canonique choisie
    for key, variants in exact_dupe_groups.items():
        # Forme canonique : la plus fréquente, puis la plus longue en cas d'égalité.
        canonical = max(variants, key=lambda v: (counts[v], len(v)))
        print(f"  -> '{canonical}' (garde) <- {[v for v in variants if v != canonical]} (compte: {[counts[v] for v in variants]})")
        for v in variants:
            if v != canonical:
                merge_plan[v] = canonical

    # --- 2. Candidats flous (similarité, à revue manuelle uniquement) ---
    print(f"\n=== Candidats de similarité floue (seuil {args.fuzzy_threshold}) — REVUE MANUELLE, non fusionnés automatiquement ===")
    normalized_unique = sorted(set(normalize_strict(v) for v in values))
    reported_pairs = set()
    fuzzy_count = 0
    for i, a in enumerate(normalized_unique):
        for b in normalized_unique[i + 1:]:
            ratio = difflib.SequenceMatcher(None, a, b).ratio()
            if ratio >= args.fuzzy_threshold:
                pair = tuple(sorted([a, b]))
                if pair in reported_pairs:
                    continue
                reported_pairs.add(pair)
                orig_a = [v for v in values if normalize_strict(v) == a]
                orig_b = [v for v in values if normalize_strict(v) == b]
                print(f"  {ratio:.2f}  '{orig_a[0]}' ({counts[orig_a[0]]}) <-> '{orig_b[0]}' ({counts[orig_b[0]]})")
                fuzzy_count += 1
    if fuzzy_count == 0:
        print("  (aucun)")

    if not args.apply:
        print(f"\n--dry-run (défaut) : {len(merge_plan)} lignes de valeurs à fusionner, rien appliqué.")
        print("Relancer avec --apply pour fusionner les doublons EXACTS uniquement.")
        return

    if not merge_plan:
        print("\nRien à fusionner (aucun doublon exact).")
        return

    print(f"\n=== APPLICATION : fusion de {len(merge_plan)} valeurs ===")
    for old_val, new_val in merge_plan.items():
        cur.execute("UPDATE shipments SET supplier = ? WHERE supplier = ?", (new_val, old_val))
        print(f"  '{old_val}' -> '{new_val}' : {cur.rowcount} lignes")
    conn.commit()

    cur.execute("SELECT COUNT(*), COUNT(DISTINCT supplier) FROM shipments")
    total, distinct = cur.fetchone()
    print(f"\nAprès fusion : {total} lignes, {distinct} agences distinctes.")
    conn.close()


if __name__ == "__main__":
    main()

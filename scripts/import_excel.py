"""Import the legacy 'Suivi Expéditions.xlsx' (sheet '2026') into ShipTrack's SQLite DB.

Mapping (per user decisions):
- DATE                              -> expected_date
- AGENCE                            -> supplier (site/agence destinataire)
- Expéditeur (technicien)           -> notes: "Traité par: <nom>"
- Type (envoi / ramasse N)          -> status: 'envoi' contains -> shipped, 'ramasse' contains -> ordered, else ordered
- N° Suivi / Commentaire            -> tracking_number
- Matériel envoyé                   -> material
- Vérification / Date réception     -> appended to notes
"""
import datetime
import re
import sqlite3
import sys
import uuid

import openpyxl

XLSX_PATH = "Suivi Expéditions.xlsx"
SHEET = "2026"
DB_PATH = (
    r"C:\Users\robin.diberardini\AppData\Local\com.robindiberardini.shiptrack\shiptrack.sqlite3"
)

DATE_RE = re.compile(r"^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s*$")


def parse_date(value):
    """Return an ISO date string (YYYY-MM-DD) or None."""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, str):
        m = DATE_RE.match(value)
        if m:
            d, mo, y = m.groups()
            d, mo = int(d), int(mo)
            y = int(y)
            if y < 100:
                y += 2000
            # Fix obvious typo years like "206" -> "2026" captured by 2-digit group already handled;
            # but "28/01/206" has a 3-digit year group -> handle separately.
            if len(y_str := str(y)) == 3:
                y = int("2" + y_str[1:])
            try:
                return datetime.date(y, mo, d).isoformat()
            except ValueError:
                return None
        return None
    return None


def status_from_type(type_val):
    if not type_val:
        return "ordered"
    t = str(type_val).strip().lower()
    if "envoi" in t:
        return "shipped"
    if "ramasse" in t:
        return "ordered"
    return "ordered"


def clean(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return str(v).strip() or None


def main():
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
    ws = wb[SHEET]

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")

    inserted = 0
    skipped = 0

    with conn:
        for r in range(2, ws.max_row + 1):
            date_raw = ws.cell(r, 1).value
            agence = clean(ws.cell(r, 2).value)
            technicien = clean(ws.cell(r, 3).value)
            type_val = clean(ws.cell(r, 4).value)
            tracking = clean(ws.cell(r, 5).value)
            material = clean(ws.cell(r, 6).value)
            verif = clean(ws.cell(r, 7).value)

            if not agence and not material:
                skipped += 1
                continue

            expected_date = parse_date(date_raw)

            notes_parts = []
            if technicien:
                notes_parts.append(f"Traité par: {technicien}")
            if verif:
                notes_parts.append(verif)
            notes = " | ".join(notes_parts) if notes_parts else None

            conn.execute(
                """INSERT INTO shipments
                   (id, supplier, tracking_number, carrier, recipient, material, status,
                    expected_date, received_date, notes)
                   VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)""",
                (
                    str(uuid.uuid4()),
                    agence or "(agence non renseignée)",
                    tracking,
                    material or "(matériel non renseigné)",
                    status_from_type(type_val),
                    expected_date,
                    notes,
                ),
            )
            inserted += 1

    print(f"Inserted: {inserted}, Skipped (empty rows): {skipped}, Total scanned rows: {ws.max_row - 1}")


if __name__ == "__main__":
    sys.exit(main())

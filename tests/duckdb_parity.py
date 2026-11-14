"""Runs every SQL query from tests/out/queries.json in DuckDB and compares with the engine's rows.

    node tests/parity.js && python3 tests/duckdb_parity.py
"""
import datetime
import json
import math
import pathlib
import re
import sys

import duckdb

OUT = pathlib.Path(__file__).parent / "out"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def to_ms(v):
    if isinstance(v, datetime.datetime):
        return int(v.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    if isinstance(v, datetime.date):
        return int(datetime.datetime(v.year, v.month, v.day, tzinfo=datetime.timezone.utc).timestamp() * 1000)
    return v


def same(db, eng):
    db = to_ms(db)
    if isinstance(eng, str) and isinstance(db, int) and not isinstance(db, bool):
        if eng in MONTHS:
            eng = MONTHS.index(eng) + 1
        elif eng in DOW:
            eng = DOW.index(eng) + 1
    if db is None or eng is None:
        return db is None and eng is None
    if isinstance(db, bool) or isinstance(eng, bool):
        return str(db).lower() == str(eng).lower()
    if isinstance(db, (int, float)) and isinstance(eng, (int, float)):
        return math.isclose(float(db), float(eng), rel_tol=1e-9, abs_tol=1e-6)
    return str(db) == str(eng)


def main():
    con = duckdb.connect()
    queries = json.loads((OUT / "queries.json").read_text())
    loaded = set()
    bad = 0
    for q in queries:
        if q.get("error") or not q.get("sql"):
            print("SKIP", q["name"], q.get("error", ""))
            bad += 1
            continue
        for m in re.finditer(r'CREATE TABLE "([^"]+)" AS SELECT \* FROM read_csv\(\'([^\']+)\'\)', q["sql"]):
            table, file = m.group(1), m.group(2)
            if table not in loaded:
                con.execute(f'CREATE TABLE "{table}" AS SELECT * FROM read_csv(\'{OUT / file}\')')
                loaded.add(table)
        sql = "\n".join(l for l in q["sql"].split("\n") if not l.startswith("-- load once"))
        try:
            cur = con.execute(sql)
        except Exception as e:  # noqa: BLE001
            print("BAD ", q["name"], "-> DuckDB error:", str(e).split("\n")[0])
            bad += 1
            continue
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        eng = q["rows"]
        why = ""
        if len(rows) != len(eng):
            why = f"row count {len(rows)} (DuckDB) vs {len(eng)} (engine)"
        else:
            for r, e in zip(rows, eng):
                for c, v in zip(cols, r):
                    if not same(v, e.get(c)):
                        why = f"{c}: DuckDB={v!r} engine={e.get(c)!r} in row {r}"
                        break
                if why:
                    break
        print(("OK   " if not why else "BAD  ") + q["name"] + ("" if not why else "  -> " + why))
        bad += bool(why)
    print(f"{len(queries) - bad} of {len(queries)} queries match DuckDB")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

"""
EnergiaMind — Historical Data Injector

Resets the database and injects ~4.5 days of telemetry data
(June 22 00:00 → June 26 current time) using the simulation.csv test set.

The simulator normally maps days by (date - 1) % 2:
  - Even dates (22, 24, 26) → Day 15 data
  - Odd dates (23, 25) → Day 16 data

Data is inserted at 5-second intervals (matching the Modbus poller rate),
meaning each day produces ~17,280 data points.

Usage: python tools/inject_historical_data.py
"""

import sqlite3
import csv
import os
import sys
import time
from datetime import datetime, timedelta, timezone

# Fix Windows console encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')


# ─── Configuration ──────────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'server', 'data', 'energiamind.db')
CSV_PATH = os.path.join(os.path.dirname(__file__), 'data', 'simulation.csv')

# Timezone: UTC+7 (Vietnam)
TZ_VN = timezone(timedelta(hours=7))

# Inject interval: 5 seconds (matching Modbus poller)
INJECT_INTERVAL_SEC = 5

# Start date: June 22 00:00:00 UTC+7
START_DATE = datetime(2026, 6, 22, 0, 0, 0, tzinfo=TZ_VN)

# End date: right now
END_DATE = datetime.now(TZ_VN)

# ─── Load simulation CSV ────────────────────────────────────────────
def load_simulation_data(csv_path: str):
    """Load simulation.csv and split into Day 15 / Day 16 by boundary index."""
    print(f"📂 Loading simulation data from {csv_path}")
    
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            rows.append({
                'original_index': int(row['original_index']),
                'vdc1': float(row['vdc1']),
                'vdc2': float(row['vdc2']),
                'idc1': float(row['idc1']),
                'idc2': float(row['idc2']),
                'irr': float(row['irr']),
                'pvt': float(row['pvt']),
                'f_nv': int(row['f_nv']),
            })
    
    # Find boundary: original_index >= 1288619 marks Day 16
    boundary = next((i for i, r in enumerate(rows) if r['original_index'] >= 1288619), len(rows) // 2)
    
    day15 = rows[:boundary]
    day16 = rows[boundary:]
    
    print(f"   Total rows: {len(rows):,}")
    print(f"   Day 15: {len(day15):,} rows ({len(day15)/3600:.1f} hrs)")
    print(f"   Day 16: {len(day16):,} rows ({len(day16)/3600:.1f} hrs)")
    
    # Fault distribution
    from collections import Counter
    dist = Counter(r['f_nv'] for r in rows)
    fault_names = {0: 'Normal', 1: 'Short-Circuit', 2: 'Degradation', 3: 'Open-Circuit', 4: 'Shadowing'}
    for label in sorted(dist.keys()):
        pct = dist[label] / len(rows) * 100
        print(f"   {fault_names.get(label, f'Unknown({label})')}: {dist[label]:,} ({pct:.1f}%)")
    
    return day15, day16


def get_reading_for_second(day_data: list, second_of_day: int) -> dict:
    """Map a second-of-day to the closest reading in the day's data."""
    # The dataset has 1-second resolution but we sample every 5s
    # Clamp to available range
    idx = min(second_of_day, len(day_data) - 1)
    idx = max(0, idx)
    return day_data[idx]


# ─── Reset database ─────────────────────────────────────────────────
def reset_database(db_path: str):
    """Delete all telemetry, alerts, tickets, and activity_log data. Keep users and config."""
    print(f"\n🗑️  Resetting database: {db_path}")
    
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = OFF")  # Temporarily disable for cascading deletes
    
    # Order matters for foreign key constraints
    tables_to_clear = [
        'ticket_comments',
        'alerts',
        'tickets',
        'telemetry',
        'activity_log',
    ]
    
    for table in tables_to_clear:
        try:
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            conn.execute(f"DELETE FROM {table}")
            print(f"   Cleared {table}: {count:,} rows deleted")
        except Exception as e:
            print(f"   ⚠️  Could not clear {table}: {e}")
    
    # Reset autoincrement counters
    try:
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('telemetry', 'activity_log')")
        print("   Reset autoincrement counters")
    except:
        pass
    
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    print("   ✅ Database reset complete")


# ─── Inject historical data ─────────────────────────────────────────
def inject_data(db_path: str, day15: list, day16: list, start: datetime, end: datetime):
    """Inject telemetry data from start to end at INJECT_INTERVAL_SEC intervals."""
    
    total_seconds = int((end - start).total_seconds())
    total_points = total_seconds // INJECT_INTERVAL_SEC
    
    print(f"\n📊 Injecting historical data:")
    print(f"   From: {start.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print(f"   To:   {end.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print(f"   Duration: {total_seconds / 3600:.1f} hours ({total_seconds / 86400:.2f} days)")
    print(f"   Interval: {INJECT_INTERVAL_SEC}s")
    print(f"   Expected points: {total_points:,}")
    
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -64000")  # 64MB cache
    
    batch = []
    BATCH_SIZE = 500
    inserted = 0
    fault_count = 0
    
    t0 = time.time()
    current = start
    
    while current <= end:
        # Determine which day's data to use: even date → Day 15, odd → Day 16
        day_of_month = current.day
        if (day_of_month - 1) % 2 == 0:
            day_data = day15  # Even-indexed dates: 22, 24, 26
        else:
            day_data = day16  # Odd-indexed dates: 23, 25
        
        # Get second of day
        second_of_day = current.hour * 3600 + current.minute * 60 + current.second
        
        reading = get_reading_for_second(day_data, second_of_day)
        
        # Compute derived values
        vdc1 = reading['vdc1']
        vdc2 = reading['vdc2']
        idc1 = reading['idc1']
        idc2 = reading['idc2']
        irr = reading['irr']
        pvt = reading['pvt']
        f_nv = reading['f_nv']
        
        pdc1 = round(vdc1 * idc1, 4)
        pdc2 = round(vdc2 * idc2, 4)
        pdc_total = round(pdc1 + pdc2, 4)
        
        # Timestamp as Unix seconds (UTC)
        ts_unix = int(current.timestamp())
        
        batch.append((
            ts_unix,
            vdc1, vdc2, idc1, idc2, irr, pvt,
            pdc1, pdc2, pdc_total,
            f_nv if f_nv > 0 else None,
        ))
        
        if f_nv > 0:
            fault_count += 1
        
        if len(batch) >= BATCH_SIZE:
            conn.executemany(
                """INSERT INTO telemetry 
                   (timestamp, vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdc_total, fault_label)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                batch
            )
            inserted += len(batch)
            batch = []
            
            # Progress every 10,000 rows
            if inserted % 10000 < BATCH_SIZE:
                elapsed = time.time() - t0
                rate = inserted / elapsed if elapsed > 0 else 0
                pct = inserted / total_points * 100 if total_points > 0 else 0
                day_str = current.strftime('%m/%d %H:%M')
                print(f"   [{pct:5.1f}%] {inserted:>8,} rows | {day_str} | {rate:,.0f} rows/s")
        
        current += timedelta(seconds=INJECT_INTERVAL_SEC)
    
    # Flush remaining
    if batch:
        conn.executemany(
            """INSERT INTO telemetry 
               (timestamp, vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdc_total, fault_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            batch
        )
        inserted += len(batch)
    
    conn.commit()
    
    elapsed = time.time() - t0
    print(f"\n   ✅ Injected {inserted:,} telemetry rows in {elapsed:.1f}s ({inserted/elapsed:,.0f} rows/s)")
    print(f"   Fault readings: {fault_count:,} ({fault_count/inserted*100:.1f}%)")
    
    # Verify
    count = conn.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0]
    min_ts = conn.execute("SELECT MIN(timestamp) FROM telemetry").fetchone()[0]
    max_ts = conn.execute("SELECT MAX(timestamp) FROM telemetry").fetchone()[0]
    
    if min_ts and max_ts:
        min_dt = datetime.fromtimestamp(min_ts, tz=TZ_VN)
        max_dt = datetime.fromtimestamp(max_ts, tz=TZ_VN)
        print(f"\n   📈 Database stats:")
        print(f"      Total rows: {count:,}")
        print(f"      Date range: {min_dt.strftime('%Y-%m-%d %H:%M')} → {max_dt.strftime('%Y-%m-%d %H:%M')}")
        print(f"      Duration: {(max_ts - min_ts) / 86400:.2f} days")
    
    conn.close()


# ─── Main ────────────────────────────────────────────────────────────
def main():
    print("""
==================================================
  EnergiaMind — Historical Data Injector
--------------------------------------------------
  Resets DB and injects 4+ days of telemetry
  June 22 → June 26 (current time)
==================================================
""")
    
    # Resolve paths
    db_path = os.path.abspath(DB_PATH)
    csv_path = os.path.abspath(CSV_PATH)
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        sys.exit(1)
    if not os.path.exists(csv_path):
        print(f"❌ Simulation CSV not found: {csv_path}")
        sys.exit(1)
    
    # Load data
    day15, day16 = load_simulation_data(csv_path)
    
    # Reset DB
    reset_database(db_path)
    
    # Inject historical data
    inject_data(db_path, day15, day16, START_DATE, END_DATE)
    
    print(f"\n🎉 Done! You can now start the server and simulator.")
    print(f"   The simulator will continue adding live data from the current time.")


if __name__ == '__main__':
    main()

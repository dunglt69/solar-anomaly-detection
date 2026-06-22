"""
EnergiaMind — Dataset Preparation v3 (FIXED)

KEY FIXES from v2:
1. DO NOT shuffle rows before creating sliding windows — the dataset is
   time-ordered with contiguous fault blocks (2307 blocks). Shuffling
   destroys temporal patterns that the LSTM needs.
2. DO NOT double-normalize — CSV values are already scaled (vdc1~0.7,
   irr~1.4). Z-score on already-normalized data creates near-zero
   variance features. Use MinMax or just pass raw values.
3. Use BLOCK-AWARE splitting: split by contiguous label blocks, not
   individual rows, to prevent data leakage between train/test windows.
4. Compute power features from the already-normalized V*I values.

Dataset: pv_fault_dataset.csv
Columns: vdc1, vdc2, idc1, idc2, irr, pvt, f_nv
Labels:  0=Normal, 1=Short-Circuit, 2=Degradation, 3=Open Circuit, 4=Shadowing
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from collections import Counter

# ─── Config ──────────────────────────────────────────────────────────
DATASET_PATH = Path(__file__).parent.parent / "pv_fault_dataset-master" / "pv_fault_dataset.csv"
OUTPUT_DIR = Path(__file__).parent / "data"
MODELS_DIR = Path(__file__).parent.parent / "server" / "models"
WINDOW_SIZE = 24
RANDOM_STATE = 42
TRAIN_RATIO = 0.70
VAL_RATIO = 0.10
TEST_RATIO = 0.20  # Test set = simulation data

RAW_COLS = ["vdc1", "vdc2", "idc1", "idc2", "irr", "pvt"]
LABEL_COL = "f_nv"

FAULT_NAMES = {
    0: "Normal",
    1: "Short-Circuit",
    2: "Degradation",
    3: "Open Circuit",
    4: "Shadowing",
}

FEATURE_COLS = RAW_COLS + ["pdc1", "pdc2", "pdc_total",
                          "vdc_ratio", "idc_ratio", "vdc_diff", "idc_diff"]
NUM_FEATURES = len(FEATURE_COLS)  # 13


def load_dataset() -> pd.DataFrame:
    print(f"📂 Loading dataset from {DATASET_PATH}")
    df = pd.read_csv(DATASET_PATH)
    print(f"   Shape: {df.shape}")
    print(f"   Columns: {list(df.columns)}")

    expected = RAW_COLS + [LABEL_COL]
    missing = [c for c in expected if c not in df.columns]
    if missing:
        raise ValueError(f"Missing columns: {missing}")

    nan_count = df[RAW_COLS].isna().sum().sum()
    if nan_count > 0:
        print(f"   ⚠️  Found {nan_count} NaN values, filling with forward fill")
        df[RAW_COLS] = df[RAW_COLS].ffill().fillna(0)

    return df


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute power + ratio features (all 13)."""
    print(f"⚙️  Engineering {NUM_FEATURES} features...")
    df = df.copy()
    # Power features
    df["pdc1"] = df["vdc1"] * df["idc1"]
    df["pdc2"] = df["vdc2"] * df["idc2"]
    df["pdc_total"] = df["pdc1"] + df["pdc2"]
    # Ratio/diff features (critical for 2-string fault detection)
    thresh = 1e-6
    df["vdc_ratio"] = np.where(df["vdc2"] > thresh, df["vdc1"] / df["vdc2"], 1.0)
    df["idc_ratio"] = np.where(df["idc2"] > thresh, df["idc1"] / df["idc2"], 1.0)
    df["vdc_ratio"] = df["vdc_ratio"].clip(0.0, 5.0)
    df["idc_ratio"] = df["idc_ratio"].clip(0.0, 5.0)
    df["vdc_diff"] = (df["vdc1"] - df["vdc2"]).abs()
    df["idc_diff"] = (df["idc1"] - df["idc2"]).abs()
    print(f"   Features: {FEATURE_COLS}")
    
    # Show feature ranges
    print(f"\n   Feature value ranges:")
    for col in FEATURE_COLS:
        print(f"   {col:12s}: min={df[col].min():.4f}  max={df[col].max():.4f}  "
              f"mean={df[col].mean():.4f}  std={df[col].std():.4f}")
    
    return df


def find_contiguous_blocks(labels: np.ndarray) -> list[tuple[int, int, int]]:
    """Find contiguous blocks of same label.
    Returns list of (start_idx, end_idx, label).
    """
    blocks = []
    start = 0
    current_label = labels[0]
    
    for i in range(1, len(labels)):
        if labels[i] != current_label:
            blocks.append((start, i, int(current_label)))
            start = i
            current_label = labels[i]
    blocks.append((start, len(labels), int(current_label)))
    
    return blocks


def split_blocks_stratified(blocks: list[tuple[int, int, int]], 
                            test_ratio: float = 0.10,
                            random_state: int = 42) -> tuple[list, list]:
    """Split blocks into train/test while maintaining stratification.
    
    For each class, randomly select ~test_ratio of blocks for test.
    This prevents data leakage since entire contiguous sequences go
    to one set.
    """
    rng = np.random.RandomState(random_state)
    
    # Group blocks by label
    blocks_by_class: dict[int, list] = {}
    for block in blocks:
        label = block[2]
        if label not in blocks_by_class:
            blocks_by_class[label] = []
        blocks_by_class[label].append(block)
    
    train_blocks = []
    test_blocks = []
    
    for label in sorted(blocks_by_class.keys()):
        class_blocks = blocks_by_class[label]
        rng.shuffle(class_blocks)
        
        # Calculate split point by total rows, not block count
        total_rows = sum(b[1] - b[0] for b in class_blocks)
        target_test_rows = int(total_rows * test_ratio)
        
        test_rows = 0
        split_idx = 0
        for i, block in enumerate(class_blocks):
            block_size = block[1] - block[0]
            if test_rows + block_size <= target_test_rows * 1.5:  # Allow some slack
                test_rows += block_size
                split_idx = i + 1
            else:
                break
        
        test_blocks.extend(class_blocks[:split_idx])
        train_blocks.extend(class_blocks[split_idx:])
    
    return train_blocks, test_blocks


def blocks_to_windows(features: np.ndarray, labels: np.ndarray, 
                      blocks: list[tuple[int, int, int]], 
                      window_size: int) -> tuple[np.ndarray, np.ndarray]:
    """Create sliding windows WITHIN each block to avoid cross-boundary contamination.
    
    For each contiguous block, we create windows only within that block.
    The label for each window is the label of the LAST timestep.
    """
    X_list, y_list = [], []
    
    for start, end, label in blocks:
        block_len = end - start
        if block_len < window_size:
            continue  # Skip blocks smaller than window
        
        block_features = features[start:end]
        block_labels = labels[start:end]
        
        for i in range(window_size, block_len):
            X_list.append(block_features[i - window_size:i])
            y_list.append(block_labels[i])
    
    return np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.int64)


def print_distribution(name: str, labels):
    unique, counts = np.unique(labels, return_counts=True)
    total = len(labels)
    for u, c in zip(unique, counts):
        pct = c / total * 100
        print(f"   {FAULT_NAMES.get(int(u), '?'):15s}: {c:>10,} ({pct:5.2f}%)")


def main():
    df = load_dataset()

    print("\n📊 Full dataset distribution:")
    print_distribution("Full", df[LABEL_COL].values)

    # ── Feature engineering ──────────────────────────────────────────
    df = engineer_features(df)

    # ── Detect day boundaries programmatically via night midpoints ───
    labels_all = df[LABEL_COL].values
    vdc1_vals = df['vdc1'].values
    irr_vals = df['irr'].values
    is_night = ((vdc1_vals < 10) & (irr_vals < 10)).astype(int)
    diff = np.diff(is_night)
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1
    if is_night[0] == 1:
        starts = np.insert(starts, 0, 0)
    if is_night[-1] == 1:
        ends = np.append(ends, len(is_night))

    main_nights = []
    for start, end in zip(starts, ends):
        if end - start > 7200:
            main_nights.append((start, end))

    midpoints = [int((s + e) / 2) for s, e in main_nights]
    day_boundaries = [0] + midpoints + [len(df)]
    print(f"\n🌅 Detected {len(day_boundaries) - 1} programmatic day segments.")

    # Train: Days 1 to 12 of full days (boundaries 1 to 13)
    # Val:   Days 13 to 14 of full days (boundaries 13 to 15)
    # Test:  Days 15 to 16 of full days (boundaries 15 to 17)
    train_blocks = [(day_boundaries[d], day_boundaries[d+1], -1) for d in range(1, 13)]
    val_blocks   = [(day_boundaries[d], day_boundaries[d+1], -1) for d in range(13, 15)]
    test_blocks  = [(day_boundaries[d], day_boundaries[d+1], -1) for d in range(15, 17)]

    print(f"   Train days: 12 days ({len(train_blocks)} blocks)")
    print(f"   Val days:   2 days ({len(val_blocks)} blocks)")
    print(f"   Test days:  2 days ({len(test_blocks)} blocks)")


    # ── Save test set as simulation.csv (raw data for simulator) ──────
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    test_indices = []
    for start, end, _ in test_blocks:
        test_indices.extend(range(start, end))
    test_df = df.iloc[test_indices].copy()
    test_df["original_index"] = test_df.index
    sim_path = OUTPUT_DIR / "simulation.csv"
    sim_cols = ["original_index"] + RAW_COLS + [LABEL_COL]
    test_df[sim_cols].to_csv(sim_path, index=False)
    print(f"\n   Simulation CSV (= test set): {len(test_df):,} rows → {sim_path}")
    print(f"   Duration at 1Hz: {len(test_df)/3600:.1f}h = {len(test_df)/86400:.1f} days")
    print("   Simulation distribution:")
    print_distribution("Sim", test_df[LABEL_COL].values)

    # ── Compute scaler on TRAINING data only ─────────────────────────
    train_indices = []
    for start, end, _ in train_blocks:
        train_indices.extend(range(start, end))
    train_df = df.iloc[train_indices]
    
    # MinMax normalization based on training data
    print("\n📊 Computing scaler parameters on training data...")
    scaler = {}
    for col in FEATURE_COLS:
        col_min = float(train_df[col].min())
        col_max = float(train_df[col].max())
        col_range = col_max - col_min
        if col_range < 1e-8:
            col_range = 1.0  # Avoid division by zero
        scaler[col] = {"min": col_min, "max": col_max, "range": col_range}
        print(f"   {col:12s}: min={col_min:.6f}  max={col_max:.6f}  range={col_range:.6f}")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    scaler_path = MODELS_DIR / "scaler_params.json"
    with open(scaler_path, "w") as f:
        json.dump({
            "features": FEATURE_COLS,
            "params": scaler,
            "scaler_type": "minmax",
            "window_size": WINDOW_SIZE,
            "num_classes": 5,
            "num_features": NUM_FEATURES,
            "class_names": {str(k): v for k, v in FAULT_NAMES.items()},
        }, f, indent=2)
    print(f"   Saved scaler → {scaler_path}")

    # ── Normalize features using MinMax [0, 1] ──────────────────────
    features_all = df[FEATURE_COLS].values.astype(np.float32)
    for i, col in enumerate(FEATURE_COLS):
        features_all[:, i] = (features_all[:, i] - scaler[col]["min"]) / scaler[col]["range"]

    # ── Create windows from blocks ───────────────────────────────────
    print(f"\n🔄 Creating sliding windows (size={WINDOW_SIZE})...")

    X_train, y_train = blocks_to_windows(features_all, labels_all, train_blocks, WINDOW_SIZE)
    X_val, y_val = blocks_to_windows(features_all, labels_all, val_blocks, WINDOW_SIZE)
    X_test, y_test = blocks_to_windows(features_all, labels_all, test_blocks, WINDOW_SIZE)

    print(f"\n   Train: {X_train.shape} ({len(y_train):,} windows)")
    print(f"   Val:   {X_val.shape} ({len(y_val):,} windows)")
    print(f"   Test:  {X_test.shape} ({len(y_test):,} windows)")

    print("\n   Train distribution:")
    print_distribution("Train", y_train)
    print("   Val distribution:")
    print_distribution("Val", y_val)
    print("   Test distribution:")
    print_distribution("Test", y_test)

    # ── Verify all faults present ────────────────────────────────────
    for name, labels in [("Train", y_train), ("Val", y_val), ("Test", y_test)]:
        present = set(np.unique(labels).astype(int))
        missing = [FAULT_NAMES[k] for k in range(5) if k not in present]
        if missing:
            print(f"   ⚠️  {name} MISSING faults: {', '.join(missing)}")
        else:
            print(f"   ✅ {name}: all 5 fault types present")

    # ── Save ─────────────────────────────────────────────────────────
    np.savez_compressed(OUTPUT_DIR / "train.npz", X=X_train, y=y_train)
    np.savez_compressed(OUTPUT_DIR / "val.npz", X=X_val, y=y_val)
    np.savez_compressed(OUTPUT_DIR / "test.npz", X=X_test, y=y_test)

    print(f"\n✅ Dataset preparation complete!")
    print(f"   Split: {TRAIN_RATIO:.0%} train / {VAL_RATIO:.0%} val / {TEST_RATIO:.0%} test")
    print(f"   Test set = Simulation data (simulation.csv)")
    print(f"   Features: {NUM_FEATURES}")
    print(f"   Window: {WINDOW_SIZE}")
    print(f"   Scaler: MinMax [0,1]")
    print(f"   Output: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()


import pandas as pd
import numpy as np

df = pd.read_csv('g:/Solar/pv_fault_dataset-master/pv_fault_dataset.csv')
print('Shape:', df.shape)
print()
print('=== DESCRIBE ===')
print(df.describe().to_string())
print()
print('=== FAULT DISTRIBUTION ===')
NAMES = {0: 'Normal', 1: 'Short-Circuit', 2: 'Degradation', 3: 'Open Circuit', 4: 'Shadowing'}
vc = df['f_nv'].value_counts().sort_index()
for v, c in vc.items():
    name = NAMES.get(int(v), '?')
    pct = c / len(df) * 100
    print(f'  {v}: {name:15s}  {c:>10,} ({pct:.2f}%)')
print()
print('=== PER-FAULT MEANS ===')
for f in sorted(df['f_nv'].unique()):
    sub = df[df['f_nv'] == f]
    print(f'  f_nv={int(f)} ({NAMES.get(int(f), "?")}):')
    for col in ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt']:
        print(f'    {col}: mean={sub[col].mean():.4f}, std={sub[col].std():.4f}, min={sub[col].min():.4f}, max={sub[col].max():.4f}')
print()
print('=== CORRELATION MATRIX ===')
print(df.corr().to_string())
print()
print('=== DATA QUALITY ===')
print(f'NaN count: {df.isna().sum().to_dict()}')
print(f'Inf count: {np.isinf(df.select_dtypes(include=[np.number])).sum().to_dict()}')
print()
print('=== TEMPORAL ANALYSIS ===')
# Check where each fault class appears in the data (row index ranges)
for f in sorted(df['f_nv'].unique()):
    idx = df[df['f_nv'] == f].index
    print(f'  f_nv={int(f)} ({NAMES.get(int(f), "?")}): rows {idx.min():,} - {idx.max():,} (total: {len(idx):,})')

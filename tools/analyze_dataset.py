"""
EnergiaMind Phase R1: Dataset Deep-Dive Analysis
Comprehensive statistical profiling of the PV Fault Detection Dataset
"""
import pandas as pd
import numpy as np

# Load dataset
print("Loading dataset...")
df = pd.read_csv('pv_fault_dataset-master/pv_fault_dataset.csv')

print('='*70)
print('SECTION 1: BASIC SHAPE & STRUCTURE')
print('='*70)
print(f'Shape: {df.shape}')
print(f'Columns: {list(df.columns)}')
print(f'Data types:')
print(df.dtypes)
print(f'\nMemory usage: {df.memory_usage(deep=True).sum() / 1e6:.2f} MB')

print('\n' + '='*70)
print('SECTION 2: NULL / MISSING VALUES')
print('='*70)
print(df.isnull().sum())
print(f'\nTotal nulls: {df.isnull().sum().sum()}')

print('\n' + '='*70)
print('SECTION 3: DESCRIPTIVE STATISTICS')
print('='*70)
print(df.describe().to_string())

print('\n' + '='*70)
print('SECTION 4: FAULT CLASS DISTRIBUTION')
print('='*70)
fault_names = {0: 'Normal', 1: 'Short-Circuit', 2: 'Degradation', 3: 'Open Circuit', 4: 'Shadowing'}
counts = df['f_nv'].value_counts().sort_index()
pcts = df['f_nv'].value_counts(normalize=True).sort_index() * 100
for label in counts.index:
    name = fault_names.get(int(label), 'Unknown')
    print(f'Class {int(label)} ({name:>14s}): {counts[label]:>10,} samples ({pcts[label]:>6.2f}%)')
print(f'{"Total":>26s}: {len(df):>10,}')

print('\n' + '='*70)
print('SECTION 5: PER-CLASS STATISTICS (MEANS)')
print('='*70)
class_means = df.groupby('f_nv').mean()
print(class_means.to_string())

print('\n' + '='*70)
print('SECTION 6: PER-CLASS STATISTICS (STD)')
print('='*70)
class_stds = df.groupby('f_nv').std()
print(class_stds.to_string())

print('\n' + '='*70)
print('SECTION 7: VALUE RANGES PER VARIABLE')
print('='*70)
for col in df.columns:
    if col != 'f_nv':
        print(f'{col}: min={df[col].min():.6f}, max={df[col].max():.6f}, range={df[col].max()-df[col].min():.6f}')

print('\n' + '='*70)
print('SECTION 8: CORRELATION MATRIX')
print('='*70)
corr = df.drop(columns=['f_nv']).corr()
print(corr.round(4).to_string())

print('\n' + '='*70)
print('SECTION 9: FIRST & LAST ROWS')
print('='*70)
print('First 5 rows:')
print(df.head().to_string())
print('\nLast 5 rows:')
print(df.tail().to_string())

print('\n' + '='*70)
print('SECTION 10: UNIQUE VALUES PER COLUMN')
print('='*70)
for col in df.columns:
    print(f'{col}: {df[col].nunique()} unique values')

# Compute derived metrics
df['pdc1'] = df['vdc1'] * df['idc1']
df['pdc2'] = df['vdc2'] * df['idc2']
df['p_total'] = df['pdc1'] + df['pdc2']
df['delta_v'] = (df['vdc1'] - df['vdc2']).abs()
df['delta_i'] = (df['idc1'] - df['idc2']).abs()

print('\n' + '='*70)
print('SECTION 11: DERIVED METRICS STATISTICS')
print('='*70)
derived_cols = ['pdc1', 'pdc2', 'p_total', 'delta_v', 'delta_i']
print(df[derived_cols].describe().to_string())

print('\n' + '='*70)
print('SECTION 12: DERIVED METRICS PER CLASS (MEANS)')
print('='*70)
print(df.groupby('f_nv')[derived_cols].mean().to_string())

print('\n' + '='*70)
print('SECTION 13: ZERO/NEGATIVE VALUE ANALYSIS')
print('='*70)
for col in ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr']:
    neg = (df[col] < 0).sum()
    zero = (df[col] == 0).sum()
    leq = (df[col] <= 0).sum()
    print(f'{col}: negative={neg}, zero={zero}, <=0 total={leq} ({(leq/len(df))*100:.2f}%)')

print('\n' + '='*70)
print('SECTION 14: QUANTILE ANALYSIS')
print('='*70)
for col in ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt']:
    q = df[col].quantile([0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99])
    print(f'{col}: P1={q[0.01]:.2f} P5={q[0.05]:.2f} Q1={q[0.25]:.2f} Med={q[0.50]:.2f} Q3={q[0.75]:.2f} P95={q[0.95]:.2f} P99={q[0.99]:.2f}')

print('\n' + '='*70)
print('SECTION 15: SAMPLING & TEMPORAL ESTIMATION')
print('='*70)
print(f'Total records: {len(df):,}')
print(f'Duration: 16 days')
print(f'Records per day: {len(df)/16:,.0f}')
print(f'Records per hour: {len(df)/(16*24):,.0f}')
est_period = 16*24*3600/len(df)
print(f'Estimated sampling period: {est_period:.4f} seconds')
print(f'Estimated sampling rate: {1/est_period:.2f} Hz')
# From the paper: data collected ~07:30 to 17:00 = 9.5 hours per day
hours_per_day = 9.5
total_seconds = 16 * hours_per_day * 3600
print(f'\nAdjusted (9.5h/day, 07:30-17:00):')
print(f'  Estimated sampling period: {total_seconds/len(df):.4f} seconds')
print(f'  Estimated sampling rate: {len(df)/total_seconds:.2f} Hz')

print('\n' + '='*70)
print('SECTION 16: DISTINGUISHING PATTERNS PER FAULT TYPE')
print('='*70)
normal = df[df['f_nv'] == 0]
for fault_id in [1, 2, 3, 4]:
    fault_data = df[df['f_nv'] == fault_id]
    name = fault_names[fault_id]
    print(f'\n--- Fault {fault_id}: {name} ---')
    for col in ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt', 'pdc1', 'pdc2', 'delta_v', 'delta_i']:
        n_mean = normal[col].mean() if col in normal.columns else 0
        f_mean = fault_data[col].mean() if col in fault_data.columns else 0
        diff_pct = ((f_mean - n_mean) / abs(n_mean) * 100) if abs(n_mean) > 0.001 else float('nan')
        print(f'  {col}: normal_mean={n_mean:.4f}, fault_mean={f_mean:.4f}, diff={diff_pct:+.2f}%')

print('\n' + '='*70)
print('SECTION 17: INTER-STRING MISMATCH ANALYSIS')
print('='*70)
for fault_id in range(5):
    subset = df[df['f_nv'] == fault_id]
    name = fault_names[fault_id]
    dv = subset['delta_v'].mean()
    di = subset['delta_i'].mean()
    print(f'Class {fault_id} ({name:>14s}): mean_delta_v={dv:.4f}V, mean_delta_i={di:.4f}A')

print('\n' + '='*70)
print('SECTION 18: POWER LOSS PER FAULT TYPE')
print('='*70)
normal_power = df[df['f_nv'] == 0]['p_total'].mean()
print(f'Normal mean total power: {normal_power:.2f} W')
for fault_id in [1, 2, 3, 4]:
    fault_power = df[df['f_nv'] == fault_id]['p_total'].mean()
    loss_pct = (1 - fault_power/normal_power) * 100 if normal_power > 0 else 0
    name = fault_names[fault_id]
    print(f'  Fault {fault_id} ({name:>14s}): mean={fault_power:.2f}W, power_loss={loss_pct:.2f}%')

print('\n\n' + '='*70)
print('ANALYSIS COMPLETE')
print('='*70)

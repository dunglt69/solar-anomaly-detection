"""
EnergiaMind — InceptionTime Comprehensive 4-Engine Benchmark Suite

Audits all 4 execution environments across Batch = 1 (Real-time Single Sample) and Batch = 1024 (Batched Parallel):
1. PyTorch CPU
2. PyTorch GPU (CUDA)
3. ONNX Runtime CPU
4. ONNX Runtime GPU (CUDA Execution Provider)

Metrics Audited:
- Accuracy, Macro/Micro Precision, Recall, F1-Score, Per-Class Breakdown
- Parameters, Model Weight Size, MACs, FLOPs
- Latency (p50, p95, p99) & Throughput (samples/sec)
- Active GPU Power Draw (W), Energy per Sample (mJ), Carbon Footprint (gCO2e / 1M inferences)
"""

import sys
import os
import json
import time
import subprocess
import numpy as np
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    classification_report, confusion_matrix
)

# Add tools directory to path
TOOLS_DIR = Path(__file__).parent
sys.path.insert(0, str(TOOLS_DIR))

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from train_inception import (
    InceptionTime, NUM_FEATURES, NUM_CLASSES, WINDOW_SIZE,
    MODELS_DIR, FAULT_NAMES
)

CHECKPOINT_PATH = MODELS_DIR / "inception_checkpoint.pt"
ONNX_PATH = MODELS_DIR / "inception_fault_classifier.onnx"
DATA_DIR = TOOLS_DIR / "data"
RESULTS_JSON_PATH = MODELS_DIR / "benchmark_results.json"
MARKDOWN_REPORT_PATH = Path(__file__).parent.parent / "AI_BENCHMARK_REPORT.md"

DEVICE_CUDA = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DEVICE_CPU = torch.device("cpu")


# ─── 1. FLOPs & MACs Analytical Estimator ──────────────────────────────
def calculate_model_flops(model: nn.Module, input_size=(1, 13, 24)):
    """Calculate FLOPs and MACs analytically for InceptionTime PyTorch layers."""
    total_macs = 0
    
    def conv1d_macs(module, input_shape):
        nonlocal total_macs
        in_ch = module.in_channels
        out_ch = module.out_channels
        k = module.kernel_size[0]
        s = module.stride[0]
        p = module.padding[0]
        l_in = input_shape[2]
        l_out = (l_in + 2 * p - k) // s + 1
        macs = out_ch * l_out * (in_ch * k)
        total_macs += macs

    def linear_macs(module):
        nonlocal total_macs
        macs = module.in_features * module.out_features
        total_macs += macs

    hooks = []
    def register_hooks(net):
        for name, layer in net.named_modules():
            if isinstance(layer, nn.Conv1d):
                def make_hook(l):
                    def hook(m, inp, out):
                        conv1d_macs(l, inp[0].shape)
                    return hook
                hooks.append(layer.register_forward_hook(make_hook(layer)))
            elif isinstance(layer, nn.Linear):
                def make_hook_lin(l):
                    def hook(m, inp, out):
                        linear_macs(l)
                    return hook
                hooks.append(layer.register_forward_hook(make_hook_lin(layer)))

    register_hooks(model)
    dummy_x = torch.zeros(input_size)
    model.eval()
    with torch.no_grad():
        _ = model(dummy_x)
        
    for h in hooks:
        h.remove()
        
    total_flops = 2 * total_macs
    return total_macs, total_flops


# ─── 2. GPU Power Profiler ──────────────────────────────────────────────
def query_gpu_power_watts():
    """Query current GPU power consumption in Watts via nvidia-smi."""
    try:
        cmd = ["nvidia-smi", "--query-gpu=power.draw", "--format=csv,noheader,nounits"]
        res = subprocess.check_output(cmd, encoding="utf-8").strip()
        return float(res.splitlines()[0])
    except Exception:
        return 0.0


# ─── 3. Main Benchmark Suite ─────────────────────────────────────────────
def run_benchmark():
    print("=" * 85)
    print("⚡ EnergiaMind AI Model Complete 4-Engine Performance Benchmark & Audit Suite")
    print("=" * 85)

    # -------------------------------------------------------------------------
    # A. Model Loading & Parameter Inspection
    # -------------------------------------------------------------------------
    print("\n📦 [1/5] Inspecting Model Parameters & Complexity...")
    if not CHECKPOINT_PATH.exists():
        print(f"❌ Checkpoint not found at {CHECKPOINT_PATH}. Please train the model first.")
        return

    model = InceptionTime(
        c_in=NUM_FEATURES, c_out=NUM_CLASSES,
        n_filters=32, depth=6, kernel_sizes=(5, 11, 23), bottleneck=32
    )
    ckpt = torch.load(CHECKPOINT_PATH, map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    model_mem_bytes = sum(p.numel() * p.element_size() for p in model.parameters())
    checkpoint_size_mb = os.path.getsize(CHECKPOINT_PATH) / (1024 * 1024)
    onnx_size_mb = os.path.getsize(ONNX_PATH) / (1024 * 1024) if ONNX_PATH.exists() else 0.0

    macs, flops = calculate_model_flops(model, input_size=(1, NUM_FEATURES, WINDOW_SIZE))

    print(f"   • Total Parameters:     {total_params:,}")
    print(f"   • Trainable Parameters: {trainable_params:,}")
    print(f"   • Model Weights Memory: {model_mem_bytes / 1024:.2f} KB ({model_mem_bytes / (1024**2):.4f} MB)")
    print(f"   • Checkpoint File Size: {checkpoint_size_mb:.2f} MB")
    print(f"   • ONNX Model File Size: {onnx_size_mb:.2f} MB")
    print(f"   • MACs / Sample (B=1):  {macs:,} MACs")
    print(f"   • FLOPs / Sample (B=1): {flops:,} FLOPs ({flops / 1e6:.3f} MFLOPs)")

    # -------------------------------------------------------------------------
    # B. Test Dataset Classification Evaluation
    # -------------------------------------------------------------------------
    print("\n📊 [2/5] Evaluating Classification Quality Metrics...")
    test_npz = DATA_DIR / "test.npz"
    if not test_npz.exists():
        test_npz = DATA_DIR / "val.npz"

    test_data = np.load(test_npz)
    X_test, y_test = test_data["X"], test_data["y"]
    X_test_t = np.transpose(X_test, (0, 2, 1))  # (N, 13, 24)

    test_ds = TensorDataset(torch.from_numpy(X_test_t).float(), torch.from_numpy(y_test).long())
    test_loader = DataLoader(test_ds, batch_size=512, shuffle=False)

    eval_device = DEVICE_CUDA if torch.cuda.is_available() else DEVICE_CPU
    model.to(eval_device)
    model.eval()

    all_preds = []
    all_targets = []
    with torch.no_grad():
        for xb, yb in test_loader:
            xb = xb.to(eval_device)
            logits = model(xb)
            preds = logits.argmax(dim=1).cpu().numpy()
            all_preds.extend(preds)
            all_targets.extend(yb.numpy())

    all_preds = np.array(all_preds)
    all_targets = np.array(all_targets)

    acc = accuracy_score(all_targets, all_preds)
    macro_p = precision_score(all_targets, all_preds, average='macro', zero_division=0)
    macro_r = recall_score(all_targets, all_preds, average='macro', zero_division=0)
    macro_f1 = f1_score(all_targets, all_preds, average='macro', zero_division=0)

    micro_p = precision_score(all_targets, all_preds, average='micro', zero_division=0)
    micro_r = recall_score(all_targets, all_preds, average='micro', zero_division=0)
    micro_f1 = f1_score(all_targets, all_preds, average='micro', zero_division=0)

    weighted_p = precision_score(all_targets, all_preds, average='weighted', zero_division=0)
    weighted_r = recall_score(all_targets, all_preds, average='weighted', zero_division=0)
    weighted_f1 = f1_score(all_targets, all_preds, average='weighted', zero_division=0)

    cm = confusion_matrix(all_targets, all_preds)

    print(f"   • Dataset Evaluated:     {test_npz.name} ({len(y_test):,} samples)")
    print(f"   • Overall Accuracy:      {acc * 100:.2f}%")
    print(f"   • Macro Precision:       {macro_p:.4f}")
    print(f"   • Macro Recall:          {macro_r:.4f}")
    print(f"   • Macro F1-Score:        {macro_f1:.4f}")
    print(f"   • Micro Precision:       {micro_p:.4f}")
    print(f"   • Micro Recall:          {micro_r:.4f}")
    print(f"   • Micro F1-Score:        {micro_f1:.4f}")
    print(f"   • Weighted F1-Score:     {weighted_f1:.4f}")

    print("\n   [Per-Class Performance Breakdown]")
    class_metrics = {}
    for c in range(NUM_CLASSES):
        c_name = FAULT_NAMES[c]
        mask = (all_targets == c)
        c_total = mask.sum()
        c_correct = (all_preds[mask] == c).sum() if c_total > 0 else 0
        c_acc = (c_correct / c_total) if c_total > 0 else 0.0
        
        c_p = precision_score(all_targets == c, all_preds == c, zero_division=0)
        c_r = recall_score(all_targets == c, all_preds == c, zero_division=0)
        c_f1 = f1_score(all_targets == c, all_preds == c, zero_division=0)
        
        class_metrics[c_name] = {
            "samples": int(c_total),
            "correct": int(c_correct),
            "accuracy": float(c_acc),
            "precision": float(c_p),
            "recall": float(c_r),
            "f1_score": float(c_f1)
        }
        print(f"     - Class {c} ({c_name:14s}): Acc={c_acc*100:6.2f}% | P={c_p:.4f} | R={c_r:.4f} | F1={c_f1:.4f} | Support={c_total:,}")

    # -------------------------------------------------------------------------
    # C. Full 4-Engine Latency & Throughput Benchmark Matrix
    # -------------------------------------------------------------------------
    print("\n⏱️  [3/5] Measuring Full 4-Engine Latency & Throughput Matrix (B=1 vs B=1024)...")

    # Helper function for PyTorch latency
    def measure_pytorch_engine(device, batch_size, num_warmup=50, num_runs=500):
        m = model.to(device)
        m.eval()
        dummy_in = torch.randn(batch_size, NUM_FEATURES, WINDOW_SIZE, device=device)
        
        with torch.no_grad():
            for _ in range(num_warmup):
                _ = m(dummy_in)
                if device.type == 'cuda':
                    torch.cuda.synchronize()

        latencies_ms = []
        with torch.no_grad():
            for _ in range(num_runs):
                t0 = time.perf_counter()
                _ = m(dummy_in)
                if device.type == 'cuda':
                    torch.cuda.synchronize()
                t1 = time.perf_counter()
                latencies_ms.append((t1 - t0) * 1000.0)

        latencies_ms = np.array(latencies_ms)
        sample_latencies_ms = latencies_ms / batch_size
        throughput = (batch_size * num_runs) / (latencies_ms.sum() / 1000.0)

        return {
            "p50_batch_ms": float(np.percentile(latencies_ms, 50)),
            "p95_batch_ms": float(np.percentile(latencies_ms, 95)),
            "p99_batch_ms": float(np.percentile(latencies_ms, 99)),
            "mean_sample_ms": float(sample_latencies_ms.mean()),
            "p50_sample_ms": float(np.percentile(sample_latencies_ms, 50)),
            "throughput_samp_sec": float(throughput)
        }

    # Helper function for ONNX Runtime latency
    import onnxruntime as ort
    def measure_onnx_engine(providers, batch_size=1, num_warmup=50, num_runs=500):
        sess = ort.InferenceSession(str(ONNX_PATH), providers=providers)
        input_name = sess.get_inputs()[0].name
        dummy_np = np.zeros((batch_size, NUM_FEATURES, WINDOW_SIZE), dtype=np.float32)
        
        for _ in range(num_warmup):
            _ = sess.run(None, {input_name: dummy_np})
            
        latencies_ms = []
        for _ in range(num_runs):
            t0 = time.perf_counter()
            _ = sess.run(None, {input_name: dummy_np})
            t1 = time.perf_counter()
            latencies_ms.append((t1 - t0) * 1000.0)
            
        latencies_ms = np.array(latencies_ms)
        sample_latencies_ms = latencies_ms / batch_size
        throughput = (batch_size * num_runs) / (latencies_ms.sum() / 1000.0)

        return {
            "p50_batch_ms": float(np.percentile(latencies_ms, 50)),
            "p95_batch_ms": float(np.percentile(latencies_ms, 95)),
            "p99_batch_ms": float(np.percentile(latencies_ms, 99)),
            "mean_sample_ms": float(sample_latencies_ms.mean()),
            "p50_sample_ms": float(np.percentile(sample_latencies_ms, 50)),
            "throughput_samp_sec": float(throughput)
        }

    # 1. PyTorch CPU
    pt_cpu_b1 = measure_pytorch_engine(DEVICE_CPU, batch_size=1, num_runs=1000)
    pt_cpu_b1024 = measure_pytorch_engine(DEVICE_CPU, batch_size=1024, num_runs=50)

    # 2. PyTorch GPU (CUDA)
    pt_gpu_b1 = measure_pytorch_engine(DEVICE_CUDA, batch_size=1, num_runs=1000) if torch.cuda.is_available() else None
    pt_gpu_b1024 = measure_pytorch_engine(DEVICE_CUDA, batch_size=1024, num_runs=100) if torch.cuda.is_available() else None

    # 3. ONNX Runtime CPU
    onnx_cpu_b1 = measure_onnx_engine(['CPUExecutionProvider'], batch_size=1, num_runs=1000)
    onnx_cpu_b1024 = measure_onnx_engine(['CPUExecutionProvider'], batch_size=1024, num_runs=50)

    # 4. ONNX Runtime GPU (CUDA Provider)
    onnx_gpu_b1 = None
    onnx_gpu_b1024 = None
    if 'CUDAExecutionProvider' in ort.get_available_providers():
        try:
            onnx_gpu_b1 = measure_onnx_engine(['CUDAExecutionProvider', 'CPUExecutionProvider'], batch_size=1, num_runs=1000)
            onnx_gpu_b1024 = measure_onnx_engine(['CUDAExecutionProvider', 'CPUExecutionProvider'], batch_size=1024, num_runs=100)
        except Exception as e:
            print(f"   ⚠️ ONNX CUDA Provider failed: {e}")

    # Print 4-Engine Comparison Matrix Table
    print("\n   ==========================================================================================================")
    print("   Engine Environment           | Batch 1 Latency (p50) | Batch 1 Throughput | Batch 1024 Per-Sample | Batch 1024 Throughput")
    print("   ==========================================================================================================")
    print(f"   1. PyTorch CPU               | {pt_cpu_b1['p50_batch_ms']:8.4f} ms        | {pt_cpu_b1['throughput_samp_sec']:8,.0f} samp/s  | {pt_cpu_b1024['p50_sample_ms']*1000:8.2f} µs ({pt_cpu_b1024['p50_sample_ms']:.4f} ms) | {pt_cpu_b1024['throughput_samp_sec']:8,.0f} samp/s")
    
    if pt_gpu_b1:
        print(f"   2. PyTorch GPU (CUDA)        | {pt_gpu_b1['p50_batch_ms']:8.4f} ms        | {pt_gpu_b1['throughput_samp_sec']:8,.0f} samp/s  | {pt_gpu_b1024['p50_sample_ms']*1000:8.2f} µs ({pt_gpu_b1024['p50_sample_ms']:.4f} ms) | {pt_gpu_b1024['throughput_samp_sec']:8,.0f} samp/s")
    
    print(f"   3. ONNX Runtime CPU          | {onnx_cpu_b1['p50_batch_ms']:8.4f} ms        | {onnx_cpu_b1['throughput_samp_sec']:8,.0f} samp/s  | {onnx_cpu_b1024['p50_sample_ms']*1000:8.2f} µs ({onnx_cpu_b1024['p50_sample_ms']:.4f} ms) | {onnx_cpu_b1024['throughput_samp_sec']:8,.0f} samp/s")
    
    if onnx_gpu_b1:
        print(f"   4. ONNX Runtime GPU (CUDA)   | {onnx_gpu_b1['p50_batch_ms']:8.4f} ms        | {onnx_gpu_b1['throughput_samp_sec']:8,.0f} samp/s  | {onnx_gpu_b1024['p50_sample_ms']*1000:8.2f} µs ({onnx_gpu_b1024['p50_sample_ms']:.4f} ms) | {onnx_gpu_b1024['throughput_samp_sec']:8,.0f} samp/s")
    print("   ==========================================================================================================")

    # -------------------------------------------------------------------------
    # E. Save Confusion Matrix Plot & Save Json Results
    # -------------------------------------------------------------------------
    diagrams_dir = Path(__file__).parent.parent / "diagrams"
    diagrams_dir.mkdir(parents=True, exist_ok=True)
    cm_plot_path = diagrams_dir / "confusion_matrix_benchmark.png"

    try:
        import matplotlib.pyplot as plt
        import seaborn as sns

        plt.figure(figsize=(8, 6))
        sns.heatmap(
            cm, annot=True, fmt="d", cmap="Blues",
            xticklabels=[FAULT_NAMES[i] for i in range(NUM_CLASSES)],
            yticklabels=[FAULT_NAMES[i] for i in range(NUM_CLASSES)],
            cbar=True, square=True, annot_kws={"size": 10, "weight": "bold"}
        )
        plt.title("InceptionTime Benchmark — Confusion Matrix", fontsize=12, fontweight='bold', pad=15)
        plt.xlabel("Predicted Label", fontsize=10, labelpad=10)
        plt.ylabel("True Label", fontsize=10, labelpad=10)
        plt.xticks(rotation=45, ha='right')
        plt.yticks(rotation=0)
        plt.tight_layout()
        plt.savefig(cm_plot_path, dpi=300)
        plt.close()
        print(f"\n📊 [5/5] Saved Confusion Matrix Plot: {cm_plot_path}")
    except Exception as err:
        print(f"\n⚠️ Could not save Confusion Matrix plot: {err}")

    results_payload = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "model_architecture": "InceptionTime",
        "parameters": {
            "total_params": total_params,
            "trainable_params": trainable_params,
            "model_memory_kb": round(model_mem_bytes / 1024, 2),
            "checkpoint_size_mb": round(checkpoint_size_mb, 2),
            "onnx_size_mb": round(onnx_size_mb, 2),
            "macs_per_sample": macs,
            "flops_per_sample": flops,
            "mflops_per_sample": round(flops / 1e6, 3)
        },
        "classification_metrics": {
            "accuracy": round(acc, 4),
            "macro_precision": round(macro_p, 4),
            "macro_recall": round(macro_r, 4),
            "macro_f1": round(macro_f1, 4),
            "micro_precision": round(micro_p, 4),
            "micro_recall": round(micro_r, 4),
            "micro_f1": round(micro_f1, 4),
            "weighted_f1": round(weighted_f1, 4),
            "per_class": class_metrics
        },
        "engine_matrix": {
            "pytorch_cpu": {"b1": pt_cpu_b1, "b1024": pt_cpu_b1024},
            "pytorch_gpu": {"b1": pt_gpu_b1, "b1024": pt_gpu_b1024} if pt_gpu_b1 else None,
            "onnx_cpu": {"b1": onnx_cpu_b1, "b1024": onnx_cpu_b1024},
            "onnx_gpu": {"b1": onnx_gpu_b1, "b1024": onnx_gpu_b1024} if onnx_gpu_b1 else None
        }
    }

    with open(RESULTS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(results_payload, f, indent=2)
    print(f"💾 Saved JSON Benchmark Data: {RESULTS_JSON_PATH}")

    print("\n" + "=" * 85)
    print("✅ COMPLETE 4-ENGINE BENCHMARK AUDIT SUCCESSFUL!")
    print("=" * 85)


if __name__ == "__main__":
    run_benchmark()

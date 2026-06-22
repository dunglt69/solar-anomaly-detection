"""Quick ONNX export — re-run training (loads from cache if checkpoint exists)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from train_inception import (
    InceptionTime, NUM_FEATURES, NUM_CLASSES, WINDOW_SIZE,
    MODELS_DIR, FOCAL_GAMMA, FAULT_NAMES
)
import torch, json

CHECKPOINT = MODELS_DIR / "inception_checkpoint.pt"

def main():
    print("📦 ONNX Export Tool", flush=True)
    
    if not CHECKPOINT.exists():
        print("❌ No checkpoint found. Run train_inception.py first.", flush=True)
        print(f"   Expected: {CHECKPOINT}", flush=True)
        return
    
    # Load model
    model = InceptionTime(
        c_in=NUM_FEATURES, c_out=NUM_CLASSES,
        n_filters=32, depth=6, kernel_sizes=(5, 11, 23), bottleneck=32,
    )
    
    ckpt = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt["model_state_dict"])
    model.cpu().eval()
    print(f"   Loaded checkpoint (F1={ckpt.get('best_f1', '?')})", flush=True)
    
    # Export
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    onnx_path = MODELS_DIR / "inception_fault_classifier.onnx"
    dummy = torch.randn(1, NUM_FEATURES, WINDOW_SIZE)
    
    torch.onnx.export(
        model, dummy, str(onnx_path),
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    
    size_mb = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"   ✅ ONNX saved: {onnx_path} ({size_mb:.2f} MB)", flush=True)
    
    # Save metadata
    meta = {
        "model": "InceptionTime", "version": "v2",
        "features": NUM_FEATURES, "window_size": WINDOW_SIZE,
        "num_classes": NUM_CLASSES, "class_names": FAULT_NAMES,
        "base_features": ["vdc1","vdc2","idc1","idc2","irr","pvt",
                          "pdc1","pdc2","pdc_total"],
        "ratio_features": ["vdc_ratio","idc_ratio","vdc_diff","idc_diff"],
        "focal_gamma": FOCAL_GAMMA,
        "best_macro_f1": float(ckpt.get("best_f1", 0)),
        "test_accuracy": float(ckpt.get("test_acc", 0)),
        "params": sum(p.numel() for p in model.parameters()),
    }
    with open(MODELS_DIR / "model_metadata.json", "w") as f:
        json.dump(meta, f, indent=2)
    print("   ✅ Metadata saved", flush=True)

if __name__ == "__main__":
    main()

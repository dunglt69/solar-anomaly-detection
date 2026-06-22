"""
EnergiaMind — InceptionTime Fault Classifier v1

Architecture: InceptionTime (multi-scale Conv1d) + Focal Loss
- Replaces LSTM: Conv1d parallelizes on GPU, 3-5x faster training
- Focal Loss (γ=2.0): handles 85% Normal class domination
- Ratio features: vdc1/vdc2, idc1/idc2 — critical for 2-string fault detection

Features (13): vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdcTotal,
               vdc_ratio, idc_ratio, vdc_diff, idc_diff
Labels: 0=Normal, 1=Short-Circuit, 2=Degradation, 3=Open Circuit, 4=Shadowing

Reference: Fawaz et al., "InceptionTime: Finding AlexNet for TSC" (2020)
"""

import os
import sys
import json
import time
import numpy as np
from pathlib import Path
from collections import Counter

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset
from sklearn.metrics import classification_report, confusion_matrix
from tqdm import tqdm

# ─── Config ──────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"
MODELS_DIR = Path(__file__).parent.parent / "server" / "models"

NUM_CLASSES = 5
WINDOW_SIZE = 24
BASE_FEATURES = 13         # from dataset prep (9 base + 4 ratio)
RATIO_FEATURES = 0         # already included in base
NUM_FEATURES = BASE_FEATURES  # 13

BATCH_SIZE = 1024           # RTX 4060 can handle larger batches
LEARNING_RATE = 1e-3
MAX_EPOCHS = 50
PATIENCE = 10
FOCAL_GAMMA = 2.0

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

FAULT_NAMES = {
    0: "Normal", 1: "Short-Circuit", 2: "Degradation",
    3: "Open Circuit", 4: "Shadowing",
}


# ─── Focal Loss ──────────────────────────────────────────────────────
class FocalLoss(nn.Module):
    """Focal Loss (Lin et al., ICCV 2017) — down-weights easy samples."""
    def __init__(self, alpha=None, gamma=2.0, reduction='mean'):
        super().__init__()
        self.gamma = gamma
        self.reduction = reduction
        if alpha is not None:
            self.register_buffer('alpha', torch.tensor(alpha, dtype=torch.float32))
        else:
            self.alpha = None

    def forward(self, inputs, targets):
        ce_loss = F.cross_entropy(inputs, targets, weight=self.alpha, reduction='none')
        pt = torch.exp(-ce_loss)
        focal_loss = ((1 - pt) ** self.gamma) * ce_loss
        if self.reduction == 'mean':
            return focal_loss.mean()
        return focal_loss


# ─── InceptionModule ─────────────────────────────────────────────────
class InceptionModule(nn.Module):
    """Single Inception module with multi-scale Conv1d kernels."""
    def __init__(self, in_channels, n_filters=32, kernel_sizes=(5, 11, 23),
                 bottleneck_channels=32, use_residual=True):
        super().__init__()
        self.use_residual = use_residual

        # Bottleneck: reduce channel dimensionality before convolutions
        self.bottleneck = nn.Conv1d(in_channels, bottleneck_channels, 1, bias=False)

        # Multi-scale convolutions
        self.convolutions = nn.ModuleList([
            nn.Conv1d(bottleneck_channels, n_filters, k, padding=k // 2, bias=False)
            for k in kernel_sizes
        ])

        # MaxPool branch
        self.maxpool = nn.MaxPool1d(3, stride=1, padding=1)
        self.maxpool_conv = nn.Conv1d(in_channels, n_filters, 1, bias=False)

        # Concatenated channels = n_filters * (len(kernel_sizes) + 1)
        out_channels = n_filters * (len(kernel_sizes) + 1)
        self.bn = nn.BatchNorm1d(out_channels)

        # Residual shortcut
        if use_residual:
            self.residual = nn.Sequential(
                nn.Conv1d(in_channels, out_channels, 1, bias=False),
                nn.BatchNorm1d(out_channels),
            )

    def forward(self, x):
        # Bottleneck
        x_bt = self.bottleneck(x)

        # Multi-scale convolutions
        conv_outputs = [conv(x_bt) for conv in self.convolutions]

        # MaxPool branch
        mp = self.maxpool(x)
        mp = self.maxpool_conv(mp)
        conv_outputs.append(mp)

        # Concatenate all branches
        z = torch.cat(conv_outputs, dim=1)
        z = self.bn(z)
        z = F.relu(z)

        # Residual connection
        if self.use_residual:
            z = z + self.residual(x)
            z = F.relu(z)

        return z


class InceptionTime(nn.Module):
    """InceptionTime classifier for multivariate time series.

    Input: (batch, channels, seq_len) = (B, 13, 24)
    Output: (batch, num_classes) = (B, 5)
    """
    def __init__(self, c_in, c_out, n_filters=32, depth=6,
                 kernel_sizes=(5, 11, 23), bottleneck=32):
        super().__init__()

        inception_channels = n_filters * (len(kernel_sizes) + 1)  # 128

        modules = []
        for i in range(depth):
            in_ch = c_in if i == 0 else inception_channels
            modules.append(InceptionModule(
                in_ch, n_filters, kernel_sizes, bottleneck,
                use_residual=(i > 0),  # No residual on first block
            ))
        self.inception_blocks = nn.Sequential(*modules)

        # Global Average Pooling + classifier
        self.gap = nn.AdaptiveAvgPool1d(1)
        self.dropout = nn.Dropout(0.2)
        self.fc = nn.Linear(inception_channels, c_out)

    def forward(self, x):
        # x: (batch, channels, seq_len)
        z = self.inception_blocks(x)
        z = self.gap(z).squeeze(-1)  # (batch, inception_channels)
        z = self.dropout(z)
        return self.fc(z)


# ─── Feature augmentation ────────────────────────────────────────────
def add_ratio_features(X: np.ndarray) -> np.ndarray:
    """Add ratio/diff features to sliding windows.

    Input:  (N, window, 9)  — vdc1,vdc2,idc1,idc2,irr,pvt,pdc1,pdc2,pdcTotal
    Output: (N, window, 13) — + vdc_ratio, idc_ratio, vdc_diff, idc_diff
    """
    vdc1, vdc2 = X[:, :, 0], X[:, :, 1]  # MinMax [0,1]
    idc1, idc2 = X[:, :, 2], X[:, :, 3]

    # Safe ratio: only compute where denominator > threshold, else 1.0 (balanced)
    thresh = 0.01
    vdc_ratio = np.where(vdc2 > thresh, vdc1 / vdc2, 1.0)
    idc_ratio = np.where(idc2 > thresh, idc1 / idc2, 1.0)
    # Clamp to [0, 5] to avoid outliers
    vdc_ratio = np.clip(vdc_ratio, 0.0, 5.0)
    idc_ratio = np.clip(idc_ratio, 0.0, 5.0)

    vdc_diff = np.abs(vdc1 - vdc2)
    idc_diff = np.abs(idc1 - idc2)

    new_feats = np.stack([vdc_ratio, idc_ratio, vdc_diff, idc_diff], axis=-1)
    result = np.concatenate([X, new_feats.astype(np.float32)], axis=-1)

    # Safety: replace any remaining NaN/Inf
    result = np.nan_to_num(result, nan=0.0, posinf=5.0, neginf=0.0)
    return result


# ─── Main ─────────────────────────────────────────────────────────────
def main():
    print("🧠 EnergiaMind InceptionTime Trainer v1", flush=True)
    print(f"   Device: {DEVICE}", flush=True)
    if DEVICE.type == "cuda":
        print(f"   GPU: {torch.cuda.get_device_name(0)}", flush=True)
        print(f"   VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB", flush=True)

    # ── Load data ─────────────────────────────────────────────────────
    print(f"\n📂 Loading from {DATA_DIR}...", flush=True)
    train = np.load(DATA_DIR / "train.npz")
    print("   train.npz loaded", flush=True)
    val = np.load(DATA_DIR / "val.npz")
    print("   val.npz loaded", flush=True)
    test = np.load(DATA_DIR / "test.npz")
    print("   test.npz loaded", flush=True)

    X_train, y_train = train["X"], train["y"]
    X_val, y_val = val["X"], val["y"]
    X_test, y_test = test["X"], test["y"]
    print(f"   Raw: Train={X_train.shape} Val={X_val.shape} Test={X_test.shape}")

    # Features are pre-computed (13 features including ratios) — no runtime augmentation needed
    print(f"   Features: {NUM_FEATURES} (pre-computed in data prep)")

    # ── Transpose for Conv1d: (N, seq, ch) → (N, ch, seq) ────────────
    X_train = np.transpose(X_train, (0, 2, 1))  # (N, 13, 24)
    X_val = np.transpose(X_val, (0, 2, 1))
    X_test = np.transpose(X_test, (0, 2, 1))

    # ── Label distribution ────────────────────────────────────────────
    print(f"\n📊 Train label distribution:")
    counts = Counter(y_train.tolist())
    total = len(y_train)
    class_counts = []
    for c in range(NUM_CLASSES):
        n = counts.get(c, 0)
        class_counts.append(n)
        print(f"   {FAULT_NAMES[c]:15s}: {n:>10,} ({n/total*100:5.2f}%)")

    # ── Focal Loss with class-balanced alpha ──────────────────────────
    # Effective number of samples (Cui et al., CVPR 2019)
    beta = 0.9999
    effective_num = [1.0 - beta**n for n in class_counts]
    alpha = [(1.0 - beta) / en for en in effective_num]
    alpha_sum = sum(alpha)
    alpha = [a / alpha_sum * NUM_CLASSES for a in alpha]  # normalize
    print(f"\n⚖️  Focal Loss α (class-balanced):")
    for c in range(NUM_CLASSES):
        print(f"   {FAULT_NAMES[c]:15s}: α={alpha[c]:.4f}")

    # ── DataLoaders ───────────────────────────────────────────────────
    train_ds = TensorDataset(
        torch.from_numpy(X_train).float(),
        torch.from_numpy(y_train).long(),
    )
    val_ds = TensorDataset(
        torch.from_numpy(X_val).float(),
        torch.from_numpy(y_val).long(),
    )
    test_ds = TensorDataset(
        torch.from_numpy(X_test).float(),
        torch.from_numpy(y_test).long(),
    )

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,
                              num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE * 2, shuffle=False,
                            num_workers=0, pin_memory=True)
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE * 2, shuffle=False,
                             num_workers=0, pin_memory=True)

    # ── Model ─────────────────────────────────────────────────────────
    model = InceptionTime(
        c_in=NUM_FEATURES,   # 13
        c_out=NUM_CLASSES,   # 5
        n_filters=32,
        depth=6,
        kernel_sizes=(5, 11, 23),
        bottleneck=32,
    ).to(DEVICE)

    n_params = sum(p.numel() for p in model.parameters())
    print(f"\n🏗️  InceptionTime: {n_params:,} params")
    print(f"   Depth=6, Filters=32, Kernels=(5,11,23)")
    print(f"   Input: ({BATCH_SIZE}, {NUM_FEATURES}, {WINDOW_SIZE})")

    criterion = FocalLoss(alpha=alpha, gamma=FOCAL_GAMMA).to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=LEARNING_RATE,
        epochs=MAX_EPOCHS, steps_per_epoch=len(train_loader),
        pct_start=0.1,
    )

    # Mixed precision
    scaler = torch.amp.GradScaler('cuda') if DEVICE.type == 'cuda' else None

    # Track history
    history = {
        "train_loss": [],
        "train_acc": [],
        "val_loss": [],
        "val_acc": [],
        "val_f1": []
    }

    # ── Training loop ─────────────────────────────────────────────────
    print(f"\n🚀 Training (max {MAX_EPOCHS} epochs, patience={PATIENCE})...", flush=True)
    best_f1 = 0.0
    best_state = None
    patience_counter = 0

    for epoch in range(1, MAX_EPOCHS + 1):
        t0 = time.time()

        # ── Train ─────────────────────────────────────────────────────
        model.train()
        train_loss, train_correct, train_total = 0.0, 0, 0

        pbar = tqdm(train_loader, desc=f"Epoch {epoch:>2}/{MAX_EPOCHS} [Train]",
                    leave=False, file=sys.stdout)
        for xb, yb in pbar:
            xb, yb = xb.to(DEVICE, non_blocking=True), yb.to(DEVICE, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)

            if scaler:
                with torch.amp.autocast('cuda'):
                    logits = model(xb)
                    loss = criterion(logits, yb)
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                logits = model(xb)
                loss = criterion(logits, yb)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()

            scheduler.step()
            train_loss += loss.item() * xb.size(0)
            train_correct += (logits.argmax(1) == yb).sum().item()
            train_total += xb.size(0)
            pbar.set_postfix(loss=f"{loss.item():.4f}", acc=f"{train_correct/train_total:.4f}")
        pbar.close()

        train_loss /= train_total
        train_acc = train_correct / train_total

        # ── Validate ──────────────────────────────────────────────────
        model.eval()
        val_loss, val_preds, val_labels = 0.0, [], []

        with torch.no_grad():
            for xb, yb in val_loader:
                xb, yb = xb.to(DEVICE, non_blocking=True), yb.to(DEVICE, non_blocking=True)
                if scaler:
                    with torch.amp.autocast('cuda'):
                        logits = model(xb)
                        loss = criterion(logits, yb)
                else:
                    logits = model(xb)
                    loss = criterion(logits, yb)
                val_loss += loss.item() * xb.size(0)
                val_preds.extend(logits.argmax(1).cpu().numpy())
                val_labels.extend(yb.cpu().numpy())

        val_loss /= len(val_labels)
        val_preds = np.array(val_preds)
        val_labels = np.array(val_labels)
        val_acc = (val_preds == val_labels).mean()

        # Macro F1
        from sklearn.metrics import f1_score
        macro_f1 = f1_score(val_labels, val_preds, average='macro', zero_division=0)

        elapsed = time.time() - t0
        lr = optimizer.param_groups[0]['lr']
        print(f"   Epoch {epoch:>2}/{MAX_EPOCHS} | "
              f"Train: {train_loss:.4f} ({train_acc:.4f}) | "
              f"Val: {val_loss:.4f} ({val_acc:.4f}) | "
              f"F1m: {macro_f1:.4f} | LR: {lr:.1e} | {elapsed:.1f}s", flush=True)

        # Store in history
        history["train_loss"].append(train_loss)
        history["train_acc"].append(train_acc)
        history["val_loss"].append(val_loss)
        history["val_acc"].append(val_acc)
        history["val_f1"].append(macro_f1)

        # ── Early stopping on macro F1 ────────────────────────────────
        if macro_f1 > best_f1:
            best_f1 = macro_f1
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            patience_counter = 0
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                print(f"   ⏹️  Early stopping at epoch {epoch}")
                break

    # ── Load best model ───────────────────────────────────────────────
    print(f"   ✅ Loaded best model (macro_f1={best_f1:.4f})", flush=True)
    model.load_state_dict(best_state)
    model.to(DEVICE)

    # Save checkpoint for later ONNX export
    ckpt_path = MODELS_DIR / "inception_checkpoint.pt"
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.save({"model_state_dict": best_state, "best_f1": best_f1}, ckpt_path)
    print(f"   💾 Checkpoint saved: {ckpt_path}", flush=True)

    # ── Test evaluation ───────────────────────────────────────────────
    model.eval()
    test_preds, test_labels_all = [], []

    with torch.no_grad():
        for xb, yb in test_loader:
            xb = xb.to(DEVICE, non_blocking=True)
            if scaler:
                with torch.amp.autocast('cuda'):
                    logits = model(xb)
            else:
                logits = model(xb)
            test_preds.extend(logits.argmax(1).cpu().numpy())
            test_labels_all.extend(yb.numpy())

    test_preds = np.array(test_preds)
    test_labels_all = np.array(test_labels_all)
    test_acc = (test_preds == test_labels_all).mean()

    print(f"\n📋 Test Evaluation:")
    print(f"   Accuracy: {test_acc:.4f} ({test_acc*100:.2f}%)")

    target_names = [FAULT_NAMES[i] for i in range(NUM_CLASSES)]
    all_labels = list(range(NUM_CLASSES))
    print(classification_report(test_labels_all, test_preds,
                                labels=all_labels,
                                target_names=target_names, zero_division=0))

    cm = confusion_matrix(test_labels_all, test_preds, labels=all_labels)
    print(f"Confusion Matrix:\n{cm}")

    # ── Plotting curves ───────────────────────────────────────────────
    try:
        import matplotlib.pyplot as plt
        import seaborn as sns
        
        diagrams_dir = Path(__file__).parent.parent / "diagrams"
        diagrams_dir.mkdir(parents=True, exist_ok=True)
        
        # 1. Loss Curve
        plt.figure(figsize=(8, 5))
        plt.plot(range(1, len(history["train_loss"])+1), history["train_loss"], label="Train Loss", color="#2563EB", linewidth=2)
        plt.plot(range(1, len(history["val_loss"])+1), history["val_loss"], label="Val Loss", color="#EA580C", linewidth=2)
        plt.title("EnergiaMind InceptionTime — Training vs Validation Loss", fontsize=12, fontweight='bold', pad=15)
        plt.xlabel("Epochs", fontsize=10)
        plt.ylabel("Focal Loss", fontsize=10)
        plt.grid(True, linestyle="--", alpha=0.6)
        plt.legend(frameon=True, facecolor="white", edgecolor="none")
        plt.tight_layout()
        plt.savefig(diagrams_dir / "loss_curve.png", dpi=300)
        plt.close()
        print(f"   📈 Saved Loss Curve: {diagrams_dir / 'loss_curve.png'}", flush=True)

        # 2. Accuracy Curve
        plt.figure(figsize=(8, 5))
        plt.plot(range(1, len(history["train_acc"])+1), history["train_acc"], label="Train Acc", color="#10B981", linewidth=2)
        plt.plot(range(1, len(history["val_acc"])+1), history["val_acc"], label="Val Acc", color="#6366F1", linewidth=2)
        plt.title("EnergiaMind InceptionTime — Training vs Validation Accuracy", fontsize=12, fontweight='bold', pad=15)
        plt.xlabel("Epochs", fontsize=10)
        plt.ylabel("Accuracy", fontsize=10)
        plt.grid(True, linestyle="--", alpha=0.6)
        plt.legend(frameon=True, facecolor="white", edgecolor="none")
        plt.tight_layout()
        plt.savefig(diagrams_dir / "accuracy_curve.png", dpi=300)
        plt.close()
        print(f"   📈 Saved Accuracy Curve: {diagrams_dir / 'accuracy_curve.png'}", flush=True)

        # 3. Confusion Matrix Heatmap
        plt.figure(figsize=(8, 6))
        sns.heatmap(
            cm, annot=True, fmt="d", cmap="Blues",
            xticklabels=[FAULT_NAMES[i] for i in range(NUM_CLASSES)],
            yticklabels=[FAULT_NAMES[i] for i in range(NUM_CLASSES)],
            cbar=True, square=True, annot_kws={"size": 10, "weight": "bold"}
        )
        plt.title("InceptionTime Anomaly Classifier — Confusion Matrix", fontsize=12, fontweight='bold', pad=15)
        plt.xlabel("Predicted Label", fontsize=10, labelpad=10)
        plt.ylabel("True Label", fontsize=10, labelpad=10)
        plt.xticks(rotation=45, ha='right')
        plt.yticks(rotation=0)
        plt.tight_layout()
        plt.savefig(diagrams_dir / "confusion_matrix.png", dpi=300)
        plt.close()
        print(f"   📊 Saved Confusion Matrix Heatmap: {diagrams_dir / 'confusion_matrix.png'}", flush=True)

    except Exception as e:
        print(f"   ⚠️ Failed to generate training plots: {e}", flush=True)

    # Per-class accuracy
    print(f"\nPer-class accuracy:")
    for c in range(NUM_CLASSES):
        mask = test_labels_all == c
        if mask.sum() > 0:
            acc_c = (test_preds[mask] == c).sum() / mask.sum()
            print(f"   {FAULT_NAMES[c]:15s}: {(test_preds[mask] == c).sum():>6} / "
                  f"{mask.sum():>6,} = {acc_c*100:.1f}%")

    from sklearn.metrics import precision_recall_fscore_support
    p_macro, r_macro, f1_macro, _ = precision_recall_fscore_support(
        test_labels_all, test_preds, average='macro', zero_division=0)
    p_w, r_w, f1_w, _ = precision_recall_fscore_support(
        test_labels_all, test_preds, average='weighted', zero_division=0)
    print(f"\n   Macro:    P={p_macro:.4f} R={r_macro:.4f} F1={f1_macro:.4f}")
    print(f"   Weighted: P={p_w:.4f} R={r_w:.4f} F1={f1_w:.4f}")

    # ── Export ONNX ───────────────────────────────────────────────────
    print(f"\n📦 Exporting ONNX...")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    onnx_path = MODELS_DIR / "inception_fault_classifier.onnx"

    model.cpu().eval()
    dummy = torch.randn(1, NUM_FEATURES, WINDOW_SIZE)

    torch.onnx.export(
        model, dummy, str(onnx_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )

    size_mb = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"   ONNX saved: {onnx_path} ({size_mb:.2f} MB)")

    # ── Save metadata ─────────────────────────────────────────────────
    meta = {
        "model": "InceptionTime",
        "version": "v1",
        "features": NUM_FEATURES,
        "window_size": WINDOW_SIZE,
        "num_classes": NUM_CLASSES,
        "class_names": FAULT_NAMES,
        "base_features": ["vdc1", "vdc2", "idc1", "idc2", "irr", "pvt",
                          "pdc1", "pdc2", "pdc_total"],
        "ratio_features": ["vdc_ratio", "idc_ratio", "vdc_diff", "idc_diff"],
        "focal_gamma": FOCAL_GAMMA,
        "best_macro_f1": float(best_f1),
        "test_accuracy": float(test_acc),
        "test_macro_f1": float(f1_macro),
        "params": int(n_params),
    }
    meta_path = MODELS_DIR / "model_metadata.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\n{'='*60}")
    print(f"✅ TRAINING COMPLETE")
    print(f"   Model:       InceptionTime (depth=6, filters=32)")
    print(f"   Accuracy:    {test_acc*100:.2f}%")
    print(f"   Macro F1:    {f1_macro:.4f}")
    print(f"   Weighted F1: {f1_w:.4f}")
    print(f"   ONNX:        {onnx_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

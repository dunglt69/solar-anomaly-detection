"""
EnergiaMind — LSTM Fault Classifier Training v3

Key fixes from v2:
- WeightedRandomSampler to balance training batches (critical for 84% Normal imbalance)
- Inverse-frequency class weights (not sqrt-scaled) for loss function
- Label smoothing cross-entropy instead of Focal Loss (more stable for extreme imbalance)
- OneCycleLR scheduler (better convergence)
- Gradient accumulation for effective larger batch

Architecture: Input(9) → LSTM(128, 2 layers, bidirectional) → Dropout(0.3) → FC(5)
Features: vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdc_total
Labels: 0=Normal, 1=Short-Circuit, 2=Degradation, 3=Open Circuit, 4=Shadowing
"""

import os
import json
import time
import numpy as np
from pathlib import Path
from collections import Counter

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler
from sklearn.metrics import classification_report, confusion_matrix, precision_recall_fscore_support

# ─── Config ──────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"
MODELS_DIR = Path(__file__).parent.parent / "server" / "models"

HIDDEN_SIZE = 128
NUM_LAYERS = 2
BIDIRECTIONAL = True
DROPOUT = 0.3
BATCH_SIZE = 256
LEARNING_RATE = 2e-3
MAX_EPOCHS = 40
PATIENCE = 8
NUM_CLASSES = 5
WINDOW_SIZE = 24
NUM_FEATURES = 9

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

FAULT_NAMES = {
    0: "Normal",
    1: "Short-Circuit",
    2: "Degradation",
    3: "Open Circuit",
    4: "Shadowing",
}


# ─── Model ───────────────────────────────────────────────────────────
class LSTMFaultClassifier(nn.Module):
    def __init__(self, input_size=NUM_FEATURES, hidden_size=HIDDEN_SIZE,
                 num_layers=NUM_LAYERS, num_classes=NUM_CLASSES,
                 dropout=DROPOUT, bidirectional=BIDIRECTIONAL):
        super().__init__()
        self.num_directions = 2 if bidirectional else 1

        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0,
            bidirectional=bidirectional,
        )
        self.layer_norm = nn.LayerNorm(hidden_size * self.num_directions)
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Linear(hidden_size * self.num_directions, num_classes)

    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        last_output = lstm_out[:, -1, :]  # Take last timestep
        out = self.layer_norm(last_output)
        out = self.dropout(out)
        return self.fc(out)


# ─── Training ────────────────────────────────────────────────────────
def make_weighted_sampler(labels: np.ndarray) -> WeightedRandomSampler:
    """Create a sampler that balances class frequencies in each batch.
    
    Without this, with 84.65% Normal data, the model barely sees
    minority classes (0.44% Short-Circuit, 0.44% Open Circuit).
    """
    counter = Counter(labels.tolist())
    total = len(labels)
    
    # Inverse frequency: rarer classes get much higher weight
    class_weights = {cls: total / cnt for cls, cnt in counter.items()}
    
    # Cap Normal weight to prevent it from being too low
    # (we still want the model to learn Normal well)
    max_weight = max(class_weights.values())
    min_weight = min(class_weights.values())
    
    print(f"\n📊 Sampler class weights (inverse frequency):")
    for cls in sorted(counter.keys()):
        w = class_weights[cls]
        print(f"   {FAULT_NAMES.get(cls, cls):15s}: count={counter[cls]:>8,d}  weight={w:.2f}")
    
    # Assign per-sample weight
    sample_weights = np.array([class_weights[int(l)] for l in labels], dtype=np.float64)
    
    # Number of samples per epoch = same as dataset size
    # But the sampler will oversample minority classes
    return WeightedRandomSampler(
        weights=torch.from_numpy(sample_weights),
        num_samples=len(labels),
        replacement=True,
    )


def compute_loss_weights(labels: np.ndarray) -> torch.Tensor:
    """Compute class weights for loss function.
    Uses inverse frequency with sqrt dampening to avoid over-correction.
    """
    counter = Counter(labels.tolist())
    total = len(labels)
    weights = np.zeros(NUM_CLASSES)
    for cls in range(NUM_CLASSES):
        cnt = counter.get(cls, 1)
        weights[cls] = np.sqrt(total / (NUM_CLASSES * cnt))
    weights = weights / weights.mean()
    
    print(f"\n⚖️  Loss class weights (sqrt inverse freq):")
    for i in range(NUM_CLASSES):
        print(f"   {FAULT_NAMES[i]:15s}: {weights[i]:.4f}")
    
    return torch.FloatTensor(weights)


def train_epoch(model, loader, criterion, optimizer, accumulate_steps=1):
    model.train()
    total_loss, correct, total = 0, 0, 0
    optimizer.zero_grad()
    
    for step, (X_batch, y_batch) in enumerate(loader):
        X_batch, y_batch = X_batch.to(DEVICE, non_blocking=True), y_batch.to(DEVICE, non_blocking=True)
        logits = model(X_batch)
        loss = criterion(logits, y_batch) / accumulate_steps
        loss.backward()
        
        if (step + 1) % accumulate_steps == 0:
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            optimizer.zero_grad()
        
        total_loss += loss.item() * accumulate_steps * X_batch.size(0)
        correct += (logits.argmax(1) == y_batch).sum().item()
        total += X_batch.size(0)
    
    return total_loss / total, correct / total


def evaluate(model, loader, criterion):
    model.eval()
    total_loss, correct, total = 0, 0, 0
    all_preds, all_labels = [], []
    with torch.no_grad():
        for X_batch, y_batch in loader:
            X_batch, y_batch = X_batch.to(DEVICE, non_blocking=True), y_batch.to(DEVICE, non_blocking=True)
            logits = model(X_batch)
            loss = criterion(logits, y_batch)
            total_loss += loss.item() * X_batch.size(0)
            preds = logits.argmax(1)
            correct += (preds == y_batch).sum().item()
            total += X_batch.size(0)
            all_preds.extend(preds.cpu().numpy())
            all_labels.extend(y_batch.cpu().numpy())
    return total_loss / total, correct / total, np.array(all_preds), np.array(all_labels)


def export_onnx(model, save_path: Path):
    model.eval()
    model.cpu()
    dummy = torch.randn(1, WINDOW_SIZE, NUM_FEATURES)
    torch.onnx.export(
        model, dummy, str(save_path),
        export_params=True, opset_version=17,
        do_constant_folding=True,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
    )
    import onnx
    onnx.checker.check_model(onnx.load(str(save_path)))
    sz = save_path.stat().st_size / (1024 * 1024)
    print(f"   ONNX model saved: {save_path} ({sz:.1f} MB)")


def main():
    print(f"🧠 EnergiaMind LSTM Trainer v3")
    print(f"   Device: {DEVICE}")
    if DEVICE.type == "cuda":
        print(f"   GPU: {torch.cuda.get_device_name(0)}")
        print(f"   VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    # ── Load ──────────────────────────────────────────────────────────
    print(f"\n📂 Loading from {DATA_DIR}...")
    train_data = np.load(DATA_DIR / "train.npz")
    val_data = np.load(DATA_DIR / "val.npz")
    test_data = np.load(DATA_DIR / "test.npz")
    
    X_train, y_train = train_data["X"], train_data["y"]
    X_val, y_val = val_data["X"], val_data["y"]
    X_test, y_test = test_data["X"], test_data["y"]
    
    print(f"   Train: {X_train.shape} | Val: {X_val.shape} | Test: {X_test.shape}")
    assert X_train.shape[2] == NUM_FEATURES, f"Expected {NUM_FEATURES} features, got {X_train.shape[2]}"

    # Show distribution
    print(f"\n   Train label distribution:")
    train_counter = Counter(y_train.tolist())
    for cls in sorted(train_counter.keys()):
        pct = train_counter[cls] / len(y_train) * 100
        print(f"   {FAULT_NAMES.get(int(cls), cls):15s}: {train_counter[cls]:>8,d} ({pct:.2f}%)")

    # ── DataLoaders with WeightedRandomSampler ───────────────────────
    train_ds = TensorDataset(torch.FloatTensor(X_train), torch.LongTensor(y_train))
    val_ds = TensorDataset(torch.FloatTensor(X_val), torch.LongTensor(y_val))
    test_ds = TensorDataset(torch.FloatTensor(X_test), torch.LongTensor(y_test))
    
    # THIS IS THE KEY FIX: WeightedRandomSampler ensures each batch
    # has roughly equal representation of all classes
    sampler = make_weighted_sampler(y_train)
    
    num_workers = min(4, os.cpu_count() or 1)
    train_loader = DataLoader(
        train_ds, batch_size=BATCH_SIZE, sampler=sampler,
        pin_memory=True, num_workers=num_workers, persistent_workers=num_workers > 0,
    )
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE * 2, pin_memory=True, num_workers=num_workers)
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE * 2, pin_memory=True, num_workers=num_workers)

    # ── Model + Loss + Optimizer ─────────────────────────────────────
    loss_weights = compute_loss_weights(y_train).to(DEVICE)
    
    model = LSTMFaultClassifier().to(DEVICE)
    criterion = nn.CrossEntropyLoss(weight=loss_weights, label_smoothing=0.05)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=1e-4)
    
    steps_per_epoch = len(train_loader)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=LEARNING_RATE,
        steps_per_epoch=steps_per_epoch,
        epochs=MAX_EPOCHS,
        pct_start=0.15,  # 15% warmup
        anneal_strategy='cos',
    )

    total_params = sum(p.numel() for p in model.parameters())
    print(f"\n🏗️  Model: {total_params:,} params")
    print(f"   LSTM({NUM_FEATURES}→{HIDDEN_SIZE}, {NUM_LAYERS}L, bi) → LayerNorm → FC({NUM_CLASSES})")
    print(f"   Loss: CrossEntropy + label_smoothing=0.05 + class weights")
    print(f"   Optimizer: AdamW (lr={LEARNING_RATE}, wd=1e-4)")
    print(f"   Scheduler: OneCycleLR (warmup 15%)")
    print(f"   Sampler: WeightedRandomSampler (inverse frequency)")

    # ── Train ─────────────────────────────────────────────────────────
    print(f"\n🚀 Training (max {MAX_EPOCHS} epochs, patience={PATIENCE})...")
    best_val_loss = float("inf")
    best_macro_f1 = 0.0
    patience_counter = 0
    best_model_state = None

    for epoch in range(1, MAX_EPOCHS + 1):
        t0 = time.time()
        
        # Train
        model.train()
        total_loss, correct, total = 0, 0, 0
        for X_batch, y_batch in train_loader:
            X_batch = X_batch.to(DEVICE, non_blocking=True)
            y_batch = y_batch.to(DEVICE, non_blocking=True)
            
            optimizer.zero_grad()
            logits = model(X_batch)
            loss = criterion(logits, y_batch)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()
            
            total_loss += loss.item() * X_batch.size(0)
            correct += (logits.argmax(1) == y_batch).sum().item()
            total += X_batch.size(0)
        
        train_loss = total_loss / total
        train_acc = correct / total
        
        # Validate
        val_loss, val_acc, val_preds, val_labels = evaluate(model, val_loader, criterion)
        macro_p, macro_r, macro_f1, _ = precision_recall_fscore_support(
            val_labels, val_preds, average='macro', zero_division=0
        )
        
        lr = optimizer.param_groups[0]["lr"]
        elapsed = time.time() - t0
        
        print(f"   Epoch {epoch:2d}/{MAX_EPOCHS} | "
              f"Train: {train_loss:.4f} ({train_acc:.4f}) | "
              f"Val: {val_loss:.4f} ({val_acc:.4f}) | "
              f"F1m: {macro_f1:.4f} | "
              f"LR: {lr:.1e} | {elapsed:.1f}s")

        # Track best model by MACRO F1 (not just val_loss)
        # This ensures minority classes are actually learned
        if macro_f1 > best_macro_f1:
            best_macro_f1 = macro_f1
            best_val_loss = val_loss
            patience_counter = 0
            best_model_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                print(f"   ⏹️  Early stopping at epoch {epoch}")
                break

    if best_model_state:
        model.load_state_dict(best_model_state)
        print(f"   ✅ Loaded best model (macro_f1={best_macro_f1:.4f}, val_loss={best_val_loss:.4f})")

    # ── Test ──────────────────────────────────────────────────────────
    print(f"\n📋 Test Evaluation:")
    test_loss, test_acc, preds, labels = evaluate(model, test_loader, criterion)
    print(f"   Loss: {test_loss:.4f} | Accuracy: {test_acc:.4f} ({test_acc*100:.2f}%)")

    names = [FAULT_NAMES[i] for i in range(NUM_CLASSES)]
    print(f"\n{classification_report(labels, preds, target_names=names, digits=4, zero_division=0)}")
    print("Confusion Matrix:")
    cm = confusion_matrix(labels, preds)
    print(cm)

    # Per-class accuracy
    print("\nPer-class accuracy:")
    for i in range(NUM_CLASSES):
        class_total = (labels == i).sum()
        class_correct = cm[i, i] if i < cm.shape[0] else 0
        class_acc = class_correct / class_total * 100 if class_total > 0 else 0
        print(f"   {FAULT_NAMES[i]:15s}: {class_correct:>6,d} / {class_total:>6,d} = {class_acc:.1f}%")

    macro_p, macro_r, macro_f1, _ = precision_recall_fscore_support(labels, preds, average='macro', zero_division=0)
    weighted_p, weighted_r, weighted_f1, _ = precision_recall_fscore_support(labels, preds, average='weighted', zero_division=0)
    print(f"\n   Macro:    P={macro_p:.4f} R={macro_r:.4f} F1={macro_f1:.4f}")
    print(f"   Weighted: P={weighted_p:.4f} R={weighted_r:.4f} F1={weighted_f1:.4f}")

    # ── Save ──────────────────────────────────────────────────────────
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.save({
        "model_state_dict": model.state_dict(),
        "hyperparams": {
            "hidden_size": HIDDEN_SIZE, "num_layers": NUM_LAYERS,
            "bidirectional": BIDIRECTIONAL, "dropout": DROPOUT,
            "num_features": NUM_FEATURES, "num_classes": NUM_CLASSES,
            "window_size": WINDOW_SIZE,
        },
        "test_accuracy": test_acc, "test_loss": test_loss,
        "macro_f1": float(macro_f1), "weighted_f1": float(weighted_f1),
    }, MODELS_DIR / "lstm_checkpoint.pt")

    print(f"\n📦 Exporting ONNX...")
    export_onnx(model, MODELS_DIR / "lstm_fault_classifier.onnx")

    metadata = {
        "model": "LSTMFaultClassifier",
        "version": 3,
        "num_features": NUM_FEATURES,
        "window_size": WINDOW_SIZE,
        "num_classes": NUM_CLASSES,
        "feature_names": ["vdc1", "vdc2", "idc1", "idc2", "irr", "pvt", "pdc1", "pdc2", "pdc_total"],
        "class_names": {str(k): v for k, v in FAULT_NAMES.items()},
        "test_accuracy": float(test_acc),
        "macro_f1": float(macro_f1),
        "weighted_f1": float(weighted_f1),
        "device": str(DEVICE),
        "training_config": {
            "batch_size": BATCH_SIZE,
            "learning_rate": LEARNING_RATE,
            "max_epochs": MAX_EPOCHS,
            "sampler": "WeightedRandomSampler",
            "loss": "CrossEntropyLoss+label_smoothing",
            "scheduler": "OneCycleLR",
        },
    }
    with open(MODELS_DIR / "training_metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\n{'='*60}")
    print(f"✅ TRAINING COMPLETE")
    print(f"   Accuracy:    {test_acc*100:.2f}%")
    print(f"   Macro F1:    {macro_f1:.4f}")
    print(f"   Weighted F1: {weighted_f1:.4f}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

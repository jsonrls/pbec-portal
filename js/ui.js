// ui.js — Shared UI utilities (toast, confirm dialog, helpers)

// ─── Toast Notifications ────────────────────────────────────────
export function showToast(message, type = "info", duration = 3500) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
    <span class="toast-icon">${icons[type] || "ℹ️"}</span>
    <span class="toast-msg">${message}</span>
  `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("hide");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, duration);
}

// ─── Confirm Dialog ─────────────────────────────────────────────
export function showConfirm(message, title = "Are you sure?", confirmText = "Confirm", isDanger = true) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <div class="modal-header">
          <span style="font-size:20px;">⚠️</span>
          <h3>${title}</h3>
        </div>
        <div class="modal-body">
          <p>${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn ${isDanger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${confirmText}</button>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);

        overlay.querySelector("#confirm-ok").addEventListener("click", () => {
            overlay.remove();
            resolve(true);
        });
        overlay.querySelector("#confirm-cancel").addEventListener("click", () => {
            overlay.remove();
            resolve(false);
        });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(false); }
        });
    });
}

// ─── Modal helpers ──────────────────────────────────────────────
export function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove("hidden");
}
export function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add("hidden");
}

// ─── Loading button state ────────────────────────────────────────
export function setButtonLoading(btn, loading, originalText = null) {
    if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> ${originalText || "Loading…"}`;
    } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    }
}

// ─── Format date ─────────────────────────────────────────────────
export function formatDate(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

// ─── Format timestamp (with time) ────────────────────────────────
export function formatDateTime(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("en-PH", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

// ─── Debounce ────────────────────────────────────────────────────
export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// ─── Sidebar toggle (mobile) ─────────────────────────────────────
export function initSidebar() {
    const hamburger = document.getElementById("hamburger");
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!hamburger || !sidebar) return;

    hamburger.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        if (overlay) overlay.classList.toggle("hidden");
    });
    if (overlay) {
        overlay.addEventListener("click", () => {
            sidebar.classList.remove("open");
            overlay.classList.add("hidden");
        });
    }
}

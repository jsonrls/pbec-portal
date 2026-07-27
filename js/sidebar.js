export function renderSidebar(activePage, user) {
  const role = user.role;
  const icons = {
    dashboard: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20h14v-9.5"/><path d="M9.5 20v-5h5v5"/></svg>`,
    students: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.87"/><path d="M16 4.3a3.5 3.5 0 0 1 0 6.4"/></svg>`,
    "question-bank": `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3Z"/><path d="M8 7h8"/><path d="M8 11h6"/></svg>`,
    exams: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5"/><path d="M18 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2Z"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`,
    summary: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/></svg>`,
    users: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>`,
    logs: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2 2 0 1 1-2.83 2.83l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21a2 2 0 1 1-4 0v-.06a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.04.04a2 2 0 1 1-2.83-2.83l.04-.04A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.66-1.1H3a2 2 0 1 1 0-4h.06A1.8 1.8 0 0 0 4.72 8.8a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2 2 0 1 1 2.83-2.83l.04.04A1.8 1.8 0 0 0 9.17 4.35 1.8 1.8 0 0 0 10.27 2.7V3a2 2 0 1 1 4 0v-.3a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 1.98-.36l.04-.04a2 2 0 1 1 2.83 2.83l-.04.04a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.66 1.1H21a2 2 0 1 1 0 4h-.06A1.8 1.8 0 0 0 19.4 15Z"/></svg>`
  };
  const workspaceNav = [
    { id: "dashboard", icon: icons.dashboard, label: "Dashboard", href: "dashboard.html" },
    { id: "students", icon: icons.students, label: "Students", href: "students.html" },
    { id: "question-bank", icon: icons["question-bank"], label: "Question Bank", href: "question-bank.html" },
    { id: "exams", icon: icons.exams, label: "Exams", href: "exams.html" },
    { id: "summary", icon: icons.summary, label: "Summary", href: "summary.html" }
  ];

  const systemNav = role === "admin" ? [
    { id: "users", icon: icons.users, label: "Teacher Management", href: "users.html" },
    { id: "logs", icon: icons.logs, label: "Audit Logs", href: "logs.html" },
    { id: "settings", icon: icons.settings, label: "System Settings", href: "settings.html" }
  ] : [];

  const renderNav = (items) => items.map(item => `
    <a href="${item.href}" class="nav-item ${activePage === item.id ? "active" : ""}">
      <span class="nav-icon">${item.icon}</span>
      <span>${item.label}</span>
    </a>
  `).join("");

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-logo">
        <div class="sidebar-logo-icon">
          <img src="../assets/pbec-logo.png" alt="PBEC" />
        </div>
        <div class="sidebar-logo-text">
          <h4>PBEC Command</h4>
          <span>${role === "admin" ? "Administration console" : "Faculty workspace"}</span>
        </div>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-label">${role === "admin" ? "Operations" : "Workspace"}</div>
        ${renderNav(workspaceNav)}
      </div>

      ${systemNav.length ? `
      <div class="sidebar-section">
        <div class="sidebar-section-label">System</div>
        ${renderNav(systemNav)}
      </div>
      ` : ""}

      <div class="sidebar-footer">
        <div class="sidebar-status">
          <span class="status-dot"></span>
          <span>Secure session</span>
        </div>
        <div class="sidebar-user">
          <div class="sidebar-avatar" id="user-avatar">?</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name truncate" id="user-email-display">Loading…</div>
            <div class="sidebar-user-role">${role === "admin" ? "Admin" : "Teacher"} ${user?.teacherId ? `• ${user.teacherId}` : ""}</div>
          </div>
          <button class="sidebar-logout" id="logout-btn" title="Sign out" aria-label="Sign out">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M21 4v16"/></svg>
          </button>
        </div>
      </div>
    </aside>
    <div id="sidebar-overlay" class="hidden" style="
      position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;
    "></div>
  `;
}

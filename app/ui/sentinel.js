// Overseer's agents: one-eyed "sentinels". Pure SVG, coloured per session, expression per state.
(function () {
  const PALETTE = ["#4f8cff", "#ff6fae", "#ff9f43", "#a77bff", "#2ec4b6", "#f7c948", "#5bd17a", "#ff6b6b", "#3dd6f5", "#c792ea"];
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // distinct colours for the first ten sessions seen; stable per session for the app's lifetime
  const assigned = new Map();
  function colorFor(id) {
    id = String(id);
    if (!assigned.has(id)) {
      const used = new Set(assigned.values());
      const start = hash(id) % PALETTE.length;
      let pick = PALETTE[start];
      for (let i = 0; i < PALETTE.length; i++) { const c = PALETTE[(start + i) % PALETTE.length]; if (!used.has(c)) { pick = c; break; } }
      assigned.set(id, pick);
    }
    return assigned.get(id);
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, "0")).join("");
  }
  // status → expression
  function sentinel(id, status, size = 56) {
    const col = colorFor(id), dark = shade(col, 0.72);
    const badge = status === "permission" ? "!" : status === "question" ? "?" : status === "stale" ? "z" : "";
    const mouth = status === "your_move" ? `<path class="mouth" d="M27 44 Q32 48 37 44" stroke="#1a1a22" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
                : status === "ended" ? "" : `<line class="mouth" x1="28" y1="45" x2="36" y2="45" stroke="#1a1a22" stroke-width="2.2" stroke-linecap="round"/>`;
    const eye = status === "ended"
      ? `<path d="M23 32 Q32 37 41 32" stroke="#1a1a22" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
      : `<g class="eye"><ellipse cx="32" cy="31" rx="10.5" ry="10.5" fill="#fff"/>
           <g class="pupil"><circle cx="32" cy="32" r="5.2" fill="#1a1a22"/><circle cx="34" cy="30" r="1.6" fill="#fff"/></g>
           ${status === "stale" ? `<rect x="20" y="19" width="24" height="12" fill="${col}"/><line x1="21.5" y1="31" x2="42.5" y2="31" stroke="${dark}" stroke-width="2"/>` : ""}
         </g>`;
    return `<svg class="sentinel s-${status}" viewBox="0 0 64 72" width="${size}" height="${size * 72 / 64}" aria-hidden="true">
      <ellipse class="shadow" cx="32" cy="68" rx="15" ry="3" fill="#000" opacity=".35"/>
      <g class="bob">
        <line x1="32" y1="14" x2="32" y2="6" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/>
        <circle class="antenna" cx="32" cy="5" r="3.2" fill="${status === "permission" || status === "question" ? "#ff9f0a" : dark}"/>
        <rect x="21" y="52" width="7" height="10" rx="3" fill="${dark}"/><rect x="36" y="52" width="7" height="10" rx="3" fill="${dark}"/>
        <rect x="11" y="14" width="42" height="42" rx="15" fill="${col}"/>
        <path d="M16 22 Q18 17 25 16" stroke="#fff" stroke-opacity=".28" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        ${eye}${mouth}
      </g>
      ${badge ? `<g class="badge"><circle cx="53" cy="12" r="8.5" fill="${badge === "z" ? "#55555f" : "#ff9f0a"}"/><text x="53" y="16.2" text-anchor="middle" font-size="12" font-weight="800" fill="#1a1a22" font-family="Segoe UI, system-ui, sans-serif">${badge}</text></g>` : ""}
    </svg>`;
  }
  globalThis.Sentinel = { sentinel, colorFor };
})();

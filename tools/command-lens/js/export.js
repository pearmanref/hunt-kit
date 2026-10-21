/* L3 — copy/export targets. A registry, so new targets (Packout script, SIEM queries) are new
 * entries rather than new plumbing. Each render() takes the assembled result. */
(function (root) {
  'use strict';
  const CL = (root.CL = root.CL || {});

  const fence = { bash: 'bash', zsh: 'zsh', powershell: 'powershell', cmd: 'bat' };

  CL.exporters = [
    {
      id: 'line',
      label: 'Line',
      render: (r) => r.text,
    },
    {
      id: 'line-summary',
      label: 'Line + summary',
      render: (r) => {
        const c = r.shell.comment || {};
        if (c.interactive && c.token) {
          const wrapped = wrap(r.summary, 100).map((l) => `${c.token} ${l}`).join('\n');
          return `${wrapped}\n${r.text}`;
        }
        // zsh: # is not a comment at an interactive prompt by default, so keep the summary off the command
        return `${r.text}\n\n${r.summary}`;
      },
    },
    {
      id: 'markdown',
      label: 'Markdown block',
      render: (r) => {
        const lines = [];
        lines.push('```' + (fence[r.shell.id] || ''));
        lines.push(r.text);
        lines.push('```');
        lines.push('');
        lines.push(r.summary);
        lines.push('');
        lines.push(`- **Shell:** ${r.shell.name}${r.version ? ' ' + r.version : ''}`);
        if (r.ttps.length) lines.push(`- **ATT&CK:** ${r.ttps.map((t) => t.label).join('; ')}`);
        if (r.requires.length) lines.push(`- **Requires:** ${r.requires.join('; ')}`);
        if (r.opsec.length) lines.push(`- **OPSEC:** ${r.opsec.join('; ')}`);
        lines.push(`- **Built:** ${CL.isoNow()} (Command Lens)`);
        return lines.join('\n');
      },
    },
    {
      id: 'timeline',
      label: 'Timeline Lens row (TSV)',
      // Timeline Lens bulk paste auto-maps these headers onto validation.tool / validation.query /
      // validation.artifact, technique and details. ts and host are filled in there.
      render: (r) => {
        if (/[\t\n]/.test(r.text)) throw new Error('This line contains a tab or several lines, which a TSV row cannot hold. Use the Markdown block instead.');
        const tools = [...new Set(r.layers.filter((l) => l.tool).map((l) => l.tool.name))].join(' | ');
        const artifact = firstPath(r);
        const technique = r.ttps.length ? r.ttps[0].id : '';
        const extra = r.ttps.slice(1).map((t) => t.id);
        const details = r.summary + (extra.length ? ` [also ${extra.join(', ')}]` : '');
        const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
        return ['tool\tquery\tartifact\ttechnique\tdetails', [tools, r.text, artifact, technique, details].map(clean).join('\t')].join('\n');
      },
    },
  ];

  function firstPath(r) {
    for (const l of r.layers) {
      if (!l.tool) continue;
      for (const p of l.tool.params || []) {
        if (p.type !== 'path') continue;
        const v = l.values[p.id];
        if (v === undefined || v === '') continue;
        return Array.isArray(v) ? v.join(', ') : String(v);
      }
    }
    return '';
  }

  function wrap(s, n) {
    const out = [];
    let line = '';
    for (const w of String(s).split(/\s+/)) {
      if (line && (line + ' ' + w).length > n) { out.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(line);
    return out;
  }

  CL.exportAs = function (id, result) {
    const e = CL.exporters.find((x) => x.id === id);
    if (!e) throw new Error('unknown export ' + id);
    return e.render(result);
  };
})(typeof window !== 'undefined' ? window : globalThis);

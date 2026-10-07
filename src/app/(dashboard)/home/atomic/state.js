const key = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function matchesProvider(provider, value) {
  const v = key(value);
  return !!v && [provider.provider, ...(provider.aliases || [])].some(x => key(x) === v);
}

export function normalizeTopology(input) {
  const requests = (input.activeRequests || []).filter(r => r && (key(r.provider) || key(r.model)));
  const seen = new Set();
  return (input.providers || []).filter(p => p && key(p.provider)).map(p => {
    const id = key(p.provider);
    if (seen.has(id)) return null;
    seen.add(id);
    const jobs = requests.filter(r => matchesProvider(p, r.provider));
    return {
      ...p,
      id,
      name: p.name || p.provider,
      jobs,
      live: jobs.length > 0,
      failed: !jobs.length && (matchesProvider(p, input.errorProvider) || p.status === 'error'),
      recent: matchesProvider(p, input.lastProvider),
    };
  }).filter(Boolean);
}

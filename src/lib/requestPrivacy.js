// Subscription URLs are bearer credentials. Never put their query values in
// access/error logs, including percent-encoded parameter names.
export function privateRequestUrl(value = '') {
  const input = String(value);
  try {
    const url = new URL(input, 'http://request.invalid');
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(token|key)$/i.test(key)) { url.searchParams.set(key, '[redacted]'); changed = true; }
    }
    if (!changed) return input;
    const prefix = /^https?:\/\//i.test(input) ? url.origin : '';
    return prefix + url.pathname + url.search;
  } catch {
    return input.replace(/([?&](?:token|key)=)[^&#]*/gi, '$1[redacted]');
  }
}

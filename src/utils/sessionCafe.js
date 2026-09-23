const CAFE_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Which cafe a new access token carries (identity-2). The tab's own choice wins while the user can still open it; otherwise the
 * user's default (the last cafe they switched to), otherwise their first cafe, otherwise none. `requested` is untrusted: only a
 * 24-hex string is considered, and it is compared with the live cafeIds, never sent to the database.
 */
const resolveSessionCafeId = (user, requested) => {
  const allowed = (user?.cafeIds || []).map((id) => String(id));
  if (typeof requested === 'string' && CAFE_ID_RE.test(requested)) {
    const wanted = requested.toLowerCase();
    if (allowed.includes(wanted)) return wanted;
  }
  const preferred = user?.activeCafeId ? String(user.activeCafeId) : null;
  if (preferred && allowed.includes(preferred)) return preferred;
  return allowed[0] || null;
};

module.exports = { CAFE_ID_RE, resolveSessionCafeId };

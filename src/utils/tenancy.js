/**
 * The only reader of the request's active cafe (BE-11-T05). Every query that is
 * scoped to a cafe gets its id from here, so the cross-tenant test matrix
 * (BE-12-T02) has one place to reason about, and a filter built with scoped()
 * can never be widened by a cafeId the caller supplied.
 *
 * auth.middleware sets req.user.cafeId from a verified token; this returns it as
 * is (null when absent) and does not throw: rejecting a request without a cafe
 * is the middleware's job (BE-02-T05), not a read helper's.
 */
const activeCafeId = (req) => req?.user?.cafeId ?? null;

const scoped = (req, extra = {}) => ({ ...extra, cafeId: activeCafeId(req) });

module.exports = { activeCafeId, scoped };

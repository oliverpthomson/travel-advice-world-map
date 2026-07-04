"""Lightweight GeoJSON geometry simplification (no dependencies).

Shrinks the published GeoJSON for the web: coordinates are rounded (fewer
JSON digits), consecutive duplicates dropped, and rings simplified with
iterative Douglas-Peucker. Tolerances are in degrees (~111 km per degree),
chosen for visual fidelity at the zoom levels the map actually uses.
"""


def _perp_dist_sq(p, a, b):
    """Squared perpendicular distance of point p from segment a-b (planar)."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    seg = dx * dx + dy * dy
    if seg == 0:
        ex, ey = px - ax, py - ay
        return ex * ex + ey * ey
    t = ((px - ax) * dx + (py - ay) * dy) / seg
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    ex, ey = px - cx, py - cy
    return ex * ex + ey * ey


def _douglas_peucker(points, eps):
    """Iterative Douglas-Peucker on an open point list."""
    n = len(points)
    if n < 3:
        return points[:]
    eps_sq = eps * eps
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        max_d, max_i = -1.0, -1
        a, b = points[lo], points[hi]
        for i in range(lo + 1, hi):
            d = _perp_dist_sq(points[i], a, b)
            if d > max_d:
                max_d, max_i = d, i
        if max_d > eps_sq:
            keep[max_i] = True
            stack.append((lo, max_i))
            stack.append((max_i, hi))
    return [p for p, k in zip(points, keep) if k]


def _simplify_ring(ring, eps, ndigits):
    """Round, dedupe and DP-simplify one closed ring. Returns None if the
    ring degenerates (caller should then keep the original)."""
    pts = []
    for lng, lat in (c[:2] for c in ring):
        p = (round(lng, ndigits), round(lat, ndigits))
        if not pts or p != pts[-1]:
            pts.append(p)
    # re-close after rounding/dedupe
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        return None
    simplified = _douglas_peucker(pts + [pts[0]], eps)
    if len(simplified) < 4:  # closed ring needs >= 3 distinct points
        return None
    return [[p[0], p[1]] for p in simplified]


def simplify_geometry(geometry, eps=0.005, ndigits=4):
    """Simplify a Polygon/MultiPolygon geometry in GeoJSON dict form.
    Rings that would degenerate keep their original (rounded) coordinates.
    Other geometry types pass through untouched."""
    gtype = geometry.get("type")

    def do_poly(rings):
        out = []
        for ri, ring in enumerate(rings):
            s = _simplify_ring(ring, eps, ndigits)
            if s is None:
                if ri == 0:
                    # outer ring must survive: keep rounded original
                    s = [[round(c[0], ndigits), round(c[1], ndigits)] for c in ring]
                else:
                    continue  # tiny hole - drop it
            out.append(s)
        return out

    if gtype == "Polygon":
        return {"type": gtype, "coordinates": do_poly(geometry["coordinates"])}
    if gtype == "MultiPolygon":
        polys = [do_poly(p) for p in geometry["coordinates"]]
        return {"type": gtype, "coordinates": [p for p in polys if p]}
    return geometry

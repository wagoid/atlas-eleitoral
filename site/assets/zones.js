'use strict';
// Áreas aproximadas de zona eleitoral: célula de Voronoi de cada local de votação, recortada pela malha do município.
// O TSE não publica contornos de zona; as células são só uma leitura de proximidade dos locais.
window.ZoneGeometry = (function () {
  function project(lonlat, k) { return {x: lonlat[0] * k, y: lonlat[1]}; }

  function openRing(ring, k) {
    const pts = ring.map(p => project(p, k));
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 1 && first.x === last.x && first.y === last.y) pts.pop();
    return pts;
  }

  function clipHalfPlane(poly, px, py, nx, ny, label) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = (a.x - px) * nx + (a.y - py) * ny, db = (b.x - px) * nx + (b.y - py) * ny;
      if (da <= 0) {
        out.push(a);
        if (db > 0) {
          const t = da / (da - db);
          out.push({x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), e: label});
        }
      } else if (db <= 0) {
        const t = da / (da - db);
        out.push({x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), e: a.e});
      }
    }
    return out;
  }

  function voronoi(sites, box) {
    const n = sites.length;
    const size = Math.max(1e-6, Math.sqrt((box.x1 - box.x0) * (box.y1 - box.y0) / n));
    const grid = new Map();
    const cellOf = p => [Math.floor((p.x - box.x0) / size), Math.floor((p.y - box.y0) / size)];
    sites.forEach((p, i) => {
      const [cx, cy] = cellOf(p);
      const key = cx + ',' + cy;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    });
    const span = Math.ceil(Math.max(box.x1 - box.x0, box.y1 - box.y0) / size) + 1;
    return sites.map((p, i) => {
      let poly = [
        {x: box.x0, y: box.y0, e: -1}, {x: box.x1, y: box.y0, e: -1},
        {x: box.x1, y: box.y1, e: -1}, {x: box.x0, y: box.y1, e: -1},
      ];
      const [cx, cy] = cellOf(p);
      for (let r = 0; r <= span; r++) {
        for (let gx = cx - r; gx <= cx + r; gx++) {
          for (let gy = cy - r; gy <= cy + r; gy++) {
            if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
            for (const j of grid.get(gx + ',' + gy) || []) {
              const q = sites[j];
              const nx = q.x - p.x, ny = q.y - p.y;
              if (j === i || (nx === 0 && ny === 0)) continue;
              poly = clipHalfPlane(poly, (p.x + q.x) / 2, (p.y + q.y) / 2, nx, ny, j);
            }
          }
        }
        const reach = Math.max(...poly.map(v => Math.hypot(v.x - p.x, v.y - p.y)));
        if (r * size >= 2 * reach) break;
      }
      return poly;
    });
  }

  function insideRings(x, y, rings) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    return inside;
  }

  function clipByConvex(subject, clip) {
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      const input = out;
      out = [];
      const side = p => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      for (let k = 0; k < input.length; k++) {
        const p = input[k], q = input[(k + 1) % input.length];
        const sp = side(p), sq = side(q);
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) {
          const t = sp / (sp - sq);
          out.push({x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y)});
        }
      }
    }
    return out.length >= 3 ? out : [];
  }

  function edgesOf(rings) {
    const edges = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        edges.push({a, b, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y)});
      }
    }
    return edges;
  }

  function segmentInside(a, b, polygons, edges) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const ts = [0, 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    for (const e of edges) {
      if (e.x1 < x0 || e.x0 > x1 || e.y1 < y0 || e.y0 > y1) continue;
      const ex = e.b.x - e.a.x, ey = e.b.y - e.a.y;
      const den = dx * ey - dy * ex;
      if (den === 0) continue;
      const t = ((e.a.x - a.x) * ey - (e.a.y - a.y) * ex) / den;
      const u = ((e.a.x - a.x) * dy - (e.a.y - a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((p, q) => p - q);
    const pieces = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const tm = (ts[i] + ts[i + 1]) / 2;
      const x = a.x + tm * dx, y = a.y + tm * dy;
      if (polygons.some(rings => insideRings(x, y, rings))) {
        pieces.push([{x: a.x + ts[i] * dx, y: a.y + ts[i] * dy}, {x: a.x + ts[i + 1] * dx, y: a.y + ts[i + 1] * dy}]);
      }
    }
    return pieces;
  }

  // lonlats: [[lon, lat]]; multipolygon: coordenadas GeoJSON do município; zones: zona de cada local.
  function build(lonlats, multipolygon, zones) {
    const lat0 = lonlats.reduce((a, p) => a + p[1], 0) / lonlats.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    const sites = lonlats.map(p => project(p, k));
    const polygons = multipolygon.map(poly => poly.map(ring => openRing(ring, k)).filter(r => r.length >= 3)).filter(p => p.length);
    const all = [...sites, ...polygons.flat(2)];
    const pad = 0.01;
    const box = {
      x0: Math.min(...all.map(p => p.x)) - pad, x1: Math.max(...all.map(p => p.x)) + pad,
      y0: Math.min(...all.map(p => p.y)) - pad, y1: Math.max(...all.map(p => p.y)) + pad,
    };
    const raw = voronoi(sites, box);
    const polyEdges = polygons.map(edgesOf);
    const allEdges = polyEdges.flat();
    const unproject = p => [p.y, p.x / k];

    const cells = raw.map((cell, i) => {
      const bx0 = Math.min(...cell.map(v => v.x)), bx1 = Math.max(...cell.map(v => v.x));
      const by0 = Math.min(...cell.map(v => v.y)), by1 = Math.max(...cell.map(v => v.y));
      const pieces = [];
      polygons.forEach((rings, pi) => {
        const crossing = polyEdges[pi].some(e => !(e.x1 < bx0 || e.x0 > bx1 || e.y1 < by0 || e.y0 > by1));
        if (!crossing) {
          if (insideRings(sites[i].x, sites[i].y, rings)) pieces.push([cell]);
          return;
        }
        const outer = clipByConvex(rings[0], cell);
        if (!outer.length) return;
        pieces.push([outer, ...rings.slice(1).map(h => clipByConvex(h, cell)).filter(h => h.length)]);
      });
      return pieces.length ? pieces.map(rings => rings.map(r => r.map(unproject))) : null;
    });

    const boundaries = [];
    raw.forEach((cell, i) => {
      for (let v = 0; v < cell.length; v++) {
        const j = cell[v].e;
        if (j <= i || zones[i] === zones[j]) continue;
        for (const [a, b] of segmentInside(cell[v], cell[(v + 1) % cell.length], polygons, allEdges)) {
          boundaries.push([unproject(a), unproject(b)]);
        }
      }
    });
    return {cells, boundaries};
  }

  return {build};
})();

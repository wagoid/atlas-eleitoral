import json
import math
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

KM_PER_DEGREE = 111.32


@dataclass
class Area:
    code: str
    polygons: list[list[list[tuple[float, float]]]]
    bbox: tuple[float, float, float, float]

    def contains(self, lon: float, lat: float) -> bool:
        min_lon, min_lat, max_lon, max_lat = self.bbox
        if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
            return False
        return any(_in_rings(lon, lat, rings) for rings in self.polygons)

    def distance_km(self, lon: float, lat: float) -> float:
        scale = math.cos(math.radians(lat))
        best = math.inf
        for rings in self.polygons:
            for ring in rings:
                for (x1, y1), (x2, y2) in pairwise(ring):
                    best = min(best, _segment_distance(lon, lat, x1, y1, x2, y2, scale))
        return best * KM_PER_DEGREE


def _in_rings(lon: float, lat: float, rings: list[list[tuple[float, float]]]) -> bool:
    inside = False
    for ring in rings:
        for (x1, y1), (x2, y2) in pairwise(ring):
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def _segment_distance(px: float, py: float, x1: float, y1: float, x2: float, y2: float, scale: float) -> float:
    ax, bx, qx = x1 * scale, x2 * scale, px * scale
    dx, dy = bx - ax, y2 - y1
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((qx - ax) * dx + (py - y1) * dy) / length))
    return math.hypot(qx - (ax + t * dx), py - (y1 + t * dy))


def _polygons(geometry: dict) -> list:
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError(f"geometria não suportada: {geometry['type']}")


def load_areas(path: Path) -> dict[str, Area]:
    collection = json.loads(path.read_text(encoding="utf-8"))
    areas = {}
    for feature in collection["features"]:
        polygons = [
            [[(float(x), float(y)) for x, y in ring] for ring in polygon] for polygon in _polygons(feature["geometry"])
        ]
        xs = [x for polygon in polygons for ring in polygon for x, _ in ring]
        ys = [y for polygon in polygons for ring in polygon for _, y in ring]
        code = str(feature["properties"]["codarea"])
        areas[code] = Area(code, polygons, (min(xs), min(ys), max(xs), max(ys)))
    return areas


def compact_collection(path: Path, properties: dict[str, dict], digits: int = 4) -> dict:
    collection = json.loads(path.read_text(encoding="utf-8"))
    features = []
    for feature in collection["features"]:
        code = str(feature["properties"]["codarea"])
        if code not in properties:
            continue
        polygons = []
        for polygon in _polygons(feature["geometry"]):
            rings = []
            for ring in polygon:
                rounded = []
                for x, y in ring:
                    point = [round(x, digits), round(y, digits)]
                    if not rounded or rounded[-1] != point:
                        rounded.append(point)
                if len(rounded) >= 4:
                    rings.append(rounded)
            if rings:
                polygons.append(rings)
        geometry = {"type": "MultiPolygon", "coordinates": polygons}
        features.append({"type": "Feature", "properties": properties[code], "geometry": geometry})
    return {"type": "FeatureCollection", "features": features}

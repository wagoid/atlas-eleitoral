import json
import zipfile
from pathlib import Path

import pytest

from pipeline import geo, tse
from pipeline.build import (
    ANNULLED,
    BLANK_SLOT,
    NULL_SLOT,
    TECHNICAL,
    VALID,
    VoteClassifier,
    office_values,
    place_status,
)

DATA = Path(__file__).resolve().parents[1] / "site" / "data"
SQUARE_WITH_HOLE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"codarea": "1"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
                ],
            },
        }
    ],
}


@pytest.fixture
def square(tmp_path: Path) -> geo.Area:
    path = tmp_path / "mesh.json"
    path.write_text(json.dumps(SQUARE_WITH_HOLE))
    return geo.load_areas(path)["1"]


def test_point_in_polygon_respects_holes(square):
    assert square.contains(1, 1)
    assert not square.contains(5, 5)
    assert not square.contains(11, 5)


def test_distance_to_boundary_in_km(square):
    assert square.distance_km(10.01, 5) == pytest.approx(1.113, rel=0.01)


def test_place_status_uses_border_tolerance(square):
    areas = {"1": square}
    assert place_status(areas, None, "1", 1, 1) == 1
    assert place_status(areas, None, "1", 5, 10.005) == 1
    assert place_status(areas, None, "1", 5, 12) == 2
    assert place_status(areas, None, "1", None, None) == 0
    assert place_status(areas, None, "unknown", 1, 1) == 0


def test_coordinate_parses_comma_and_rejects_sentinels():
    assert tse.coordinate("-18,9188041", tse.LAT_RANGE) == pytest.approx(-18.9188041)
    assert tse.coordinate("-1", tse.LAT_RANGE) is None
    assert tse.coordinate("", tse.LAT_RANGE) is None
    assert tse.coordinate("45,0", tse.LAT_RANGE) is None


def test_vote_classifier_follows_official_feed():
    feed = tse.Feed(5, 2, "", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    feed.candidates = [
        tse.Candidate("800", "UP", "80", "UP", True, 10),
        tse.Candidate("123", "SUB JUDICE", "12", "X", False, 5),
    ]
    feed.party_valid = {"80": True}
    classifier = VoteClassifier(feed)
    assert classifier.slot("800") == VALID
    assert classifier.slot("80") == VALID
    assert classifier.slot("95") == BLANK_SLOT
    assert classifier.slot("96") == NULL_SLOT
    assert classifier.slot("123") == ANNULLED
    assert classifier.slot("28") == TECHNICAL


def test_office_values_fold_technical_into_nulls():
    assert office_values([100, 5, 7, 3, 2], [9]) == [100, 5, 9, 3, 9]


def test_iter_votes_reads_fast_path_and_quoted_semicolons(tmp_path: Path):
    header = (
        '"SG_UF";"NM_MUNICIPIO";"CD_MUNICIPIO";"NR_ZONA";"NR_SECAO";"CD_CARGO";"DS_CARGO";"NR_VOTAVEL";"QT_VOTOS"\n'
    )
    rows = '"MG";"UBERLÂNDIA";54038;278;7;1;"Presidente";80;3\n"MG";"A;B";54038;278;8;1;"Presidente";13;9\n'
    archive = tmp_path / "votes.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("votacao.csv", (header + rows).encode("latin1"))
    assert list(tse.iter_votes(archive)) == [
        ("MG", ("54038", 278, 7), 1, "80", 3),
        ("MG", ("54038", 278, 8), 1, "13", 9),
    ]


@pytest.mark.skipif(not (DATA / "mun" / "54038.json").exists(), reason="rode `python -m pipeline build` antes")
def test_uberlandia_matches_reference_atlas():
    data = json.loads((DATA / "mun" / "54038.json").read_text())
    totals = {c: sum(s[3 + i] for s in data["sections"]) for i, c in enumerate(data["cols"])}
    reference = {
        "aptos": 540033,
        "comp": 429516,
        "abst": 110517,
        "1.valid": 409921,
        "1.blank": 7763,
        "1.null": 11832,
        "1.13": 163879,
        "1.22": 206793,
        "1.80": 399,
    }
    assert {k: totals[k] for k in reference} == reference
    assert (len(data["places"]), len(data["sections"]), data["secondary"]) == (137, 1703, 34)


@pytest.mark.skipif(not (DATA / "meta.json").exists(), reason="rode `python -m pipeline build` antes")
def test_build_reconciles_with_official_totals():
    checks = json.loads((DATA / "meta.json").read_text())["checks"]
    assert checks["failed"] == 0
    assert checks["invariant_violations"] == {}
    assert checks["comparisons"] > 900

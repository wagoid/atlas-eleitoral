from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from pipeline import tse
from pipeline.sources import DISTRICT_DEPUTY, ROUND, STATE_DEPUTY, UP_NUMBER

OFFICES = (1, 3, 5, 6, STATE_DEPUTY)

ZoneKey = tuple[str, int]


def _office(value: str) -> int:
    office = int(value)
    return STATE_DEPUTY if office == DISTRICT_DEPUTY else office


@dataclass
class Previous:
    """Votos válidos da UP e válidos de cada cargo no 1º turno anterior, por município e zona."""

    up: dict[ZoneKey, dict[int, int]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    valid: dict[ZoneKey, dict[int, int]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    party_valid: dict[ZoneKey, dict[int, int]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    uf_of: dict[str, str] = field(default_factory=dict)
    candidacy: dict[str, set[int]] = field(default_factory=lambda: defaultdict(set))

    def zones(self, mun: str) -> list[int]:
        return sorted(zone for m, zone in self.valid if m == mun)

    def columns(self) -> list[str]:
        return [c for o in OFFICES for c in (f"{o}.up22", f"{o}.valid22")]

    def values(self, keys: list[ZoneKey]) -> list[int | None]:
        uf = self.uf_of.get(keys[0][0]) if keys else None
        result = []
        for office in OFFICES:
            has_data = any(office in self.valid.get(k, {}) for k in keys)
            valid = sum(self.valid[k].get(office, 0) for k in keys if k in self.valid)
            up = sum(self.up[k].get(office, 0) for k in keys if k in self.up)
            result.append(up if has_data and office in self.candidacy.get(uf, set()) else None)
            result.append(valid if has_data else None)
        return result


def read_previous(cache: Path) -> Previous:
    previous = Previous()
    party_archive = cache / "votacao_partido_munzona_previous.zip"
    member = next(m for m in tse.members(party_archive) if m.endswith("_BRASIL.csv"))
    for row in tse.iter_csv(party_archive, member):
        if row["NR_TURNO"] != str(ROUND):
            continue
        key = (tse.municipality_code(row["CD_MUNICIPIO"]), int(row["NR_ZONA"]))
        office = _office(row["CD_CARGO"])
        votes = int(row["QT_TOTAL_VOTOS_LEG_VALIDOS"]) + int(row["QT_VOTOS_NOMINAIS_VALIDOS"])
        previous.party_valid[key][office] += votes
        previous.uf_of[key[0]] = row["SG_UF"]
        if row["NR_PARTIDO"] == UP_NUMBER:
            previous.up[key][office] += votes
            if votes:
                previous.candidacy[row["SG_UF"]].add(office)
    detail_archive = cache / "detalhe_votacao_munzona_previous.zip"
    member = next(m for m in tse.members(detail_archive) if m.endswith("_BRASIL.csv"))
    for row in tse.iter_csv(detail_archive, member):
        if row["NR_TURNO"] != str(ROUND):
            continue
        key = (tse.municipality_code(row["CD_MUNICIPIO"]), int(row["NR_ZONA"]))
        previous.valid[key][_office(row["CD_CARGO"])] += int(row["QT_TOTAL_VOTOS_VALIDOS"])
        previous.uf_of[key[0]] = row["SG_UF"]
    return previous

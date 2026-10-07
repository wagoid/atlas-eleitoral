import csv
import io
import json
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

LAT_RANGE = (-34.0, 6.0)
LON_RANGE = (-74.5, -28.5)

SectionKey = tuple[str, int, int]


def municipality_code(value: str) -> str:
    return f"{int(value):05d}"


def section_key(row: dict) -> SectionKey:
    return municipality_code(row["CD_MUNICIPIO"]), int(row["NR_ZONA"]), int(row["NR_SECAO"])


def coordinate(value: str, bounds: tuple[float, float]) -> float | None:
    value = value.strip().replace(",", ".")
    if not value or value == "-1":
        return None
    number = float(value)
    return number if bounds[0] <= number <= bounds[1] else None


def iter_csv(archive: Path, member: str) -> Iterator[dict]:
    with zipfile.ZipFile(archive) as zf, zf.open(member) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="latin1", newline=""), delimiter=";")


def members(archive: Path) -> list[str]:
    with zipfile.ZipFile(archive) as zf:
        return [name for name in zf.namelist() if name.lower().endswith(".csv")]


VOTE_FIELDS = ("SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_SECAO", "CD_CARGO", "NR_VOTAVEL", "QT_VOTOS")


def iter_votes(archive: Path) -> Iterator[tuple[str, SectionKey, int, str, int]]:
    """Lê a votação por seção dividindo bytes por ';' (64 milhões de linhas); linhas atípicas caem no parser CSV."""
    with zipfile.ZipFile(archive) as zf, zf.open(members(archive)[0]) as raw:
        header = [h.strip('"') for h in raw.readline().decode("latin1").strip().split(";")]
        positions = [header.index(name) for name in VOTE_FIELDS]
        limit = max(positions) + 1
        uf_i, mun_i, zone_i, section_i, office_i, number_i, votes_i = positions
        for line in raw:
            fields = line.split(b";", limit)
            try:
                yield (
                    fields[uf_i].strip(b'"').decode(),
                    (f"{int(fields[mun_i]):05d}", int(fields[zone_i]), int(fields[section_i])),
                    int(fields[office_i]),
                    fields[number_i].strip(b'"').decode(),
                    int(fields[votes_i]),
                )
            except (ValueError, IndexError):
                row = dict(zip(header, next(csv.reader([line.decode("latin1")], delimiter=";"))))
                yield (row["SG_UF"], section_key(row), int(row["CD_CARGO"]), row["NR_VOTAVEL"], int(row["QT_VOTOS"]))


@dataclass
class Candidate:
    number: str
    name: str
    party_number: str
    party: str
    valid: bool
    votes: int


@dataclass
class Feed:
    office: int
    votes_per_voter: int
    generated: str
    electorate: int
    turnout: int
    abstentions: int
    valid: int
    blank: int
    null_total: int
    null_technical: int
    annulled: int
    sections_totalized: int
    sections_installed: int
    candidates: list[Candidate] = field(default_factory=list)
    party_votes: dict[str, int] = field(default_factory=dict)
    party_names: dict[str, str] = field(default_factory=dict)
    party_valid: dict[str, bool] = field(default_factory=dict)

    def classify(self) -> tuple[set[str], set[str]]:
        valid = {c.number for c in self.candidates if c.valid}
        annulled = {c.number for c in self.candidates if not c.valid}
        for number, ok in self.party_valid.items():
            (valid if ok else annulled).add(number)
        return valid, annulled


def _int(value) -> int:
    return int(value or 0)


def load_feed(path: Path) -> Feed:
    data = json.loads(path.read_text(encoding="utf-8"))
    office = data["carg"][0]
    votes = data["v"]
    feed = Feed(
        office=int(office["cd"]),
        votes_per_voter=_int(office.get("nv")) or 1,
        generated=f"{data['dg']} {data['hg']}",
        electorate=_int(data["e"]["te"]),
        turnout=_int(data["e"]["c"]),
        abstentions=_int(data["e"]["a"]),
        valid=_int(votes["vv"]),
        blank=_int(votes["vb"]),
        null_total=_int(votes["tvn"]),
        null_technical=_int(votes.get("vnt")),
        annulled=_int(votes.get("van")) + _int(votes.get("vansj")),
        sections_totalized=_int(data["s"]["st"]),
        sections_installed=_int(data["s"].get("si")),
    )
    for group in office["agr"]:
        for party in group["par"]:
            feed.party_names[party["n"]] = party["sg"]
            if party.get("tvtl") is not None:
                feed.party_votes[party["n"]] = _int(party["tvtl"])
                feed.party_valid[party["n"]] = party.get("dvt", "Válido").startswith("Válido")
            for cand in party.get("cand", []):
                feed.candidates.append(
                    Candidate(
                        number=cand["n"],
                        name=cand.get("nmu") or cand["nm"],
                        party_number=party["n"],
                        party=party["sg"],
                        valid=cand.get("dvt", "").startswith("Válido"),
                        votes=_int(cand.get("vap")),
                    )
                )
    return feed


def tse_to_ibge(config_path: Path) -> dict[str, tuple[str, str, str]]:
    data = json.loads(config_path.read_text(encoding="utf-8"))
    mapping = {}
    for state in data["abr"]:
        for city in state["mu"]:
            mapping[municipality_code(city["cd"])] = (state["cd"].upper(), city.get("cdi") or "", city["nm"])
    return mapping

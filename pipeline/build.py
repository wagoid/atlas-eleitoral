import json
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from pipeline import geo, previous, tse
from pipeline.sources import (
    DISTRICT_DEPUTY,
    ELECTION_YEAR,
    EXTERIOR,
    FEDERAL_DEPUTY,
    FEDERAL_ELECTION,
    GOVERNOR,
    PRESIDENT,
    PREVIOUS_YEAR,
    ROUND,
    SENATOR,
    STATE_DEPUTY,
    STATE_ELECTION,
    STATE_OFFICES,
    UFS,
    UP_NUMBER,
    state_offices_for,
)
from pipeline.validate import Checks

OFFICE_NAMES = {
    PRESIDENT: "Presidente",
    GOVERNOR: "Governador",
    SENATOR: "Senador",
    FEDERAL_DEPUTY: "Deputado Federal",
    STATE_DEPUTY: "Deputado Estadual / Distrital",
}
UF_NAMES = {
    "AC": "Acre",
    "AL": "Alagoas",
    "AM": "Amazonas",
    "AP": "Amapá",
    "BA": "Bahia",
    "CE": "Ceará",
    "DF": "Distrito Federal",
    "ES": "Espírito Santo",
    "GO": "Goiás",
    "MA": "Maranhão",
    "MG": "Minas Gerais",
    "MS": "Mato Grosso do Sul",
    "MT": "Mato Grosso",
    "PA": "Pará",
    "PB": "Paraíba",
    "PE": "Pernambuco",
    "PI": "Piauí",
    "PR": "Paraná",
    "RJ": "Rio de Janeiro",
    "RN": "Rio Grande do Norte",
    "RO": "Rondônia",
    "RR": "Roraima",
    "RS": "Rio Grande do Sul",
    "SC": "Santa Catarina",
    "SE": "Sergipe",
    "SP": "São Paulo",
    "TO": "Tocantins",
    EXTERIOR: "Exterior",
}
BLANK, NULL = "95", "96"
BORDER_TOLERANCE_KM = 1.5
MISSING_MESH = {
    "5101837": "Boa Esperança do Norte (MT), criado em 2024: a API de malhas do IBGE ainda não publica o polígono"
}
PLACE_UNCHECKED, PLACE_OK, PLACE_OUTSIDE, PLACE_OK_UF_ONLY = range(4)
MAJORITARIAN = (PRESIDENT, GOVERNOR, SENATOR)
PRESIDENT_TRACKED = (UP_NUMBER, "13", "22")
LEFT_PARTIES = {
    "13": "PT",
    "65": "PCdoB",
    "43": "PV",
    "50": "PSOL",
    "18": "REDE",
    "21": "PCB",
    "16": "PSTU",
    UP_NUMBER: "UP",
}
PL_NUMBER = "22"
BLOC_OFFICES = (PRESIDENT, GOVERNOR, SENATOR)
VALID, BLANK_SLOT, NULL_SLOT, ANNULLED, TECHNICAL = range(5)


def ui_office(office: int) -> int:
    return STATE_DEPUTY if office == DISTRICT_DEPUTY else office


def votes_per_voter(office: int, feed: tse.Feed) -> int:
    return feed.votes_per_voter if office in MAJORITARIAN else 1


class VoteClassifier:
    """Classifica cada número votado conforme a totalização oficial: válido, branco, nulo de urna, anulado ou nulo técnico."""

    def __init__(self, feed: tse.Feed) -> None:
        self.valid, self.annulled = feed.classify()

    def slot(self, number: str) -> int:
        if number in self.valid:
            return VALID
        if number == BLANK:
            return BLANK_SLOT
        if number == NULL:
            return NULL_SLOT
        if number in self.annulled:
            return ANNULLED
        return TECHNICAL


def office_columns(office: int, extra: list[str]) -> list[str]:
    return [f"{office}.valid", f"{office}.blank", f"{office}.null", f"{office}.annul", *extra]


def office_values(totals: list[int], extra: list[int]) -> list[int]:
    return [totals[VALID], totals[BLANK_SLOT], totals[NULL_SLOT] + totals[TECHNICAL], totals[ANNULLED], *extra]


@dataclass
class Section:
    aptos: int
    turnout: int
    abstentions: int
    local: int
    local_name: str
    local_address: str
    municipality: str
    installed: bool
    detail: tuple[int, int, int]


def bloc_group(party_number: str) -> str | None:
    if party_number == UP_NUMBER:
        return "up"
    if party_number in LEFT_PARTIES:
        return "left"
    if party_number == PL_NUMBER:
        return "pl"
    return None


def bloc_totals(votes: dict[str, int], groups: dict[str, str]) -> list[int]:
    left = sum(v for n, v in votes.items() if groups.get(n) in ("up", "left"))
    pl = sum(v for n, v in votes.items() if groups.get(n) == "pl")
    return [left, pl]


def occupancy_keys(office: int) -> list[str]:
    if office == PRESIDENT:
        return [f"1.{n}" for n in PRESIDENT_TRACKED] + ["1.left"]
    if office in BLOC_OFFICES:
        return [f"{office}.up", f"{office}.left", f"{office}.pl"]
    return [f"{office}.up"]


def occupancy_column(key: str) -> str:
    return f"{key}#s"


@dataclass
class President:
    candidates: list[tse.Candidate]
    classifier: VoteClassifier
    groups: dict[str, str]
    votes: dict[str, dict[tse.SectionKey, list[int]]] = field(default_factory=lambda: defaultdict(dict))
    sections: dict[str, dict[tse.SectionKey, Section]] = field(default_factory=lambda: defaultdict(dict))

    def columns(self) -> list[str]:
        return office_columns(PRESIDENT, ["1.nullt", "1.left", "1.pl", *(f"1.{c.number}" for c in self.candidates)])

    def values(self, uf: str, key: tse.SectionKey) -> list[int]:
        slots, by_candidate = self.votes[uf].get(key) or ([0] * 5, {})
        tracked = [by_candidate.get(c.number, 0) for c in self.candidates]
        return office_values(slots, [slots[TECHNICAL], *bloc_totals(by_candidate, self.groups), *tracked])


def read_president(cache: Path, feed: tse.Feed) -> President:
    tracked = sorted(
        (c for c in feed.candidates if c.valid and c.number in PRESIDENT_TRACKED),
        key=lambda c: PRESIDENT_TRACKED.index(c.number),
    )
    groups = {c.number: g for c in feed.candidates if c.valid and (g := bloc_group(c.party_number))}
    president = President(tracked, VoteClassifier(feed), groups)
    for uf, key, _, number, votes in tse.iter_votes(cache / "votacao_secao_BR.zip"):
        entry = president.votes[uf].get(key)
        if entry is None:
            entry = president.votes[uf][key] = ([0] * 5, {})
        slot = president.classifier.slot(number)
        entry[0][slot] += votes
        if slot == VALID:
            entry[1][number] = entry[1].get(number, 0) + votes
    archive = cache / "detalhe_votacao_secao.zip"
    member = next(m for m in tse.members(archive) if m.endswith("_BR.csv"))
    for row in tse.iter_csv(archive, member):
        president.sections[row["SG_UF"]][tse.section_key(row)] = Section(
            aptos=int(row["QT_APTOS"]),
            turnout=int(row["QT_COMPARECIMENTO"]),
            abstentions=int(row["QT_ABSTENCOES"]),
            local=int(row["NR_LOCAL_VOTACAO"]),
            local_name=row["NM_LOCAL_VOTACAO"].strip(),
            local_address=row["DS_LOCAL_VOTACAO_ENDERECO"].strip(),
            municipality=row["NM_MUNICIPIO"],
            installed=row["ST_SECAO_INSTALADA"] == "Sim",
            detail=(
                int(row["QT_VOTOS_NOMINAIS"]) + int(row["QT_VOTOS_LEGENDA"]),
                int(row["QT_VOTOS_BRANCOS"]),
                int(row["QT_VOTOS_NULOS"]),
            ),
        )
    return president


@dataclass
class Votable:
    office: int
    number: str
    name: str
    party: str
    kind: str
    group: str


def tracked_votables(feeds: dict[int, tse.Feed]) -> list[Votable]:
    """UP em todos os cargos; nos cargos com blocos, também as candidaturas dos partidos do campo da esquerda e do PL."""
    result = []
    for office, feed in feeds.items():
        label = ui_office(office)
        if office not in MAJORITARIAN and feed.party_valid.get(UP_NUMBER):
            result.append(Votable(label, UP_NUMBER, "Legenda UP (80)", "UP", "legenda", "up"))
        for cand in sorted(feed.candidates, key=lambda c: -c.votes):
            group = bloc_group(cand.party_number)
            if not cand.valid or group is None or (group != "up" and label not in BLOC_OFFICES):
                continue
            result.append(Votable(label, cand.number, cand.name, cand.party, "candidatura", group))
    return result


def state_office_extra(office: int, votables: list[Votable]) -> list[str]:
    blocs = [f"{office}.left", f"{office}.pl"] if office in BLOC_OFFICES else []
    return [f"{office}.up", *blocs, *(f"{office}.{v.number}" for v in votables if v.office == office)]


def state_office_values(office: int, votables: list[Votable], section_votes: dict[tuple[int, str], int]) -> list[int]:
    mine = [v for v in votables if v.office == office]
    votes = [section_votes.get((office, v.number), 0) for v in mine]
    up = sum(n for v, n in zip(mine, votes) if v.group == "up")
    blocs = []
    if office in BLOC_OFFICES:
        blocs = bloc_totals({v.number: n for v, n in zip(mine, votes)}, {v.number: v.group for v in mine})
    return [up, *blocs, *votes]


@dataclass
class StateVotes:
    slots: dict[tse.SectionKey, dict[int, list[int]]]
    up: dict[tse.SectionKey, dict[tuple[int, str], int]]
    turnout: dict[tse.SectionKey, dict[int, int]]


def read_state(cache: Path, uf: str, feeds: dict[int, tse.Feed], votables: list[Votable]) -> StateVotes:
    classifiers = {office: VoteClassifier(feed) for office, feed in feeds.items()}
    wanted = {(v.office, v.number) for v in votables}
    result = StateVotes(defaultdict(dict), defaultdict(dict), defaultdict(dict))
    for _, key, office, number, votes in tse.iter_votes(cache / f"votacao_secao_{uf}.zip"):
        classifier = classifiers.get(office)
        if classifier is None:
            continue
        label = ui_office(office)
        slots = result.slots[key].get(label)
        if slots is None:
            slots = result.slots[key][label] = [0] * 5
        slots[classifier.slot(number)] += votes
        if (label, number) in wanted:
            bucket = result.up[key]
            bucket[(label, number)] = bucket.get((label, number), 0) + votes
    archive = cache / "detalhe_votacao_secao.zip"
    member = next(m for m in tse.members(archive) if m.endswith(f"_{uf}.csv"))
    for row in tse.iter_csv(archive, member):
        office = int(row["CD_CARGO"])
        if office in feeds:
            result.turnout[tse.section_key(row)][ui_office(office)] = int(row["QT_COMPARECIMENTO"])
    return result


def read_places(cache: Path, uf: str):
    archive = cache / "eleitorado_local_votacao.zip"
    member = next(m for m in tse.members(archive) if m.endswith(f"_{uf}.csv"))
    places = {}
    secondary: dict[str, int] = defaultdict(int)
    for row in tse.iter_csv(archive, member):
        if row["NR_TURNO"] != str(ROUND):
            continue
        mun = tse.municipality_code(row["CD_MUNICIPIO"])
        if row["CD_TIPO_SECAO_AGREGADA"] not in ("1", ""):
            secondary[mun] += 1
        key = (mun, int(row["NR_ZONA"]), int(row["NR_LOCAL_VOTACAO"]))
        if key not in places:
            places[key] = (
                row["NM_LOCAL_VOTACAO"].strip(),
                row["DS_ENDERECO"].strip(),
                row["NM_BAIRRO"].strip(),
                tse.coordinate(row["NR_LATITUDE"], tse.LAT_RANGE),
                tse.coordinate(row["NR_LONGITUDE"], tse.LON_RANGE),
            )
    return places, secondary


def _inside(area: geo.Area, lat: float, lon: float) -> bool:
    return area.contains(lon, lat) or area.distance_km(lon, lat) <= BORDER_TOLERANCE_KM


def place_status(
    areas: dict[str, geo.Area], state_area: geo.Area | None, ibge: str, lat: float | None, lon: float | None
) -> int:
    if lat is None or lon is None:
        return PLACE_UNCHECKED
    area = areas.get(ibge)
    if area is not None:
        return PLACE_OK if _inside(area, lat, lon) else PLACE_OUTSIDE
    if state_area is not None and ibge in MISSING_MESH:
        return PLACE_OK_UF_ONLY if _inside(state_area, lat, lon) else PLACE_OUTSIDE
    return PLACE_UNCHECKED


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build(cache: Path, out: Path) -> Checks:
    manifest = json.loads((cache / "manifest.json").read_text())
    if out.exists():
        shutil.rmtree(out)
    checks = Checks()
    national_feed = tse.load_feed(cache / "feed_br_c0001.json")
    print("lendo Presidente (Brasil)", flush=True)
    president = read_president(cache, national_feed)
    mapping = tse.tse_to_ibge(cache / "mun-cm.json")
    state_areas = geo.load_areas(cache / "geo_br.json")

    br_columns = ["aptos", "comp", "abst", *president.columns()]
    for office in STATE_OFFICES:
        blocs = [f"{office}.left", f"{office}.pl"] if office in BLOC_OFFICES else []
        br_columns += office_columns(office, [f"{office}.up", *blocs])
    occupancy = [occupancy_column(k) for o in OFFICE_NAMES for k in occupancy_keys(o)]
    br_columns += occupancy
    print(f"lendo {PREVIOUS_YEAR}", flush=True)
    before = previous.read_previous(cache)
    checks.previous_consistency(before)
    previous_columns = before.columns()
    br_columns += previous_columns
    br_rows = []
    votables_meta: dict[str, dict[str, list[dict]]] = {}
    coverage: dict[str, int] = defaultdict(int)
    per_voter = {PRESIDENT: votes_per_voter(PRESIDENT, national_feed)}

    for uf in [*UFS, EXTERIOR]:
        print(f"processando {uf}", flush=True)
        uf_feeds = {PRESIDENT: tse.load_feed(cache / f"feed_{uf}_c0001.json")}
        offices = state_offices_for(uf) if uf != EXTERIOR else []
        state_feeds = {office: tse.load_feed(cache / f"feed_{uf}_c{office:04d}.json") for office in offices}
        uf_feeds.update(state_feeds)
        for office, feed in state_feeds.items():
            per_voter[ui_office(office)] = votes_per_voter(office, feed)
        votables = tracked_votables(state_feeds)
        state = read_state(cache, uf, state_feeds, votables) if offices else StateVotes({}, {}, {})
        places, secondary = read_places(cache, uf)
        areas = geo.load_areas(cache / f"geo_{uf}.json") if uf != EXTERIOR else {}
        labels = [ui_office(o) for o in offices]
        votables_meta[uf] = {
            str(o): [
                {"n": v.number, "name": v.name, "party": v.party, "kind": v.kind, "group": v.group}
                for v in votables
                if v.office == o
            ]
            for o in labels
        }

        columns = ["aptos", "comp", "abst", *president.columns()]
        for office in labels:
            columns += office_columns(office, state_office_extra(office, votables))
        occupancy_keys_uf = [k for o in [PRESIDENT, *labels] for k in occupancy_keys(o)]
        occupancy_index = [columns.index(k) for k in occupancy_keys_uf]
        uf_columns = columns + [occupancy_column(k) for k in occupancy_keys_uf]

        by_mun: dict[str, list[tse.SectionKey]] = defaultdict(list)
        for key in president.sections[uf]:
            by_mun[key[0]].append(key)

        mun_rows = []
        geo_properties = {}
        uf_totals = [0] * len(uf_columns)
        for mun in sorted(by_mun, key=lambda m: president.sections[uf][by_mun[m][0]].municipality):
            _, ibge, _ = mapping.get(mun, (uf, "", ""))
            keys = sorted(by_mun[mun])
            name = president.sections[uf][keys[0]].municipality
            place_index: dict[tuple[int, int], int] = {}
            place_rows = []
            section_rows = []
            totals = [0] * len(columns)
            occupied = [0] * len(occupancy_index)
            for key in keys:
                section = president.sections[uf][key]
                place_key = (key[1], section.local)
                if place_key not in place_index:
                    record = places.get((mun, key[1], section.local)) or (
                        section.local_name,
                        section.local_address,
                        "",
                        None,
                        None,
                    )
                    status = place_status(areas, state_areas.get(ibge[:2]), ibge, record[3], record[4])
                    coverage[f"places_status_{status}"] += 1
                    place_index[place_key] = len(place_rows)
                    lat = round(record[3], 6) if record[3] is not None else None
                    lon = round(record[4], 6) if record[4] is not None else None
                    place_rows.append([key[1], section.local, record[0], record[1], record[2], lat, lon, status])
                values = [section.aptos, section.turnout, section.abstentions, *president.values(uf, key)]
                checks.section_president(uf, key, section, values)
                for office in labels:
                    slots = state.slots.get(key, {}).get(office, [0] * 5)
                    values += office_values(slots, state_office_values(office, votables, state.up.get(key, {})))
                    office_turnout = state.turnout.get(key, {}).get(office)
                    checks.section_state(
                        uf, key, office, section.turnout, office_turnout, sum(slots), per_voter[office]
                    )
                section_rows.append([key[1], key[2], place_index[place_key], *values])
                totals = [a + b for a, b in zip(totals, values)]
                occupied = [n + (values[i] > 0) for n, i in zip(occupied, occupancy_index)]
            coverage["sections"] += len(keys)
            coverage["sections_not_installed"] += sum(1 for k in keys if not president.sections[uf][k].installed)
            coverage["places"] += len(place_rows)
            coverage["secondary"] += secondary.get(mun, 0)
            zones_before = [(mun, z) for z in before.zones(mun)]
            write_json(
                out / "mun" / f"{mun}.json",
                {
                    "tse": mun,
                    "ibge": ibge,
                    "name": name,
                    "uf": uf,
                    "cols": columns,
                    "secondary": secondary.get(mun, 0),
                    "previous": {
                        "cols": previous_columns,
                        "total": before.values(zones_before),
                        "zones": {str(z): before.values([(mun, z)]) for _, z in zones_before},
                    },
                    "places": place_rows,
                    "sections": section_rows,
                },
            )
            mapped = sum(1 for p in place_rows if p[7] in (PLACE_OK, PLACE_OK_UF_ONLY))
            mun_rows.append(
                [mun, ibge, name, len(place_rows), len(keys), mapped, *totals, *occupied, *before.values(zones_before)]
            )
            uf_totals = [a + b for a, b in zip(uf_totals, totals + occupied)]
            if ibge:
                geo_properties[ibge] = {"tse": mun, "name": name}

        uf_map = dict(zip(uf_columns, uf_totals))
        uf_before = [k for k in before.valid if before.uf_of.get(k[0]) == uf]
        uf_map.update(zip(previous_columns, before.values(uf_before)))
        checks.previous_zones({mun: {k[1] for k in keys} for mun, keys in by_mun.items()}, before)
        checks.uf_feeds(uf, uf_feeds, uf_map, votables, len(president.sections[uf]))
        checks.uf_blocs(uf, uf_feeds, uf_map, LEFT_PARTIES, PL_NUMBER, BLOC_OFFICES)
        write_json(out / "uf" / f"{uf}.json", {"uf": uf, "cols": uf_columns + previous_columns, "rows": mun_rows})
        if areas:
            write_json(out / "geo" / f"{uf}.json", geo.compact_collection(cache / f"geo_{uf}.json", geo_properties))
            checks.geo_coverage(uf, geo_properties, areas, MISSING_MESH)
        br_rows.append(
            [
                uf,
                UF_NAMES[uf],
                len(mun_rows),
                sum(r[3] for r in mun_rows),
                sum(r[4] for r in mun_rows),
                *[uf_map.get(c) for c in br_columns],
            ]
        )

    br_totals = {c: sum(r[5 + i] or 0 for r in br_rows) for i, c in enumerate(br_columns)}
    checks.national(national_feed, br_totals, sum(len(s) for s in president.sections.values()))
    checks.national_blocs(national_feed, br_totals, LEFT_PARTIES, PL_NUMBER)
    checks.previous_national(br_totals)
    uf_codes = {ibge[:2]: {"uf": uf, "name": UF_NAMES[uf]} for uf, ibge, _ in mapping.values() if ibge}
    write_json(out / "geo" / "br.json", geo.compact_collection(cache / "geo_br.json", uf_codes, digits=3))
    write_json(out / "br.json", {"cols": br_columns, "rows": br_rows})

    meta = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "election": {
            "year": ELECTION_YEAR,
            "round": ROUND,
            "date": "04/10/2026",
            "federal": FEDERAL_ELECTION,
            "state": STATE_ELECTION,
            "feed_generated": national_feed.generated,
        },
        "offices": [
            {
                "code": code,
                "name": name,
                "scope": "blocs" if code in BLOC_OFFICES else "up",
                "votes_per_voter": per_voter.get(code, 1),
            }
            for code, name in OFFICE_NAMES.items()
        ],
        "president": [{"n": c.number, "name": c.name, "party": c.party} for c in president.candidates],
        "votables": votables_meta,
        "blocs": {
            "left": [{"n": n, "party": sg} for n, sg in LEFT_PARTIES.items()],
            "pl": {"n": PL_NUMBER, "party": "PL"},
            "offices": list(BLOC_OFFICES),
        },
        "occupancy": {str(o): occupancy_keys(o) for o in OFFICE_NAMES},
        "previous": {
            "year": PREVIOUS_YEAR,
            "candidacy": {uf: sorted(offices) for uf, offices in sorted(before.candidacy.items())},
        },
        "ufs": [{"uf": uf, "name": UF_NAMES[uf]} for uf in [*UFS, EXTERIOR]],
        "coverage": dict(coverage),
        "missing_mesh": list(MISSING_MESH.values()),
        "sources": [
            {k: v for k, v in item.items() if k != "file"}
            for item in manifest.values()
            if not item["file"].startswith(("feed_", "geo_")) or item["file"] in ("feed_br_c0001.json", "geo_br.json")
        ],
        "source_counts": {
            "feeds": sum(1 for i in manifest.values() if i["file"].startswith("feed_")),
            "meshes": sum(1 for i in manifest.values() if i["file"].startswith("geo_")),
        },
        "checks": checks.summary(),
    }
    write_json(out / "meta.json", meta)
    write_json(out / "reconciliation.json", checks.report())
    return checks

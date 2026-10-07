import json
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from pipeline import geo, tse
from pipeline.sources import (
    DISTRICT_DEPUTY,
    ELECTION_YEAR,
    EXTERIOR,
    FEDERAL_DEPUTY,
    FEDERAL_ELECTION,
    GOVERNOR,
    PRESIDENT,
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


@dataclass
class President:
    candidates: list[tse.Candidate]
    classifier: VoteClassifier
    votes: dict[str, dict[tse.SectionKey, list[int]]] = field(default_factory=lambda: defaultdict(dict))
    sections: dict[str, dict[tse.SectionKey, Section]] = field(default_factory=lambda: defaultdict(dict))

    def columns(self) -> list[str]:
        return office_columns(PRESIDENT, ["1.nullt", *(f"1.{c.number}" for c in self.candidates)])

    def values(self, uf: str, key: tse.SectionKey) -> list[int]:
        slots, by_candidate = self.votes[uf].get(key) or ([0] * 5, {})
        return office_values(slots, [slots[TECHNICAL], *(by_candidate.get(c.number, 0) for c in self.candidates)])


def read_president(cache: Path, feed: tse.Feed) -> President:
    tracked = sorted((c for c in feed.candidates if c.valid and c.number in PRESIDENT_TRACKED), key=lambda c: PRESIDENT_TRACKED.index(c.number))
    president = President(tracked, VoteClassifier(feed))
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
class UpVotable:
    office: int
    number: str
    name: str
    kind: str


def up_votables(feeds: dict[int, tse.Feed]) -> list[UpVotable]:
    result = []
    for office, feed in feeds.items():
        if office not in MAJORITARIAN and feed.party_valid.get(UP_NUMBER):
            result.append(UpVotable(ui_office(office), UP_NUMBER, "Legenda UP (80)", "legenda"))
        for cand in sorted(feed.candidates, key=lambda c: -c.votes):
            if cand.party_number == UP_NUMBER and cand.valid:
                result.append(UpVotable(ui_office(office), cand.number, cand.name, "candidatura"))
    return result


@dataclass
class StateVotes:
    slots: dict[tse.SectionKey, dict[int, list[int]]]
    up: dict[tse.SectionKey, dict[tuple[int, str], int]]
    turnout: dict[tse.SectionKey, dict[int, int]]


def read_state(cache: Path, uf: str, feeds: dict[int, tse.Feed], votables: list[UpVotable]) -> StateVotes:
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
        br_columns += office_columns(office, [f"{office}.up"])
    br_rows = []
    up_meta: dict[str, dict[str, list[dict]]] = {}
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
        votables = up_votables(state_feeds)
        state = read_state(cache, uf, state_feeds, votables) if offices else StateVotes({}, {}, {})
        places, secondary = read_places(cache, uf)
        areas = geo.load_areas(cache / f"geo_{uf}.json") if uf != EXTERIOR else {}
        labels = [ui_office(o) for o in offices]
        up_meta[uf] = {
            str(o): [{"n": v.number, "name": v.name, "kind": v.kind} for v in votables if v.office == o] for o in labels
        }

        columns = ["aptos", "comp", "abst", *president.columns()]
        for office in labels:
            columns += office_columns(
                office, [f"{office}.up", *(f"{office}.{v.number}" for v in votables if v.office == office)]
            )

        by_mun: dict[str, list[tse.SectionKey]] = defaultdict(list)
        for key in president.sections[uf]:
            by_mun[key[0]].append(key)

        mun_rows = []
        geo_properties = {}
        uf_totals = [0] * len(columns)
        for mun in sorted(by_mun, key=lambda m: president.sections[uf][by_mun[m][0]].municipality):
            _, ibge, _ = mapping.get(mun, (uf, "", ""))
            keys = sorted(by_mun[mun])
            name = president.sections[uf][keys[0]].municipality
            place_index: dict[tuple[int, int], int] = {}
            place_rows = []
            section_rows = []
            totals = [0] * len(columns)
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
                    section_up = state.up.get(key, {})
                    candidate_votes = [section_up.get((office, v.number), 0) for v in votables if v.office == office]
                    values += office_values(slots, [sum(candidate_votes), *candidate_votes])
                    office_turnout = state.turnout.get(key, {}).get(office)
                    checks.section_state(
                        uf, key, office, section.turnout, office_turnout, sum(slots), per_voter[office]
                    )
                section_rows.append([key[1], key[2], place_index[place_key], *values])
                totals = [a + b for a, b in zip(totals, values)]
            coverage["sections"] += len(keys)
            coverage["sections_not_installed"] += sum(1 for k in keys if not president.sections[uf][k].installed)
            coverage["places"] += len(place_rows)
            coverage["secondary"] += secondary.get(mun, 0)
            write_json(
                out / "mun" / f"{mun}.json",
                {
                    "tse": mun,
                    "ibge": ibge,
                    "name": name,
                    "uf": uf,
                    "cols": columns,
                    "secondary": secondary.get(mun, 0),
                    "places": place_rows,
                    "sections": section_rows,
                },
            )
            mapped = sum(1 for p in place_rows if p[7] in (PLACE_OK, PLACE_OK_UF_ONLY))
            mun_rows.append([mun, ibge, name, len(place_rows), len(keys), mapped, *totals])
            uf_totals = [a + b for a, b in zip(uf_totals, totals)]
            if ibge:
                geo_properties[ibge] = {"tse": mun, "name": name}

        uf_map = dict(zip(columns, uf_totals))
        checks.uf_feeds(uf, uf_feeds, uf_map, votables, len(president.sections[uf]))
        write_json(out / "uf" / f"{uf}.json", {"uf": uf, "cols": columns, "rows": mun_rows, "up": up_meta[uf]})
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
                "scope": "all" if code == PRESIDENT else "up",
                "votes_per_voter": per_voter.get(code, 1),
            }
            for code, name in OFFICE_NAMES.items()
        ],
        "president": [{"n": c.number, "name": c.name, "party": c.party} for c in president.candidates],
        "up": up_meta,
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

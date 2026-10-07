import gzip
import hashlib
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ELECTION_YEAR = 2026
ROUND = 1
FEDERAL_ELECTION = "6257"
STATE_ELECTION = "6259"
UP_NUMBER = "80"

UFS = [
    "AC",
    "AL",
    "AM",
    "AP",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MG",
    "MS",
    "MT",
    "PA",
    "PB",
    "PE",
    "PI",
    "PR",
    "RJ",
    "RN",
    "RO",
    "RR",
    "RS",
    "SC",
    "SE",
    "SP",
    "TO",
]
EXTERIOR = "ZZ"

ODSELE = "https://cdn.tse.jus.br/estatistica/sead/odsele"
RESULTS = "https://resultados.tse.jus.br/oficial"
IBGE_MESH = "https://servicodados.ibge.gov.br/api/v3/malhas"

PRESIDENT = 1
GOVERNOR = 3
SENATOR = 5
FEDERAL_DEPUTY = 6
STATE_DEPUTY = 7
DISTRICT_DEPUTY = 8
STATE_OFFICES = [GOVERNOR, SENATOR, FEDERAL_DEPUTY, STATE_DEPUTY]


@dataclass(frozen=True)
class Source:
    key: str
    url: str
    filename: str
    description: str


def sources() -> list[Source]:
    items = [
        Source(
            "votacao_br",
            f"{ODSELE}/votacao_secao/votacao_secao_{ELECTION_YEAR}_BR.zip",
            "votacao_secao_BR.zip",
            "TSE · votação por seção, Presidente",
        ),
        Source(
            "detalhe",
            f"{ODSELE}/detalhe_votacao_secao/detalhe_votacao_secao_{ELECTION_YEAR}.zip",
            "detalhe_votacao_secao.zip",
            "TSE · detalhe da apuração por seção (aptos, comparecimento, brancos, nulos)",
        ),
        Source(
            "locais",
            f"{ODSELE}/eleitorado_locais_votacao/eleitorado_local_votacao_{ELECTION_YEAR}.zip",
            "eleitorado_local_votacao.zip",
            "TSE · cadastro de locais de votação (endereço, bairro, coordenadas)",
        ),
        Source(
            "municipios_tse",
            f"{RESULTS}/ele{ELECTION_YEAR}/{FEDERAL_ELECTION}/config/mun-e00{FEDERAL_ELECTION}-cm.json",
            "mun-cm.json",
            "TSE · configuração municipal (código TSE x código IBGE)",
        ),
        Source(
            "feed_br",
            f"{RESULTS}/ele{ELECTION_YEAR}/{FEDERAL_ELECTION}/dados/br/br-c0001-e00{FEDERAL_ELECTION}-u.json",
            "feed_br_c0001.json",
            "TSE · totalização nacional, Presidente",
        ),
        Source(
            "geo_br",
            f"{IBGE_MESH}/paises/BR?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=UF",
            "geo_br.json",
            "IBGE · malha das UFs",
        ),
    ]
    for uf in UFS:
        lower = uf.lower()
        items.append(
            Source(
                f"votacao_{uf}",
                f"{ODSELE}/votacao_secao/votacao_secao_{ELECTION_YEAR}_{uf}.zip",
                f"votacao_secao_{uf}.zip",
                f"TSE · votação por seção, cargos estaduais e federais proporcionais, {uf}",
            )
        )
        items.append(
            Source(
                f"geo_{uf}",
                f"{IBGE_MESH}/estados/{uf}?formato=application/vnd.geo%2Bjson&qualidade=intermediaria&intrarregiao=municipio",
                f"geo_{uf}.json",
                f"IBGE · malha municipal, {uf}",
            )
        )
        items.append(
            Source(
                f"feed_{uf}_c{PRESIDENT}",
                f"{RESULTS}/ele{ELECTION_YEAR}/{FEDERAL_ELECTION}/dados/{lower}/{lower}-c0001-e00{FEDERAL_ELECTION}-u.json",
                f"feed_{uf}_c0001.json",
                f"TSE · totalização de Presidente em {uf}",
            )
        )
        for office in state_offices_for(uf):
            items.append(
                Source(
                    f"feed_{uf}_c{office}",
                    f"{RESULTS}/ele{ELECTION_YEAR}/{STATE_ELECTION}/dados/{lower}/{lower}-c{office:04d}-e00{STATE_ELECTION}-u.json",
                    f"feed_{uf}_c{office:04d}.json",
                    f"TSE · totalização do cargo {office} em {uf}",
                )
            )
    items.append(
        Source(
            f"feed_{EXTERIOR}_c{PRESIDENT}",
            f"{RESULTS}/ele{ELECTION_YEAR}/{FEDERAL_ELECTION}/dados/zz/zz-c0001-e00{FEDERAL_ELECTION}-u.json",
            f"feed_{EXTERIOR}_c0001.json",
            "TSE · totalização de Presidente no exterior",
        )
    )
    return items


def state_offices_for(uf: str) -> list[int]:
    return [GOVERNOR, SENATOR, FEDERAL_DEPUTY, DISTRICT_DEPUTY if uf == "DF" else STATE_DEPUTY]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, target: Path, attempts: int = 4) -> dict:
    partial = target.with_suffix(target.suffix + ".part")
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "atlas-eleitoral/0.1", "Accept-Encoding": "identity"}
            )
            with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
                headers = {"status": response.status, "last_modified": response.headers.get("Last-Modified")}
            if not target.name.endswith(".zip") and partial.read_bytes()[:2] == b"\x1f\x8b":
                partial.write_bytes(gzip.decompress(partial.read_bytes()))
            partial.rename(target)
            return headers
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == attempts:
                raise RuntimeError(f"falha ao baixar {url}: {error}") from error
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def fetch_all(cache: Path, refresh: bool = False) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    manifest_path = cache / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for source in sources():
        target = cache / source.filename
        if target.exists() and source.key in manifest and not refresh:
            continue
        print(f"baixando {source.url}", flush=True)
        headers = _download(source.url, target)
        manifest[source.key] = {
            "url": source.url,
            "file": source.filename,
            "description": source.description,
            "bytes": target.stat().st_size,
            "sha256": _sha256(target),
            "last_modified": headers["last_modified"],
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest

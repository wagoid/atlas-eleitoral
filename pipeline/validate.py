from collections import defaultdict

from pipeline.sources import PRESIDENT

EXAMPLES_PER_RULE = 5


class Checks:
    def __init__(self) -> None:
        self.records: list[dict] = []
        self.violations: dict[str, int] = defaultdict(int)
        self.examples: dict[str, list] = defaultdict(list)
        self.info: dict[str, int] = defaultdict(int)

    def compare(self, scope: str, field: str, expected: int, observed: int, source: str) -> None:
        self.records.append(
            {
                "scope": scope,
                "field": field,
                "expected": expected,
                "observed": observed,
                "diff": observed - expected,
                "ok": observed == expected,
                "source": source,
            }
        )

    def violation(self, rule: str, where) -> None:
        self.violations[rule] += 1
        if len(self.examples[rule]) < EXAMPLES_PER_RULE:
            self.examples[rule].append(where)

    def section_president(self, uf: str, key, section, values: list[int]) -> None:
        aptos, comp, abst, valid, blank, null, annulled, technical = values[:8]
        where = [uf, *key]
        if not section.installed:
            self.info["seções não instaladas (aptos sem comparecimento nem abstenção)"] += 1
        elif comp + abst != aptos:
            self.violation("comparecimento + abstenções = aptos", where)
        if valid + blank + null + annulled != comp:
            self.violation("Presidente: válidos + brancos + nulos + anulados = comparecimento", where)
        if (valid + technical + annulled, blank, null - technical) != section.detail:
            self.violation("Presidente: votação por seção = detalhe da apuração", where)

    def section_state(
        self, uf: str, key, office: int, comp: int, office_turnout: int | None, total: int, per_voter: int
    ) -> None:
        where = [uf, *key, office]
        if office_turnout is None:
            self.violation("cargo estadual: seção sem detalhe da apuração", where)
            return
        if office_turnout != comp:
            self.info["seções com comparecimento do cargo diferente de Presidente (voto em trânsito)"] += 1
        if total != office_turnout * per_voter:
            self.violation("cargo estadual: votos apurados = comparecimento do cargo x votos por eleitor", where)

    def uf_feeds(self, uf: str, feeds: dict, totals: dict[str, int], votables, sections: int) -> None:
        for office, feed in feeds.items():
            label = 7 if office == 8 else office
            source = f"feed {uf} cargo {office} ({feed.generated})"
            if office == PRESIDENT:
                self.compare(uf, "comparecimento", feed.turnout, totals["comp"], source)
                self.compare(uf, "abstenções", feed.abstentions, totals["abst"], source)
                self.compare(uf, "aptos", feed.electorate, totals["aptos"], source)
                self.compare(uf, "seções", feed.sections_totalized, sections, source)
                self.compare(uf, "1.nullt", feed.null_technical, totals["1.nullt"], source)
                for cand in feed.candidates:
                    if cand.valid and f"1.{cand.number}" in totals:
                        self.compare(uf, f"1.{cand.number}", cand.votes, totals[f"1.{cand.number}"], source)
            self.compare(uf, f"{label}.valid", feed.valid, totals[f"{label}.valid"], source)
            self.compare(uf, f"{label}.blank", feed.blank, totals[f"{label}.blank"], source)
            self.compare(uf, f"{label}.null", feed.null_total, totals[f"{label}.null"], source)
            self.compare(uf, f"{label}.annul", feed.annulled, totals[f"{label}.annul"], source)
            for votable in votables:
                if votable.office != label:
                    continue
                if votable.kind == "legenda":
                    expected = feed.party_votes.get(votable.number, 0)
                else:
                    expected = next(c.votes for c in feed.candidates if c.number == votable.number)
                self.compare(uf, f"{label}.{votable.number}", expected, totals[f"{label}.{votable.number}"], source)

    def geo_coverage(self, uf: str, with_data: dict[str, dict], areas: dict, known_missing: dict[str, str]) -> None:
        self.compare(
            uf, "municípios na malha IBGE sem resultado", 0, len(set(areas) - set(with_data)), "malha IBGE x TSE"
        )
        missing = set(with_data) - set(areas)
        for code in missing & set(known_missing):
            self.info[f"sem malha IBGE: {known_missing[code]}"] += 1
        self.compare(
            uf, "municípios com resultado fora da malha IBGE", 0, len(missing - set(known_missing)), "malha IBGE x TSE"
        )

    def national(self, feed, totals: dict[str, int], sections: int) -> None:
        source = f"feed BR cargo 1 ({feed.generated})"
        self.compare("BR", "comparecimento", feed.turnout, totals["comp"], source)
        self.compare("BR", "abstenções", feed.abstentions, totals["abst"], source)
        self.compare("BR", "aptos", feed.electorate, totals["aptos"], source)
        self.compare("BR", "seções", feed.sections_totalized, sections, source)
        self.compare("BR", "1.valid", feed.valid, totals["1.valid"], source)
        self.compare("BR", "1.blank", feed.blank, totals["1.blank"], source)
        self.compare("BR", "1.null", feed.null_total, totals["1.null"], source)
        self.compare("BR", "1.nullt", feed.null_technical, totals["1.nullt"], source)
        self.compare("BR", "1.annul", feed.annulled, totals["1.annul"], source)
        for cand in feed.candidates:
            if cand.valid and f"1.{cand.number}" in totals:
                self.compare("BR", f"1.{cand.number}", cand.votes, totals[f"1.{cand.number}"], source)

    def failures(self) -> list[dict]:
        return [r for r in self.records if not r["ok"]]

    def summary(self) -> dict:
        return {
            "comparisons": len(self.records),
            "failed": len(self.failures()),
            "invariant_violations": dict(self.violations),
            "info": dict(self.info),
        }

    def report(self) -> dict:
        return {"summary": self.summary(), "violation_examples": dict(self.examples), "comparisons": self.records}

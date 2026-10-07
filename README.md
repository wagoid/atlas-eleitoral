# Atlas eleitoral 2026

Atlas descritivo do 1º turno de 2026 para o Brasil inteiro, com filtro por estado e município. Segue o modelo
visual do atlas de Uberlândia (EDI) e troca o prompt de replicação por um pipeline determinístico:

- **Presidente:** Lula (13), Flávio Bolsonaro (22) e Samara (UP, 80); as demais candidaturas entram só nos
  votos válidos.
- **Governador, Senador, Deputado Federal e Deputado Estadual/Distrital:** somente a Unidade Popular
  (candidaturas válidas e legenda 80), com válidos, brancos, nulos e anulados como denominadores.
- Navegação Brasil > UF > município; no município, locais de votação e seções com calor, círculos, filtros,
  lista paginada e ficha por local, como na referência.

## Como funciona

```
pipeline/   Python (só biblioteca padrão): baixa, processa e valida
site/       página estática (HTML/CSS/JS + Leaflet), lê site/data/ sob demanda
qa/         teste de navegador (playwright-core + Chrome do sistema)
tests/      testes do pipeline
```

1. `fetch` baixa para `.cache/` (~3 GB) as bases do TSE (votação por seção, detalhe da apuração, locais de
   votação, totalizações oficiais por UF e cargo, configuração municipal) e as malhas do IBGE, registrando
   URL, data de publicação e SHA-256 em `.cache/manifest.json`.
2. `build` gera `site/data/` (~93 MB, ~30 MB com gzip, ~5,8 mil arquivos):
   `meta.json`, `br.json`, `uf/<UF>.json`, `mun/<código TSE>.json`, `geo/br.json` e `geo/<UF>.json`.
3. A validação roda no mesmo passo e **falha o build** se algo não fechar:
   - cada número votado é classificado pela totalização oficial (válido, branco, nulo de urna, nulo técnico,
     anulado sub judice);
   - quase mil comparações com as totalizações do TSE (nacional, cada UF, cada cargo, cada candidatura UP);
   - invariantes por seção (comparecimento + abstenções = aptos; votos apurados = comparecimento do cargo x
     votos por eleitor);
   - coordenadas de cada local testadas contra a malha do município no IBGE.
   O relatório completo vai para `site/data/reconciliation.json` e é linkado na página.

## Rodar localmente

```bash
uv run python -m pipeline all          # fetch + build + validação (~3 min depois do download)
uv run pytest -q
python3 -m http.server 8000 -d site    # abrir http://localhost:8000
```

Teste de navegador (usa o Chrome instalado; ajuste `CHROME_PATH` se preciso):

```bash
cd qa && npm install && npm run qa     # screenshots e resultado-testes.json em qa/out/
```

Para baixar de novo as bases (o TSE às vezes republica arquivos): `uv run python -m pipeline fetch --refresh`.

## Publicar no GitHub Pages

O site final cabe com folga nos limites do Pages (1 GB por site, 100 MB por arquivo; o maior arquivo é o de
São Paulo/SP, com 4 MB).

### Opção A: GitHub Actions gera e publica (recomendado)

1. Crie um repositório **público** no GitHub (o Pages gratuito exige repositório público) e suba esta pasta:
   ```bash
   git add -A && git commit -m "feat: atlas eleitoral nacional 2026"
   git remote add origin git@github.com:<org>/<repo>.git
   git push -u origin main
   ```
2. No repositório: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. O workflow `.github/workflows/pages.yml` roda a cada push em `main` (ou manualmente em
   **Actions > Publicar atlas no GitHub Pages > Run workflow**): baixa as bases, gera os dados, valida, roda os
   testes e publica `site/`. As bases ficam em cache entre execuções.
4. O endereço aparece no job `deploy` e em Settings > Pages: `https://<org>.github.io/<repo>/`.

### Opção B: gerar localmente e publicar o resultado

Se o runner do GitHub não conseguir baixar do TSE (bloqueio por região ou instabilidade do CDN):

1. Gere localmente: `uv run python -m pipeline all`.
2. Publique `site/` no branch `gh-pages`, sem acumular histórico: `./publicar-gh-pages.sh origin`.
3. Em **Settings > Pages**, escolha **Deploy from a branch**, branch `gh-pages`, pasta `/ (root)`.
4. Nesse modo, desative ou apague o workflow da opção A para os dois não concorrerem.

### Domínio próprio (opcional)

Em Settings > Pages > Custom domain, informe o domínio e crie no DNS um `CNAME` para `<org>.github.io`.

## Limites conhecidos

- Boa Esperança do Norte (MT), criado em 2024, ainda não tem polígono na API de malhas do IBGE; seus locais
  são conferidos só contra a malha da UF.
- 462 locais têm coordenada fora do próprio município e 764 não têm coordenada no cadastro do TSE: continuam na
  lista e nos totais, mas não são desenhados.
- Não há validação criptográfica das assinaturas dos boletins ou dos arquivos JWS.
- O fundo viário (Esri) depende de internet; dados e malhas são servidos pelo próprio site.

# nfse-nacional

Cliente Node.js/TypeScript para a **NFS-e Nacional** (Sefin Nacional / ADN — padrão obrigatório para o
Simples Nacional desde 01/11/2026): emissão de DPS, recuperação sem duplicar, consulta, cancelamento e
**DANFSe (PDF) local** no leiaute DANFSe v2.0. Assinatura XMLDSig e mTLS com certificado A1.

Extraído de um sistema em produção (emissão real em 11/2026). Pacote irmão:
[nfse-sp](https://github.com/marciotisouza/nfse-sp) (webservice da Prefeitura de São Paulo).

## Requisitos

- Node.js >= 18 (testado no 22)
- Certificado A1 (`.pfx`/`.p12`) do CNPJ do prestador
- Opcional: `puppeteer` para gerar o PDF do DANFSe localmente (`npm i puppeteer`)

## Instalação

```bash
npm install github:marciotisouza/nfse-nacional
```

## Uso

```ts
import { NfseNacionalClient } from 'nfse-nacional'

const nfse = new NfseNacionalClient({
  pfxBuf: Buffer.from(process.env.CERT_BASE64!, 'base64'),
  pfxSenha: process.env.CERT_SENHA!,
  cnpjPrestador: '00000000000000',
  codMunicipio: '3550308',   // IBGE do município do prestador
  ambiente: 2,               // 1 = produção, 2 = produção restrita
})

const r = await nfse.emitir({
  serie: '3',                // série exclusiva deste sistema
  nDps: 1001,                // único na série — grave ANTES de emitir
  competencia: '2026-11-05',
  tomador: { cnpj: '...', nome: '...', endereco: { codMunicipio, cep, logradouro, numero, bairro } },
  servico: { codTribNacional: '010101', codTribMunicipal: '001', codNbs: '115022000', descricao: '...' },
  valores: { valor: 100, totTrib: { municipal: 2.01 } },
})
// r: { sucesso, erros, idDps, chaveAcesso, numero, xml, recuperada, xmlDps }

const { pdf, oficial } = await nfse.danfse(r.chaveAcesso!, r.xml)   // ADN ou PDF local
await nfse.cancelar(r.chaveAcesso!, 1, 'Erro na emissao da nota fiscal de servico')
```

Exemplo completo: [`examples/emitir.ts`](examples/emitir.ts).

## API do cliente

| Método | O que faz | Endpoint da Sefin/ADN |
|---|---|---|
| `emitir(dados, { teste? })` | Monta, assina e envia a DPS; recupera a nota se já existir | `POST /nfse` (+ `GET /dps/{id}`, `GET /nfse/{chave}`) |
| `montarDps(dados)` | Só monta e assina (XML da DPS) | — |
| `consultar(chave)` | XML e número da NFS-e | `GET /nfse/{chave}` |
| `chavePorDps(serie, nDps)` | Chave da nota gerada por uma DPS | `GET /dps/{id}` |
| `cancelar(chave, motivo, justificativa)` | Evento e101101 | `POST /nfse/{chave}/eventos` |
| `consultarCancelamento(chave)` | XML do evento de cancelamento | `GET /nfse/{chave}/eventos/101101/1` |
| `danfse(chave, xml?, opcoes?)` | PDF: oficial do ADN ou gerado localmente | `GET {adn}/danfse/{chave}` |
| `idDps(serie, nDps)` | Id da DPS | — |
| `certificado({ diasAviso? })` | Dados e validade do A1, `cnpjConfere` | — |
| `distribuicaoDfe(ultimoNsu?, cnpj?)` | Até 50 NFS-e/eventos em que o CNPJ é parte (emitidas e recebidas) | `GET {adn}/contribuintes/DFe/{nsu}` |

Baixo nível (exportados): `montarXmlDps`, `montarXmlCancelamento`, `assinarXml`, `enviarDps`,
`consultarNfse`, `consultarChavePorDps`, `enviarEvento`, `consultarEvento`, `baixarDanfse`, `distribuicaoDfe`,
`gerarDanfseHtml`, `gerarDanfsePdf`, `extrairPemTls`, `extrairDadosCertificado`, `verificarCertificado`.

## Certificado (dados e validade)

```ts
const info = nfse.certificado({ diasAviso: 30 })
// { titular, cnpj, cpf, emissor, numeroSerie, validoDe, validoAte,
//   diasRestantes, expirado, vencendo, aindaNaoValido, cnpjConfere }
if (info.expirado || info.vencendo || !info.cnpjConfere) alertar(info)
```

Também como função solta: `verificarCertificado(pfxBuf, senha, { diasAviso })`. CNPJ/CPF são lidos do
subjectAltName ICP-Brasil (OIDs 2.16.76.1.3.x) ou do CN. Senha incorreta ou arquivo inválido lança erro.

## Impressão (DANFSe)

O ADN (`adn.nfse.gov.br/danfse`) fica fora do ar com frequência. `danfse()` tenta o oficial e, se não vier,
gera um PDF local reproduzindo o **DANFSe v2.0** (logo, QR Code de consulta pública
`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=...`, todas as seções), em uma página A4.

- `gerarDanfseHtml(xml)` — só o HTML (sem puppeteer; converta com o motor que quiser).
- `gerarDanfsePdf(xml, { browser?, executablePath? })` — PDF via puppeteer. Passe um `browser` aberto para
  gerar em lote sem relançar o Chromium. Em servidor Linux sem Chrome, o Chromium do puppeteer precisa
  de `libgbm1` e `libasound2`.
- Nome do município: API do IBGE (com cache); passe `nomeMunicipio` para usar outra fonte.

## Pontos importantes

- **Idempotência**: (série, nDPS) identifica a DPS. Grave o nDPS antes de enviar e reutilize-o em
  reenvios: a Sefin responde E0014 e `emitir` recupera a nota existente (`recuperada: true`).
  A Sefin às vezes demora mais de 60 s e gera a nota mesmo assim — por isso o timeout padrão é 40 s.
- **Série por emissor**: outro sistema emitindo para o mesmo CNPJ (ex.: contabilidade) precisa usar
  outra série. A Sefin **não** impede a mesma prestação em séries diferentes — controle a duplicidade.
- **Reemissão após cancelar** exige outro nDPS.
- **Leiaute NT-009**: a produção restrita já exige (`finNFSe`, `cNBS` antes de `xDescServ`); a produção
  (11/2026) ainda não. `leiauteNt009` padrão = true só no ambiente 2. Quando a produção migrar, a emissão
  falha com E1235 — ligue a opção.
- **mTLS**: chave/cert PEM extraídos com node-forge (o Node 22 recusa o .pfx legado em
  `https.Agent({ pfx })`); `rejectUnauthorized: false` porque a cadeia ICP-Brasil não está no Node.
- Textos são convertidos para Latin-1 (exigência do XSD) e truncados nos limites.
- Padrões da DPS = prestador do Simples ME/EPP (opSimpNac 3, regApTribSN 1), ISSQN tributável não
  retido, PIS/COFINS CST 00 zerado. Ajuste em `prestador` e `valores` se não for o seu caso.

## Erros comuns

| Código | Causa | Solução |
|---|---|---|
| E1229 | XML sem declaração UTF-8 | Já tratado (`gzipB64` acrescenta) |
| E1235 | Schema | Verificar `leiauteNt009` e os campos |
| E0014 | DPS já processada | `emitir` recupera automaticamente |
| `Unsupported PKCS12 PFX data` | Node 22 + `.pfx` legado | Já tratado (`extrairPemTls`) |

## Licença

MIT

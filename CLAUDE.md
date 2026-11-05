# nfse-nacional — Contexto do projeto para Claude

## O que é

Pacote npm open-source com a camada de comunicação com a **NFS-e Nacional** (Sefin Nacional + ADN).
Extraído do sistema de origem (tickets v2, privado — `server/src/modules/nfse_nacional/`), em produção
desde 04/11/2026. A camada de aplicação (banco, rotas, numeração do nDPS, gravação de arquivos) fica no
sistema que usa o pacote.

Documentação completa do protocolo: `docs/nfse_nacional.md` no sistema de origem; o essencial está no README.
Pacote irmão (Prefeitura SP): https://github.com/marciotisouza/nfse-sp

## Autor

Marcio de Souza — marcio.ti.souza@gmail.com

## Stack

TypeScript, ESM, Node >= 18. `axios` (HTTP mTLS), `node-forge` (PFX → PEM), `xml-crypto` v6 (XMLDSig),
`fast-xml-parser` + `qrcode` (DANFSe). `puppeteer` é peer dependency opcional (só para o PDF local).

## Estrutura

```
src/
  certificate.ts — extrairDadosCertificado (assinatura), extrairPemTls (mTLS), verificarCertificado (dados/validade)
  api.ts         — chamadas HTTP: enviarDps, consultarNfse, consultarChavePorDps, enviarEvento, consultarEvento, baixarDanfse
  dps.ts         — montarXmlDps, montarIdDps, montarXmlCancelamento, assinarXml
  danfse.ts      — gerarDanfseHtml, gerarDanfsePdf (DANFSe v2.0)
  logo.ts        — logo NFS-e (PNG base64) do cabeçalho do DANFSe
  client.ts      — NfseNacionalClient (alto nível, com recuperação por DPS)
  index.ts       — exports públicos
examples/emitir.ts
```

## Decisões que não podem regredir

- Declaração `<?xml version="1.0" encoding="UTF-8"?>` antes do gzip (senão E1229).
- Assinatura RSA-SHA1 + C14N enveloped, referência ao Id de `infDPS`/`infPedReg`, Signature logo após.
- `dhEmi`/`dhEvento` = agora − 60 s (a Sefin rejeita horário à frente do dela).
- Recuperação: sem chave/XML na resposta → `GET /dps/{id}` → `GET /nfse/{chave}`.
- Ordem do XML conforme o leiaute ativo (`leiauteNt009`).
- mTLS com key/cert PEM (Node 22 recusa o .pfx legado).
- Validado em 05/11/2026: a DPS gerada com os dados de uma nota real emitida por outro sistema é idêntica à aceita
  pela Sefin (exceto dhEmi/verAplic).

## Build

`npm run build` (tsc → dist/). Não há testes automatizados.

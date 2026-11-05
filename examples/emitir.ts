/**
 * Exemplo: emitir, imprimir e cancelar uma NFS-e Nacional.
 *
 *   CERT_BASE64=... CERT_SENHA=... CNPJ=... npx tsx examples/emitir.ts
 *
 * Use ambiente 2 (produção restrita) para testar. Para o PDF local: npm i puppeteer.
 */
import fs from 'fs'
import { NfseNacionalClient, hojeBrasilia } from '../src/index.js'

const nfse = new NfseNacionalClient({
  pfxBuf: Buffer.from(process.env.CERT_BASE64!, 'base64'),
  pfxSenha: process.env.CERT_SENHA!,
  cnpjPrestador: process.env.CNPJ!,
  codMunicipio: '3550308', // São Paulo
  ambiente: 2,
  verAplic: 'meu-sistema',
})

// Série exclusiva deste sistema; nDPS único na série — grave-o ANTES de emitir e reuse em reenvios.
const serie = '3'
const nDps = 1001

const r = await nfse.emitir({
  serie,
  nDps,
  competencia: hojeBrasilia(),
  tomador: {
    cnpj: '11222333000181',
    nome: 'CLIENTE EXEMPLO LTDA',
    endereco: { codMunicipio: '3550308', cep: '01001000', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' },
    fone: '11999999999',
  },
  servico: {
    codTribNacional: '010101',
    codTribMunicipal: '001',
    codNbs: '115022000',
    descricao: 'Manutenção mensal de sistema.\nValor líquido da Nota Fiscal = R$ 100,00',
  },
  valores: { valor: 100, totTrib: { municipal: 2.01 } },
})

if (!r.sucesso) {
  console.error('Falhou:', r.erros)
  process.exit(1)
}
console.log(`NFS-e nº ${r.numero} — chave ${r.chaveAcesso}${r.recuperada ? ' (recuperada)' : ''}`)
fs.writeFileSync(`nfse_${r.numero}.xml`, r.xml!)

const { pdf, oficial } = await nfse.danfse(r.chaveAcesso!, r.xml)
fs.writeFileSync(`nfse_${r.numero}.pdf`, pdf)
console.log(`DANFSe ${oficial ? 'oficial (ADN)' : 'gerado localmente'}`)

// Cancelamento (reemissão depois exige outro nDPS):
// const c = await nfse.cancelar(r.chaveAcesso!, 1, 'Erro na emissao da nota fiscal de servico')

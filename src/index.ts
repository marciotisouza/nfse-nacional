// API principal — classe de alto nível
export { NfseNacionalClient } from './client.js'
export type { NfseNacionalConfig, DadosEmissao, RetornoEmissao } from './client.js'

// Montagem e assinatura dos XMLs
export {
  montarXmlDps,
  montarIdDps,
  montarXmlCancelamento,
  assinarXml,
  extrairNumeroNfse,
  dataHoraBrasilia,
  hojeBrasilia,
  latin1,
} from './dps.js'
export type { DadosDps, Endereco, MotivoCancelamento, TotTrib, IbsCbs } from './dps.js'

// Chamadas HTTP (baixo nível)
export {
  URLS,
  enviarDps,
  consultarNfse,
  consultarChavePorDps,
  enviarEvento,
  consultarEvento,
  baixarDanfse,
  distribuicaoDfe,
  gzipB64,
  gunzipB64,
  extrairErros,
} from './api.js'
export type { Ambiente, ConexaoNacional, ErroNacional, RetornoNacional, DocumentoDfe, RetornoDistribuicao } from './api.js'

// Impressão (DANFSe)
export { gerarDanfseHtml, gerarDanfsePdf } from './danfse.js'
export type { OpcoesDanfse, OpcoesPdf } from './danfse.js'

// Certificado
export { extrairDadosCertificado, extrairPemTls, verificarCertificado } from './certificate.js'
export type { CertificateData, InfoCertificado } from './certificate.js'
